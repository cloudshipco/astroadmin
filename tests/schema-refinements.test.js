/**
 * A save is checked against the site's REAL schema: refinements included.
 *
 * The JSON Schema the editor renders from keeps only a refined field's type,
 * length and description (`.refine()` is not representable), so validating
 * against it would pass a Vimeo link in a field the site refines to YouTube
 * only, and the editor would hear nothing until a build failed. The save
 * response's `validation` comes from the site's own zod schema, bundled with
 * the site's own imports, so a refinement's own message reaches the field it
 * names. This pins that, through the real createServer() app, for a site whose
 * `zod` is zod 4 and one whose `zod` is zod 3 (one child process each: the
 * server reads its project root once).
 *
 * Seen red (2026-10-17) by validating against the serialised JSON Schema
 * instead of `_zodSchema` in content-validation.js: every refinement check
 * failed, and the controls held.
 *
 * Also: no content response carries a server path (the store's `filePath`,
 * and `deleted` on a delete, used to be spread into GET, POST, PUT and DELETE).
 *
 *   bun tests/schema-refinements.test.js
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const childZod = process.argv[2] === '--zod' ? Number(process.argv[3]) : null;

if (childZod === null) {
  let failed = 0;
  for (const zodVersion of [4, 3]) {
    const result = spawnSync(process.execPath, [import.meta.path, '--zod', String(zodVersion)], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) failed++;
  }
  console.log(failed === 0 ? '\n📊 zod 4 and zod 3 passed.' : `\n📊 ${failed} of 2 zod versions FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aa-refine-zod${childZod}-`)));
// Removed however the child ends, a failed assertion or a throw included.
process.on('exit', () => fs.rmSync(projectRoot, { recursive: true, force: true }));
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

// Only zod in the site's node_modules: the parser resolves the site's own.
const realZod = path.join(repoRoot, 'node_modules', 'zod');
fs.mkdirSync(path.join(projectRoot, 'node_modules'));
if (childZod === 3) {
  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'zod'));
  writeProjectFile('node_modules/zod/package.json', JSON.stringify({ name: 'zod', version: '3.25.0', type: 'module', main: 'index.js' }));
  writeProjectFile('node_modules/zod/index.js', `export * from ${JSON.stringify(path.join(realZod, 'v3', 'index.js'))};\n`);
} else {
  fs.symlinkSync(realZod, path.join(projectRoot, 'node_modules', 'zod'), 'dir');
}

writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
// The refinement's rule lives in a module of the site's own, as on a real site.
writeProjectFile('src/lib/video.ts', `export const VIDEO_MESSAGE = 'Paste a YouTube link, e.g. https://www.youtube.com/watch?v=…';
export function youtubeId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname !== 'www.youtube.com' && url.hostname !== 'youtube.com') return null;
    return url.searchParams.get('v');
  } catch {
    return null;
  }
}
`);
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { VIDEO_MESSAGE, youtubeId } from './lib/video';

const text = z.string().trim().min(1);
const LINK_MESSAGE = 'Link must start with /, #, mailto:, http:// or https://';
const href = text.refine((value) => /^(\\/(?!\\/)|#|mailto:|https?:\\/\\/)/i.test(value), { message: LINK_MESSAGE });

const video = z.object({
  type: z.literal('video'),
  url: text.refine((value) => youtubeId(value) !== null, { message: VIDEO_MESSAGE }),
  title: text,
});
const cards = z.object({
  type: z.literal('cards'),
  items: z.array(z.object({ title: text, href })).min(1),
});
// zod 3 takes only plain objects as union options, so the cross-field rule
// sits on an object inside the block.
const dates = z.object({
  type: z.literal('dates'),
  range: z.object({ start: z.number(), end: z.number() }).superRefine((value, ctx) => {
    if (value.end < value.start) ctx.addIssue({ code: 'custom', path: ['end'], message: 'The end must not be before the start' });
  }),
});

export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: z.object({
      title: text,
      slugline: z.string().transform((value) => value.toUpperCase()).optional(),
      blocks: z.array(z.discriminatedUnion('type', [video, cards, dates])).default([]),
    }),
  }),
  plain: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/plain' }),
    schema: z.object({ title: z.string() }),
  }),
};
`);
const pagePath = path.join(projectRoot, 'src/content/pages/home.md');
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\n---\n');
writeProjectFile('src/content/plain/note.md', '---\ntitle: Note\n---\nBody.\n');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ [zod ${childZod}] ${name}`);
  } catch (error) {
    console.error(`❌ [zod ${childZod}] ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

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

const request = (method, entryPath, payload) => fetch(`${base}/api/content/${entryPath}`, {
  method,
  headers: { cookie, 'Content-Type': 'application/json' },
  ...(payload ? { body: JSON.stringify(payload) } : {}),
});

/** Save the home page with these blocks; the response, after asserting the write. */
async function saveBlocks(blocks, extra = {}) {
  const title = `Home ${Math.random()}`;
  const response = await request('PUT', 'pages/home', { data: { title, blocks, ...extra }, type: 'content' });
  assert.equal(response.status, 200, await response.clone().text());
  // Positive control: the save WROTE, invalid or not.
  assert.ok(fs.readFileSync(pagePath, 'utf8').includes(title), 'the save reached disk');
  return response.json();
}

const VALID_VIDEO = { type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'A film' };

await check('control: a valid save with refined fields is valid', async () => {
  const saved = await saveBlocks([
    VALID_VIDEO,
    { type: 'cards', items: [{ title: 'More', href: '/more' }] },
    { type: 'dates', range: { start: 1, end: 2 } },
  ], { slugline: 'kept as typed' });
  assert.deepEqual(saved.validation, { status: 'valid', issues: [] });
});

await check("a Vimeo link in a video block gets the site's own message, on that block's url", async () => {
  const saved = await saveBlocks([VALID_VIDEO, { ...VALID_VIDEO, url: 'https://vimeo.com/76979871' }]);
  assert.deepEqual(saved.validation, {
    status: 'invalid',
    issues: [{ path: 'blocks[1].url', message: 'Paste a YouTube link, e.g. https://www.youtube.com/watch?v=…' }],
  });
});

await check('a refinement on an item inside a block lands on that item', async () => {
  const saved = await saveBlocks([{ type: 'cards', items: [{ title: 'Ok', href: '/ok' }, { title: 'Bad', href: 'javascript:alert(1)' }] }]);
  assert.deepEqual(saved.validation.issues, [
    { path: 'blocks[0].items[1].href', message: 'Link must start with /, #, mailto:, http:// or https://' },
  ]);
});

await check("a cross-field superRefine lands on the path it names", async () => {
  const saved = await saveBlocks([{ type: 'dates', range: { start: 5, end: 2 } }]);
  assert.deepEqual(saved.validation.issues, [{ path: 'blocks[0].range.end', message: 'The end must not be before the start' }]);
});

await check('a stored entry opened later reports the same issue (GET)', async () => {
  await saveBlocks([{ ...VALID_VIDEO, url: 'https://vimeo.com/1' }]);
  const opened = await (await request('GET', 'pages/home')).json();
  assert.deepEqual(opened.validation, {
    status: 'invalid',
    issues: [{ path: 'blocks[0].url', message: 'Paste a YouTube link, e.g. https://www.youtube.com/watch?v=…' }],
  });
});

await check('a refinement-free collection saves and validates as before', async () => {
  const response = await request('PUT', 'plain/note', { data: { title: 'Edited' }, body: 'Body.\n', type: 'content' });
  const saved = await response.json();
  assert.deepEqual(saved.validation, { status: 'valid', issues: [] });
  assert.equal(fs.readFileSync(path.join(projectRoot, 'src/content/plain/note.md'), 'utf8'), '---\ntitle: Edited\n---\nBody.\n');
});

// --- No server path in a content response -----------------------------------
// The project root and the temp directory it sits in, as written and as
// resolved (macOS's /var is /private/var).
const serverPaths = [...new Set([projectRoot, os.tmpdir(), fs.realpathSync(os.tmpdir())])];
function assertNoServerPath(label, text) {
  for (const serverPath of serverPaths) {
    assert.ok(!text.includes(serverPath), `${label} names a server path (${serverPath}): ${text}`);
  }
  // The response's own keys: content may hold a key of any name.
  const keys = Object.keys(JSON.parse(text));
  assert.ok(!keys.includes('filePath') && !keys.includes('deleted'), `${label} carries a file path field: ${keys.join(', ')}`);
}

await check('GET: the entry carries no server path', async () => {
  const opened = await request('GET', 'pages/home');
  const openedText = await opened.text();
  assert.equal(opened.status, 200);
  assert.ok(JSON.parse(openedText).data.title.startsWith('Home'), 'control: GET returned the entry');
  assertNoServerPath('GET', openedText);
});

for (const method of ['PUT', 'POST']) {
  await check(`${method}: the save response carries no server path`, async () => {
    const response = await request(method, 'pages/home', { data: { title: `Via ${method}` }, type: 'content' });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(fs.readFileSync(pagePath, 'utf8').includes(`Via ${method}`), 'control: the save reached disk');
    assert.equal(JSON.parse(text).locale, null, 'control: the locale is still reported');
    assertNoServerPath(method, text);
  });
}

await check('DELETE: the response carries no server path', async () => {
  const created = await request('POST', 'pages/scratch', { data: { title: 'Scratch' }, type: 'content' });
  assert.equal(created.status, 200);
  assert.ok(fs.existsSync(path.join(projectRoot, 'src/content/pages/scratch.md')), 'control: POST created the entry');
  const deleted = await request('DELETE', 'pages/scratch');
  const deletedText = await deleted.text();
  assert.equal(deleted.status, 200, deletedText);
  assert.ok(!fs.existsSync(path.join(projectRoot, 'src/content/pages/scratch.md')), 'control: the entry was deleted');
  assertNoServerPath('DELETE', deletedText);
});

server.close();
console.log(`[zod ${childZod}] ${passed} checks passed${process.exitCode ? ', some FAILED' : ''}.`);
process.exit(process.exitCode || 0);
