/**
 * A markdown entry's body survives a save, whatever its schema declares.
 *
 * The editor used to hide the body textarea whenever the collection schema had
 * a `blocks` property, while the saver sent `#markdown-body`'s value or '' — so
 * saving a page with blocks AND a body (editing only its title) wrote an empty
 * body and deleted the prose. Two layers now prevent that:
 *
 *   1. The editor always shows the body for a markdown entry, and the save
 *      payload carries `body` only when the editor showed one
 *      (`ui/save-payload.js`).
 *   2. The API keeps the stored body when a save has NO `body` key; an explicit
 *      `body: ''` still clears it (`server/api/content.js`).
 *
 *   bun tests/save-body.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { readJson } from '../ui/api-response.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-save-body-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
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
import { glob } from 'astro/loaders';
const hero = z.object({ type: z.literal('hero'), heading: z.string() });
export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: z.object({ title: z.string(), blocks: z.array(hero).default([]) }),
  }),
};
`);
const BODY = '\nThe prose under the blocks.\n\nA second paragraph.\n';
const PAGE = `---\ntitle: About\nblocks:\n  - type: hero\n    heading: Hello\n---\n${BODY}`;
const pagePath = path.join(projectRoot, 'src/content/pages/about.md');
writeProjectFile('src/content/pages/about.md', PAGE);

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

const matter = (await import('gray-matter')).default;
const storedBody = () => matter(fs.readFileSync(pagePath, 'utf8')).content;
const storedTitle = () => matter(fs.readFileSync(pagePath, 'utf8')).data.title;

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const loginResponse = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
assert.equal(loginResponse.status, 200, 'login');
const cookie = loginResponse.headers.get('set-cookie').split(';')[0];

const save = (method, payload) => fetch(`${base}/api/content/pages/about`, {
  method,
  headers: { cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const DATA = (title) => ({ title, blocks: [{ type: 'hero', heading: 'Hello' }] });

for (const method of ['POST', 'PUT']) {
  await check(`API ${method}: a save with no body key keeps the stored body`, async () => {
    fs.writeFileSync(pagePath, PAGE);
    const response = await save(method, { data: DATA(`Edited by ${method}`), type: 'content' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(storedTitle(), `Edited by ${method}`, 'positive control: the title was saved');
    assert.equal(storedBody(), BODY);
  });

  await check(`API ${method}: an explicit empty body still clears it`, async () => {
    fs.writeFileSync(pagePath, PAGE);
    const response = await save(method, { data: DATA('Cleared'), body: '', type: 'content' });
    assert.equal(response.status, 200);
    assert.equal(storedTitle(), 'Cleared');
    assert.equal(storedBody().trim(), '');
  });

  await check(`API ${method}: a sent body replaces it`, async () => {
    fs.writeFileSync(pagePath, PAGE);
    const response = await save(method, { data: DATA('Replaced'), body: 'New prose.\n', type: 'content' });
    assert.equal(response.status, 200);
    assert.equal(storedBody().trim(), 'New prose.');
  });
}

await check('API POST: a new entry with no body key is created with an empty body', async () => {
  const response = await fetch(`${base}/api/content/pages/fresh`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: DATA('Fresh'), type: 'content' }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const fresh = matter(fs.readFileSync(path.join(projectRoot, 'src/content/pages/fresh.md'), 'utf8'));
  assert.equal(fresh.data.title, 'Fresh');
  assert.equal(fresh.content.trim(), '');
});

// A save with no body must never put back a body it read before a concurrent
// save replaced it. The stored body used to be read in the route, outside the
// file's write queue, so the no-body save could read the old body, queue
// behind a save that wrote a new one, and then restore the old one.
const NEW_BODY = 'The body a concurrent save wrote.\n';

await check('API: a no-body save racing a body save never restores the old body', async () => {
  const attempts = 20;
  const lost = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    fs.writeFileSync(pagePath, PAGE);
    // The no-body save is sent first, so it reads (or would read) the old body first.
    const [omitted, sent] = await Promise.all([
      save('POST', { data: DATA(`No body ${attempt}`), type: 'content' }),
      save('POST', { data: DATA(`With body ${attempt}`), body: NEW_BODY, type: 'content' }),
    ]);
    assert.equal(omitted.status, 200, await omitted.clone().text());
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.match(storedTitle(), new RegExp(` ${attempt}$`), 'positive control: this attempt saved');
    if (storedBody() !== NEW_BODY) lost.push(attempt);
  }
  assert.deepEqual(lost, [], `the new body was overwritten with the old one in ${lost.length} of ${attempts} attempts`);
});

const { writeContent: storeWrite } = await import('../server/utils/content.js');

await check('store: keepStoredBody is resolved inside the write queue, in either order', async () => {
  for (const order of ['omitted first', 'body first']) {
    fs.writeFileSync(pagePath, PAGE);
    const omitted = () => storeWrite('pages', 'about', { data: DATA('No body'), keepStoredBody: true, type: 'content' });
    const sent = () => storeWrite('pages', 'about', { data: DATA('With body'), body: NEW_BODY, type: 'content' });
    await Promise.all(order === 'omitted first' ? [omitted(), sent()] : [sent(), omitted()]);
    assert.equal(storedBody(), NEW_BODY, order);
  }
  fs.writeFileSync(pagePath, PAGE);
  await storeWrite('pages', 'about', { data: DATA('Kept'), keepStoredBody: true, type: 'content' });
  assert.equal(storedTitle(), 'Kept', 'positive control: the save landed');
  assert.equal(storedBody(), BODY, 'alone, it keeps the stored body');
});

server.close();

// --- The editor side (happy-dom) ---

const window = new Window({ url: 'http://localhost/' });
const document = window.document;
const dashboardSrc = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
const escapeSrc = fs.readFileSync(path.join(repoRoot, 'ui/escape-html.js'), 'utf8').replace('export function', 'function');
const BLOCKS_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    blocks: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' } } } },
  },
};

// The real renderEditor / renderEditorForNewEntry, extracted from the source
// with the loaders they call stubbed (as tests/ui-escaping.test.js does).
function extract(signature, params, args) {
  const fnSrc = dashboardSrc.match(new RegExp(`${signature.replace(/[()]/g, '\\$&')} \\{[\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(fnSrc, `${signature} not found`);
  const name = signature.match(/function (\w+)/)[1];
  return new Function(...params, `${escapeSrc}\n${fnSrc}\nreturn ${name};`)(...args);
}

await check('editor: a markdown entry whose schema has blocks shows its body', async () => {
  const schemaResponse = () => new Response(JSON.stringify({ collection: { schema: BLOCKS_SCHEMA } }), { headers: { 'Content-Type': 'application/json' } });
  const render = extract('async function renderEditor(entryData, ctx)',
    ['document', 'fetch', 'collectionApiPath', 'generateForm', 'installSaver', 'showEntryProblems',
      'collapseAllBlocks', 'setupBlockFocus', 'loadSeq', 'bindOriginalValues', 'readJson'],
    [document, async () => schemaResponse(), (name) => `/api/collections/${name}`, () => '<input name="title">',
      () => {}, () => {}, () => {}, () => {}, 1, () => {}, readJson]);
  document.body.innerHTML = '<div id="editorForm"></div>';
  await render({ type: 'content', data: { title: 'About' }, body: BODY }, { collection: 'pages', slug: 'about', locale: null, myLoad: 1 });
  const textarea = document.getElementById('markdown-body');
  assert.ok(textarea, 'the body editor is not rendered for a schema with blocks');
  assert.equal(textarea.value, BODY);
});

await check('editor: a new markdown entry whose schema has blocks has a body editor', () => {
  const render = extract('function renderEditorForNewEntry(schema, contentType, ctx)',
    ['document', 'generateForm', 'installSaver', 'setupFormHandlers', 'collapseAllBlocks', 'setupBlockFocus',
      'showEntryProblems', 'setupFieldWidgets'],
    [document, () => '<input name="title">', () => {}, () => {}, () => {}, () => {}, () => {}, () => {}]);
  document.body.innerHTML = '<div id="editorForm"></div>';
  render(BLOCKS_SCHEMA, 'content', { collection: 'pages', slug: 'new', locale: null });
  assert.ok(document.getElementById('markdown-body'), 'no body editor for a new entry with blocks');
});

const { savePayload } = await import('../ui/save-payload.js');

await check('save payload: carries the body the editor shows, even when empty', () => {
  document.body.innerHTML = '<form><textarea id="markdown-body"></textarea></form>';
  const form = document.querySelector('form');
  form.querySelector('#markdown-body').value = 'Prose.';
  assert.deepEqual(savePayload(form, { title: 'T' }, 'content'), { data: { title: 'T' }, body: 'Prose.', type: 'content' });
  form.querySelector('#markdown-body').value = '';
  assert.deepEqual(savePayload(form, { title: 'T' }, 'content'), { data: { title: 'T' }, body: '', type: 'content' });
});

await check('save payload: no body key when the editor showed no body', () => {
  document.body.innerHTML = '<form><input name="title"></form>';
  const payload = savePayload(document.querySelector('form'), { title: 'T' }, 'data');
  assert.deepEqual(payload, { data: { title: 'T' }, type: 'data' });
  assert.ok(!('body' in payload));
});

await check('dashboard: the saver builds its request with savePayload', () => {
  const saverSrc = dashboardSrc.match(/function makeSaver\(target\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(saverSrc, 'makeSaver not found');
  assert.ok(/const payload = savePayload\(target\.form, formData, target\.type\)/.test(saverSrc)
    && /JSON\.stringify\(payload\)/.test(saverSrc), 'makeSaver does not send savePayload(...)');
  assert.ok(!/#markdown-body'\)\?\.value \|\| ''/.test(saverSrc), "makeSaver still defaults a missing body to ''");
});

fs.rmSync(projectRoot, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} passed${process.exitCode ? ', some FAILED' : ''}\n`);
