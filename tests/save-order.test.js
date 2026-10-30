/**
 * A page's saves are written in the order it numbered them (#103,
 * server/utils/save-order.js), over HTTP through the real createServer() app.
 *
 * The dashboard sends `saveOrder: {client, number}` with every save. Inside
 * the file's write queue the store skips a save older than one the same page
 * already had written there (`superseded: true`, nothing written); a save from
 * another page, or with no or a malformed `saveOrder`, is written as it
 * arrives. The same number again is a repeat: answered as written (validated),
 * not written twice; a superseded save is not validated. A failed write records
 * nothing, so its retry is written. A file()
 * collection orders each entry on its own. Ten numbered saves sent at once,
 * in shuffled order, leave the highest number on disk. A read of an entry
 * waits for a save of it that is still arriving (trackEntrySaves).
 *
 *   bun tests/save-order.test.js     (<1 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-save-order-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'editor';
process.env.ADMIN_PASSWORD = 'save-order-password';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob, file } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
  people: defineCollection({ loader: file('src/data/people.json'), schema: z.object({ id: z.string(), name: z.string() }) }),
};
`);
for (const slug of ['ordered', 'clients', 'malformed', 'failed', 'burst', 'reading', 'idle']) writeProjectFile(`src/content/pages/${slug}.md`, '---\ntitle: Start\n---\nBody.\n');
writeProjectFile('src/data/people.json', JSON.stringify([{ id: 'ada', name: 'Ada' }, { id: 'bo', name: 'Bo' }], null, 2) + '\n');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'editor', password: 'save-order-password' }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];

const CLIENT_A = 'page-a-1b2c3d4e';
const CLIENT_B = 'page-b-5f6a7b8c';
const pageText = (slug) => fs.readFileSync(path.join(projectRoot, `src/content/pages/${slug}.md`), 'utf8');
const people = () => JSON.parse(fs.readFileSync(path.join(projectRoot, 'src/data/people.json'), 'utf8'));

async function save(collection, slug, data, saveOrder) {
  const payload = { data, type: collection === 'people' ? 'data' : 'content' };
  if (collection !== 'people') payload.body = 'Body.\n';
  if (saveOrder !== undefined) payload.saveOrder = saveOrder;
  const response = await fetch(`${base}/api/content/${collection}/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

console.log('\n🧪 a page\'s saves land in its order\n' + '='.repeat(40));

try {
  await check('a save older than one the page already had written is acknowledged and not written', async () => {
    const newer = await save('pages', 'ordered', { title: 'Second' }, { client: CLIENT_A, number: 2 });
    assert.equal(newer.status, 200);
    assert.equal(newer.body.superseded, false);
    const older = await save('pages', 'ordered', { title: 'First' }, { client: CLIENT_A, number: 1 });
    assert.equal(older.status, 200);
    assert.equal(older.body.success, true);
    assert.equal(older.body.superseded, true);
    assert.match(pageText('ordered'), /title: Second/);
    // The same number again is a repeat (a re-sent request): answered as
    // written, with its validation, and not written twice.
    const repeat = await save('pages', 'ordered', { title: 'Again' }, { client: CLIENT_A, number: 2 });
    assert.equal(repeat.body.superseded, false);
    assert.equal(repeat.body.validation.status, 'valid');
    assert.match(pageText('ordered'), /title: Second/);
    assert.equal(older.body.validation, null, 'a superseded save is not validated');
    assert.equal((await save('pages', 'ordered', { title: 'Third' }, { client: CLIENT_A, number: 3 })).body.superseded, false);
    assert.match(pageText('ordered'), /title: Third/);
  });

  await check('another page\'s save, and a save with no saveOrder, are written as they arrive', async () => {
    await save('pages', 'clients', { title: 'A five' }, { client: CLIENT_A, number: 5 });
    const other = await save('pages', 'clients', { title: 'B one' }, { client: CLIENT_B, number: 1 });
    assert.equal(other.body.superseded, false);
    assert.match(pageText('clients'), /title: B one/);
    const plain = await save('pages', 'clients', { title: 'Plain' });
    assert.equal(plain.body.superseded, false);
    assert.match(pageText('clients'), /title: Plain/);
  });

  await check('a malformed saveOrder is ignored, so the save is written', async () => {
    await save('pages', 'malformed', { title: 'Ten' }, { client: CLIENT_A, number: 10 });
    const shapes = ['x', 7, null, [], { client: CLIENT_A }, { client: CLIENT_A, number: -1 }, { client: CLIENT_A, number: 1.5 },
      { client: 'short', number: 1 }, { client: 'bad client id!', number: 1 }, { client: CLIENT_A, number: '1' }];
    for (const [index, saveOrder] of shapes.entries()) {
      const result = await save('pages', 'malformed', { title: `Shape ${index}` }, saveOrder);
      assert.equal(result.status, 200, JSON.stringify(saveOrder));
      assert.equal(result.body.superseded, false, JSON.stringify(saveOrder));
      assert.match(pageText('malformed'), new RegExp(`title: Shape ${index}`), JSON.stringify(saveOrder));
    }
  });

  await check('a failed write records nothing: the same save, retried, is written', async () => {
    const folder = path.join(projectRoot, 'src/content/pages');
    fs.chmodSync(folder, 0o555);
    let failed;
    try {
      failed = await save('pages', 'failed', { title: 'Retried' }, { client: CLIENT_A, number: 4 });
    } finally {
      fs.chmodSync(folder, 0o755);
    }
    assert.equal(failed.status, 500, 'the write was refused (positive control)');
    assert.match(pageText('failed'), /title: Start/);
    const retried = await save('pages', 'failed', { title: 'Retried' }, { client: CLIENT_A, number: 4 });
    assert.equal(retried.body.superseded, false);
    assert.match(pageText('failed'), /title: Retried/);
  });

  await check('a file() collection orders each entry on its own', async () => {
    assert.equal((await save('people', 'ada', { id: 'ada', name: 'Ada 5' }, { client: CLIENT_A, number: 5 })).body.superseded, false);
    assert.equal((await save('people', 'bo', { id: 'bo', name: 'Bo 3' }, { client: CLIENT_A, number: 3 })).body.superseded, false);
    assert.equal((await save('people', 'ada', { id: 'ada', name: 'Ada 4' }, { client: CLIENT_A, number: 4 })).body.superseded, true);
    assert.deepEqual(people(), [{ id: 'ada', name: 'Ada 5' }, { id: 'bo', name: 'Bo 3' }]);
  });

  await check('ten numbered saves sent at once, shuffled, leave the highest number on disk', async () => {
    const numbers = [7, 2, 10, 4, 1, 9, 3, 8, 6, 5];
    const results = await Promise.all(numbers.map((number) => save('pages', 'burst', { title: `Save ${number}` }, { client: CLIENT_B, number })));
    assert.ok(results.every((result) => result.status === 200));
    assert.match(pageText('burst'), /title: Save 10\n/);
  });
  await check('a read of an entry waits for a save of it still arriving (a reload after a leave save)', async () => {
    const encoder = new TextEncoder();
    const payload = JSON.stringify({ data: { title: 'Arrived' }, body: 'Body.\n', type: 'content', saveOrder: { client: CLIENT_A, number: 1 } });
    let sendRest;
    const rest = new Promise((resolve) => { sendRest = resolve; });
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, 20)));
        await rest;
        controller.enqueue(encoder.encode(payload.slice(20)));
        controller.close();
      },
    });
    const saving = fetch(`${base}/api/content/pages/reading`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, 'Content-Length': String(Buffer.byteLength(payload)) },
      body: stream,
      duplex: 'half',
    });
    let readSettled = false;
    let reading;
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      reading = fetch(`${base}/api/content/pages/reading`, { headers: { cookie } })
        .then((response) => response.json())
        .finally(() => { readSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(readSettled, false, 'the read answered while the save was still arriving');
    } finally {
      sendRest(); // never leave the save half sent: server.close() would wait for it
    }
    assert.equal((await saving).status, 200);
    const read = await reading;
    assert.equal(read.data.title, 'Arrived');
    // Control: with no save in progress a read answers at once.
    const started = Date.now();
    assert.equal((await (await fetch(`${base}/api/content/pages/idle`, { headers: { cookie } })).json()).data.title, 'Start');
    assert.ok(Date.now() - started < 1000);
  });
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
