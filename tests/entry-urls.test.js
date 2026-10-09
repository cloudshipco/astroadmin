/**
 * Entry URLs (ui/entry-urls.js) against the REAL Express app: an entry with a
 * nested slug (a content file in a subfolder, `articles/2024/first-post`)
 * must be reachable for reads, saves and dashboard links. The routes are
 * `/:collection/:slug`, so the slug travels as one encoded segment and
 * Express decodes it.
 *
 * Builds a throwaway project, starts createServer() on a free port, logs in,
 * and requests the URLs the dashboard builds.
 *
 *   bun tests/entry-urls.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectionApiPath,
  entryApiPath,
  entryDashboardPath,
  entryFromDashboardPath,
  entryValue,
  splitEntryValue,
  virtualPageDashboardPath,
  virtualPageFromDashboardPath,
} from '../ui/entry-urls.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-entry-urls-'));
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
export const collections = {
  articles: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({ title: z.string() }) }),
};
`);
writeProjectFile('src/content/articles/2024/first-post.md', '---\ntitle: First post\n---\nHello.\n');
writeProjectFile('src/content/articles/flat.md', '---\ntitle: Flat\n---\nFlat.\n');

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
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
assert.equal(login.status, 200, 'login');
const cookie = login.headers.get('set-cookie').split(';')[0];
const request = (urlPath, options = {}) => fetch(base + urlPath, { ...options, headers: { cookie, 'Content-Type': 'application/json', ...(options.headers || {}) } });
const NESTED = { collection: 'articles', slug: '2024/first-post' };
const nestedFile = path.join(projectRoot, 'src/content/articles/2024/first-post.md');

console.log('\n🧪 entry URLs against the real router\n' + '='.repeat(40));

await check('the entry list reports the nested slug (it is what the editor names the entry by)', async () => {
  const body = await (await request('/api/collections/articles/entries')).json();
  assert.ok(body.entries.includes('2024/first-post'), JSON.stringify(body.entries));
});

await check('control: the unencoded path does NOT reach the content route (why encoding is needed)', async () => {
  const response = await request(`/api/content/${NESTED.collection}/${NESTED.slug}`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'API endpoint not found');
});

await check('read: entryApiPath reaches GET /:collection/:slug with the slug decoded', async () => {
  assert.equal(entryApiPath(NESTED.collection, NESTED.slug), '/api/content/articles/2024%2Ffirst-post');
  const response = await request(entryApiPath(NESTED.collection, NESTED.slug));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.slug, '2024/first-post');
  assert.equal(body.data.title, 'First post');
});

await check('save: entryApiPath reaches POST and writes the nested file (and only it)', async () => {
  const flatBefore = fs.readFileSync(path.join(projectRoot, 'src/content/articles/flat.md'), 'utf8');
  const response = await request(entryApiPath(NESTED.collection, NESTED.slug), {
    method: 'POST', body: JSON.stringify({ data: { title: 'First post, edited' }, body: 'Hello.\n', type: 'content' }),
  });
  assert.equal(response.status, 200);
  assert.match(fs.readFileSync(nestedFile, 'utf8'), /title: 'First post, edited'/);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'src/content/articles/flat.md'), 'utf8'), flatBefore);
  assert.equal(fs.existsSync(path.join(projectRoot, 'src/content/articles/2024%2Ffirst-post.md')), false, 'no file named after the encoded slug');
});

await check('a flat slug is unchanged by encoding (control)', async () => {
  assert.equal(entryApiPath('articles', 'flat'), '/api/content/articles/flat');
  assert.equal((await request(entryApiPath('articles', 'flat'))).status, 200);
});

await check('dashboard: entryDashboardPath serves the dashboard, and parses back to the entry', async () => {
  const dashboardPath = entryDashboardPath(NESTED.collection, NESTED.slug);
  const page = await (await request(dashboardPath)).text();
  assert.ok(page.includes('id="pageSelector"'), 'the nested link serves the dashboard, not the login redirect');
  // Control: the unencoded form falls through to the login-redirect page.
  assert.ok(!(await (await request(`/dashboard/${NESTED.collection}/${NESTED.slug}`)).text()).includes('id="pageSelector"'));
  assert.deepEqual(entryFromDashboardPath(dashboardPath), NESTED);
  assert.deepEqual(entryFromDashboardPath('/dashboard/pages/home'), { collection: 'pages', slug: 'home' });
  assert.equal(entryFromDashboardPath('/dashboard/pages/%E0%A4%A'), null, 'a malformed escape names nothing');
});

await check('dashboard.js builds content and dashboard URLs only through entry-urls.js', () => {
  const dashboardSource = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
  // Positive control: the helpers are used where the reads and saves happen.
  assert.ok((dashboardSource.match(/entryApiPath\(/g) || []).length >= 3, 'loadEntry, the saver and delete use entryApiPath');
  assert.equal(dashboardSource.includes('/api/content/'), false, 'a hand-built content API URL');
  assert.equal(dashboardSource.includes('`/dashboard/${'), false, 'a hand-built dashboard URL');
  // Picker values, virtual-page URLs and collection API URLs too.
  assert.ok((dashboardSource.match(/entryValue\(/g) || []).length >= 6, 'the picker values use entryValue');
  assert.ok(dashboardSource.includes('virtualPageDashboardPath(') && dashboardSource.includes('virtualPageFromDashboardPath('), 'virtual pages use the helpers');
  assert.ok((dashboardSource.match(/collectionApiPath\(/g) || []).length >= 5, 'collection API URLs use collectionApiPath');
  const handBuiltValues = dashboardSource.split('\n').filter((line) => /\.value\b/.test(line) && /\$\{[^}]+\}\/\$\{/.test(line));
  assert.deepEqual(handBuiltValues, [], 'a hand-built <collection>/<slug> picker value');
  assert.equal(dashboardSource.includes('`/dashboard/__page__/'), false, 'a hand-built virtual-page URL');
  assert.equal(dashboardSource.includes('\\/dashboard\\/__page__'), false, 'a virtual-page URL parsed by hand');
  assert.equal(dashboardSource.includes('`/api/collections/${'), false, 'a hand-built collection API URL');
});

await check('no ui/*.js file builds an entry, dashboard or collection URL by hand', () => {
  const uiFiles = fs.readdirSync(path.join(repoRoot, 'ui')).filter((name) => name.endsWith('.js') && name !== 'entry-urls.js');
  // Positive control: the listing is the real ui folder, and it holds the files the rule is about.
  for (const expected of ['dashboard.js', 'reference-picker.js', 'entry-picker.js']) {
    assert.ok(uiFiles.includes(expected), `${expected} not found in ui/ (${uiFiles.length} files)`);
  }
  const offences = [];
  for (const name of uiFiles) {
    const source = fs.readFileSync(path.join(repoRoot, 'ui', name), 'utf8');
    for (const [needle, what] of [
      ['`/api/collections/${', 'collection API URL'],
      ['/api/content/', 'content API URL'],
      ['`/dashboard/${', 'dashboard URL'],
      ['`/dashboard/__page__/', 'virtual-page URL'],
    ]) {
      if (source.includes(needle)) offences.push(`${name}: hand-built ${what}`);
    }
  }
  assert.deepEqual(offences, []);
});

await check('virtual pages: a slug with non-ASCII and escaped characters survives a reload parse', async () => {
  for (const pageSlug of ['über_café', '100%_done', 'a#b?c', 'spaced name', 'colon:slug', 'docs_intro']) {
    const dashboardPath = virtualPageDashboardPath(pageSlug);
    // A reload: the browser hands back the pathname as it holds it.
    const reloaded = new URL(dashboardPath, 'http://admin.example.com').pathname;
    assert.equal(virtualPageFromDashboardPath(reloaded), pageSlug, `${pageSlug} -> ${reloaded}`);
    const page = await (await request(dashboardPath)).text();
    assert.ok(page.includes('id="pageSelector"'), `${pageSlug}: the virtual-page link serves the dashboard`);
  }
  // The old hand-built form loses a non-ASCII slug on reload (the bug): control.
  assert.notEqual(new URL('/dashboard/__page__/über_café', 'http://admin.example.com').pathname.slice('/dashboard/__page__/'.length), 'über_café');
  assert.equal(virtualPageFromDashboardPath('/dashboard/__page__/%E0%A4%A'), null, 'a malformed escape names nothing');
  assert.equal(virtualPageFromDashboardPath('/dashboard/__page__/'), null);
  assert.equal(virtualPageFromDashboardPath('/dashboard/pages/home'), null);
});

await check('entryValue is the inverse of splitEntryValue, and collectionApiPath encodes', () => {
  assert.equal(entryValue(NESTED.collection, NESTED.slug), 'articles/2024/first-post');
  assert.deepEqual(splitEntryValue(entryValue(NESTED.collection, NESTED.slug)), NESTED);
  assert.equal(collectionApiPath('articles'), '/api/collections/articles');
  assert.equal(collectionApiPath('a#b', '/entries?preview=true'), '/api/collections/a%23b/entries?preview=true');
});

await check('picker: choosing "pages/team/jane" loads collection pages, slug team/jane (the real change handler)', () => {
  // The <select>'s option value is "<collection>/<slug>"; a nested slug has
  // more slashes, and only the first separates the collection.
  const dashboardSource = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
  const handlerSource = dashboardSource.match(/document\.getElementById\('pageSelector'\)\.addEventListener\('change', \(e\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handlerSource, 'pageSelector change handler not found in dashboard.js');
  const loads = [];
  let handler = null;
  const documentStub = { getElementById: (id) => (id === 'pageSelector' ? { addEventListener: (type, fn) => { if (type === 'change') handler = fn; } } : null) };
  new Function('document', 'loadEntry', 'loadVirtualPage', 'openNewItemModal', 'splitEntryValue', 'currentCollection', 'currentSlug', handlerSource)(
    documentStub, (collection, slug) => loads.push([collection, slug]), () => {}, () => {}, splitEntryValue, null, null,
  );
  assert.ok(handler, 'the handler registered');
  handler({ target: { value: 'pages/team/jane' } });
  handler({ target: { value: 'pages/about' } });
  assert.deepEqual(loads, [['pages', 'team/jane'], ['pages', 'about']]);
});

await check('picker: "New..." passes the whole collection name after the first colon', () => {
  const dashboardSource = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
  const handlerSource = dashboardSource.match(/document\.getElementById\('pageSelector'\)\.addEventListener\('change', \(e\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handlerSource, 'pageSelector change handler not found in dashboard.js');
  const opened = [];
  let handler = null;
  const documentStub = { getElementById: (id) => (id === 'pageSelector' ? { addEventListener: (type, fn) => { if (type === 'change') handler = fn; } } : null) };
  new Function('document', 'loadEntry', 'loadVirtualPage', 'openNewItemModal', 'splitEntryValue', 'entryValue', 'currentCollection', 'currentSlug', handlerSource)(
    documentStub, () => {}, () => {}, (collection) => opened.push(collection), splitEntryValue, entryValue, null, null,
  );
  handler({ target: { value: 'new:articles' } });
  handler({ target: { value: 'new:docs:v2' } });
  assert.deepEqual(opened, ['articles', 'docs:v2']);
});

await check('splitEntryValue splits at the first slash only', () => {
  assert.deepEqual(splitEntryValue('articles/2024/first-post'), NESTED);
  assert.deepEqual(splitEntryValue('pages/home'), { collection: 'pages', slug: 'home' });
  assert.equal(splitEntryValue('pages'), null);
  assert.equal(splitEntryValue('/home'), null);
  assert.equal(splitEntryValue('pages/'), null);
});

server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(process.exitCode || 0);
