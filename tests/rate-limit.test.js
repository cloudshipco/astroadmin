/**
 * The /api rate limits (server/utils/rate-limit.js), on a real server in
 * production mode, the only mode that limits.
 *
 * - a signed-in session doing a burst of 150 requests is not limited (one
 *   address's 100-request budget used to cover the editor too, and a heavy
 *   editing session ran out of it); its own budget is sessionMax;
 * - anyone not signed in still gets 100 requests per address per window;
 * - every login attempt, even from a signed-in session, still counts against
 *   the address's 100;
 * - a refusal is JSON ({ error, message }) with a Retry-After header, not the
 *   plain text the dashboard failed to parse.
 *
 * Requests carry X-Forwarded-For (the server trusts one proxy in production,
 * as behind nginx), so each case has its own address.
 *
 *   bun tests/rate-limit.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-rate-limit-')));
process.env.NODE_ENV = 'production';
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.SESSION_DB_PATH = path.join(projectRoot, 'data/sessions.db');
process.env.SESSION_SECRET = 'rate-limit-test-secret-0123456789abcdef';
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.SESSION_COOKIE_NAME;
delete process.env.SESSION_COOKIE_DOMAIN;
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
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\n---\nHome.\n');

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
const { getConfig } = await import('../server/config.js');
const limits = (await getConfig()).rateLimit;
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** Headers as nginx would pass them for a browser at `address`. */
const via = (address, extra = {}) => ({ 'X-Forwarded-For': address, 'X-Forwarded-Proto': 'https', ...extra });

const login = (address, password, extra = {}) => fetch(`${base}/api/login`, {
  method: 'POST',
  headers: via(address, { 'Content-Type': 'application/json', ...extra }),
  body: JSON.stringify({ username: 'admin', password }),
});

/** Send `count` requests one after another; return their statuses. */
async function burst(count, send) {
  const statuses = [];
  for (let i = 0; i < count; i++) {
    const response = await send();
    await response.arrayBuffer();
    statuses.push(response.status);
  }
  return statuses;
}

/** A refusal must be the JSON the dashboard reads, with Retry-After. */
async function assertJsonRefusal(response) {
  assert.equal(response.status, 429);
  assert.match(response.headers.get('content-type') || '', /application\/json/, 'a JSON body');
  const retryAfter = Number(response.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= limits.windowMs / 1000, `Retry-After in seconds: ${response.headers.get('retry-after')}`);
  const body = await response.json();
  assert.equal(typeof body.error, 'string');
  assert.match(body.message, /^Too many requests, try again in \d+ minutes?\.$/, body.message);
}

console.log('\n🧪 /api rate limits\n' + '='.repeat(40));

assert.equal(limits.enabled, true, 'production mode limits (positive control)');
assert.equal(limits.max, 100);

const signedIn = await login('10.0.0.1', 'admin');
assert.equal(signedIn.status, 200, 'login');
const cookie = (signedIn.headers.get('set-cookie') || '').split(';')[0];
assert.ok(cookie.includes('='), `a session cookie: ${signedIn.headers.get('set-cookie')}`);

await check('a signed-in session doing a burst of 150 requests is not limited', async () => {
  const statuses = await burst(150, () => fetch(`${base}/api/session`, { headers: via('10.0.0.1', { cookie }) }));
  assert.deepEqual([...new Set(statuses)], [200], `statuses: ${statuses.filter((s) => s !== 200).length} not 200`);
  const response = await fetch(`${base}/api/collections`, { headers: via('10.0.0.1', { cookie }) });
  assert.equal(response.status, 200, 'a real editor endpoint too');
});

await check('anyone not signed in gets 100 requests per address, then a JSON 429 with Retry-After', async () => {
  const statuses = await burst(limits.max, () => fetch(`${base}/api/session`, { headers: via('10.0.0.2') }));
  assert.deepEqual([...new Set(statuses)], [200]);
  await assertJsonRefusal(await fetch(`${base}/api/session`, { headers: via('10.0.0.2') }));
  // The address's budget is spent, but a signed-in session from it has its own.
  const editor = await fetch(`${base}/api/session`, { headers: via('10.0.0.2', { cookie }) });
  assert.equal(editor.status, 200, 'the signed-in session from the same address');
});

await check('login attempts get 100 per address, then a JSON 429', async () => {
  const statuses = await burst(limits.max, () => login('10.0.0.3', 'wrong'));
  assert.deepEqual([...new Set(statuses)], [401]);
  await assertJsonRefusal(await login('10.0.0.3', 'wrong'));
  await assertJsonRefusal(await login('10.0.0.3', 'admin'));
});

await check('login attempts from a signed-in session still count against the address', async () => {
  const statuses = await burst(limits.max, () => login('10.0.0.4', 'wrong', { cookie }));
  assert.deepEqual([...new Set(statuses)], [401]);
  await assertJsonRefusal(await login('10.0.0.4', 'wrong', { cookie }));
});

await check('a signed-in session is limited at sessionMax', async () => {
  const second = await login('10.0.0.5', 'admin');
  assert.equal(second.status, 200);
  const secondCookie = (second.headers.get('set-cookie') || '').split(';')[0];
  const statuses = await burst(limits.sessionMax, () => fetch(`${base}/api/session`, { headers: via('10.0.0.5', { cookie: secondCookie }) }));
  assert.deepEqual([...new Set(statuses)], [200], `${statuses.filter((s) => s !== 200).length} of ${limits.sessionMax} refused`);
  await assertJsonRefusal(await fetch(`${base}/api/session`, { headers: via('10.0.0.5', { cookie: secondCookie }) }));
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
process.exit(process.exitCode || 0);
