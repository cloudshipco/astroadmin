/**
 * The admin's basic HTTP surface, in process through the real createServer()
 * app (#2): health, the frontend config, sign-in and sign-out, and the
 * collection listing. It replaces tests/api.test.js, which needed a server
 * already running on localhost:3030 (and sent its logins and writes to
 * whatever was listening there).
 *
 * The rest of what that file checked is covered elsewhere, in process:
 * content reads and writes (save-body, schema-refinements, untouched-*),
 * git status and log (git-api, git-log-limit), and cross-origin refusals
 * and logout (cross-origin).
 *
 *   bun tests/api-basics.test.js     (<1 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-api-basics-')));
const PASSWORD = 'basics-test-password-7f3a';
const SESSION_SECRET = 'basics-test-session-secret-91c2';
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'false';
process.env.ADMIN_USERNAME = 'editor';
process.env.ADMIN_PASSWORD = PASSWORD;
process.env.SESSION_SECRET = SESSION_SECRET;
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
const git = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('.gitignore', 'node_modules\n');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('astroadmin.config.js', "export default { preview: { url: 'http://localhost:4999' }, publicUrl: 'https://www.example.com' };\n");
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
  testimonials: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/testimonials' }), schema: z.object({ name: z.string() }) }),
};
`);
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\n---\nHome.\n');
writeProjectFile('src/content/pages/about.md', '---\ntitle: About\n---\nAbout.\n');
writeProjectFile('src/content/testimonials/first.md', '---\nname: A. Reader\n---\n');
git(['init', '-q']);
git(['config', 'user.name', 'Test']);
git(['config', 'user.email', 'test@example.com']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'init']);

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

const PROTECTED_ROUTES = ['/api/collections', '/api/collections/pages', '/api/content/pages/home', '/api/git/status', '/api/images', '/api/doctor'];

const getJson = async (route, cookie) => {
  const response = await fetch(base + route, { headers: cookie ? { cookie } : {} });
  return { status: response.status, body: await response.json() };
};
const login = (username, password) => fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});

console.log('\n🧪 the admin\'s basic API\n' + '='.repeat(40));

try {
  await check('GET /api/health is ok without a session', async () => {
    const { status, body } = await getJson('/api/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.ok(['development', 'production'].includes(body.environment), body.environment);
  });

  await check('GET /api/config carries the frontend\'s settings, and no credential', async () => {
    const response = await fetch(`${base}/api/config`);
    const text = await response.text();
    assert.equal(response.status, 200);
    const body = JSON.parse(text);
    assert.equal(body.previewUrl, 'http://localhost:4999');
    assert.equal(body.publicUrl, 'https://www.example.com');
    assert.equal(body.gitEnabled, true);
    assert.ok(Array.isArray(body.collectionOrder));
    for (const secret of [PASSWORD, SESSION_SECRET, 'editor']) assert.ok(!text.includes(secret), `the config names ${secret}`);
  });

  await check('without a session, the API routes are 401 and /api/session says so', async () => {
    for (const route of PROTECTED_ROUTES) {
      const { status } = await getJson(route);
      assert.equal(status, 401, `GET ${route}: ${status}`);
    }
    assert.deepEqual((await getJson('/api/session')).body, { authenticated: false });
  });

  await check('a wrong password or username is a 401 that sets no session', async () => {
    for (const [username, password] of [['editor', 'wrong'], ['someone', PASSWORD], ['', '']]) {
      const response = await login(username, password);
      assert.equal(response.status, 401, `${username}: ${response.status}`);
      assert.equal((await response.json()).success, false);
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (cookie) assert.equal((await getJson('/api/collections', cookie)).status, 401, `${username}: the cookie it set is a session`);
    }
  });

  const loginResponse = await login('editor', PASSWORD);
  const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0];

  await check('signing in gives a session that /api/session reports and the API accepts', async () => {
    assert.equal(loginResponse.status, 200);
    assert.deepEqual(await loginResponse.json(), { success: true, user: 'editor' });
    assert.ok(cookie, 'a session cookie was set');
    assert.deepEqual((await getJson('/api/session', cookie)).body, { authenticated: true, user: 'editor' });
  });

  await check('GET /api/collections lists the declared collections; one collection lists its entries', async () => {
    const list = await getJson('/api/collections', cookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.success, true);
    assert.deepEqual(list.body.collections.map((collection) => collection.name).sort(), ['pages', 'testimonials']);
    const pages = await getJson('/api/collections/pages', cookie);
    assert.equal(pages.status, 200);
    assert.equal(pages.body.collection.name, 'pages');
    assert.deepEqual([...pages.body.collection.entries].sort(), ['about', 'home']);
    assert.equal(pages.body.collection.entryCount, 2);
  });

  await check('signing out ends the session: /api/session is unauthenticated and the API is 401 again', async () => {
    const response = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    assert.deepEqual((await getJson('/api/session', cookie)).body, { authenticated: false });
    for (const route of PROTECTED_ROUTES) assert.equal((await getJson(route, cookie)).status, 401, route);
  });
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
