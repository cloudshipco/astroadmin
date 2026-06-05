/**
 * In-process API test for git-optional publishing (Chunk ④)
 *
 * Boots the real Express app on an ephemeral port (no Astro, no external
 * server) with git DISABLED, and asserts:
 *   - /api/git/* is not mounted
 *   - /api/publish works without git (no-op when no deploy adapter)
 *   - content read/write round-trips through the DB-backed content API
 *
 * Run with:
 *   GIT_ENABLED=false ASTROADMIN_DB=/tmp/aa-pub.db \
 *     ASTROADMIN_PROJECT_ROOT=/tmp/aa-pub-root bun tests/publish-api.test.js
 */

import assert from 'assert';
import { createServer } from '../server/index.js';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exit(1);
  }
}

const { app } = await createServer();
const server = app.listen(0);
const port = server.address().port;
const base = `http://localhost:${port}`;

let cookie = '';
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${path}`, { ...options, headers });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  return { res, data };
}

console.log('\n🧪 Publish API (git disabled)\n' + '='.repeat(40));

await check('config reports git disabled', async () => {
  const { data } = await api('/api/config');
  assert.equal(data.gitEnabled, false, 'gitEnabled is false');
});

await check('login succeeds', async () => {
  const { res, data } = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(res.status, 200, 'login 200');
  assert.ok(data.success, 'login success');
});

await check('/api/git/* is not mounted', async () => {
  const { res } = await api('/api/git/status');
  assert.equal(res.status, 404, 'git status 404 when git disabled');
});

await check('content round-trips through the API', async () => {
  const write = await api('/api/content/pages/home', {
    method: 'POST',
    body: JSON.stringify({ data: { title: 'Home' }, body: '# Hi', type: 'content' }),
  });
  assert.ok(write.data.success, 'write ok');

  const read = await api('/api/content/pages/home');
  assert.equal(read.res.status, 200, 'read 200');
  assert.equal(read.data.data.title, 'Home', 'data round-trips');
  assert.equal(read.data.type, 'content', 'type content');
});

await check('/api/publish works without git or adapter (no-op)', async () => {
  const { res, data } = await api('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ message: 'test' }),
  });
  assert.equal(res.status, 200, 'publish 200');
  assert.ok(data.success, 'publish success');
  assert.equal(data.committed, false, 'nothing committed (git disabled)');
  assert.equal(data.pushed, false, 'nothing pushed (git disabled)');
  assert.equal(data.build, null, 'no build (no adapter)');
  assert.equal(data.deploy, null, 'no deploy (no adapter)');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
server.close();
process.exit(0);
