/**
 * Entry URLs (ui/entry-urls.js) against the REAL Express app: an entry with a
 * nested slug (a content file in a subfolder, `articles/2024/first-post`, as
 * a card's data-aa-entry names it) must be reachable for reads, saves and
 * dashboard links. The routes are `/:collection/:slug`, so the slug travels
 * as one encoded segment and Express decodes it.
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
import { entryApiPath, entryDashboardPath, entryFromDashboardPath } from '../ui/entry-urls.js';

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

await check('the entry list reports the nested slug (it is what data-aa-entry names)', async () => {
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
});

server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(process.exitCode || 0);
