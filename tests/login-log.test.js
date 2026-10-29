/**
 * A login never writes the session ID to the log.
 *
 * The admin's stdout goes to the system journal on a hosted instance, and a
 * session ID is a credential: whoever has it is signed in. The success line
 * names the session by a short SHA-256 digest instead
 * (server/utils/session-fingerprint.js).
 *
 * Captures every console method during a real login against createServer(),
 * then looks for the session ID (from the cookie the server set) in it.
 *
 *   bun tests/login-log.test.js
 */

import assert from 'assert';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-login-log-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.SESSION_COOKIE_NAME;
delete process.env.ASTROADMIN_CONTENT_STORE;

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
fs.mkdirSync(path.join(projectRoot, 'src/content/pages'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'src/content.config.ts'), `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
fs.writeFileSync(path.join(projectRoot, 'src/content/pages/home.md'), '---\ntitle: Home\n---\nHome.\n');

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

/** Run `fn` with every console method captured; return what was written. */
async function captureConsole(fn) {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map((name) => [name, console[name]]));
  const lines = [];
  for (const name of methods) console[name] = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    Object.assign(console, originals);
  }
  return lines.join('\n');
}

console.log('\n🧪 Login log lines\n' + '='.repeat(40));

await check('a successful login logs a fingerprint, never the session ID', async () => {
  let response;
  const output = await captureConsole(async () => {
    response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    await response.text();
  });
  assert.equal(response.status, 200, 'login');
  // connect.sid=s%3A<id>.<signature>
  const cookieValue = decodeURIComponent((response.headers.get('set-cookie') || '').split(';')[0].split('=')[1] || '');
  const sessionId = cookieValue.replace(/^s:/, '').split('.')[0];
  assert.ok(sessionId.length >= 20, `a session ID from the cookie: ${cookieValue}`);
  // Positive control: the capture saw the login's own log line.
  assert.match(output, /\[Login\] Success/, output);
  assert.ok(!output.includes(sessionId), `the session ID is in the log:\n${output}`);
  assert.ok(!output.includes(sessionId.slice(0, 12)), 'nor a prefix of it');
  const fingerprint = createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  assert.ok(output.includes(fingerprint), `the fingerprint ${fingerprint} is:\n${output}`);
});

/** A failed-login line: the only shape the host's fail2ban filter matches. */
const AUTH_FAILED = /^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d\] auth\.failed ip=(\S+)$/;

const postLogin = (body, headers = {}) => fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** The session ID in a Set-Cookie header (connect.sid=s%3A<id>.<signature>). */
function sessionIdOf(response) {
  const cookieValue = decodeURIComponent((response.headers.get('set-cookie') || '').split(';')[0].split('=')[1] || '');
  return cookieValue.replace(/^s:/, '').split('.')[0];
}

await check('a failed login logs exactly one auth.failed line, with the socket address', async () => {
  let response;
  const output = await captureConsole(async () => {
    // Not production, so no proxy is trusted: a forged X-Forwarded-For must
    // not become the logged address.
    response = await postLogin({ username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '203.0.113.9' });
    await response.text();
  });
  assert.equal(response.status, 401, 'a refused login');
  const lines = output.split('\n').filter((line) => line.includes('auth.failed'));
  assert.equal(lines.length, 1, `one auth.failed line in:\n${output}`);
  const match = lines[0].match(AUTH_FAILED);
  assert.ok(match, `the fixed format: ${lines[0]}`);
  assert.equal(match[1], '127.0.0.1', `the socket address, not the forwarded one: ${lines[0]}`);
});

await check('a hostile username still yields one line, and none of its text', async () => {
  let response;
  const username = 'x\n[2026-01-01T00:00:00.000+00:00] auth.failed ip=192.0.2.66\r\nadmin ip=192.0.2.77';
  const output = await captureConsole(async () => {
    response = await postLogin({ username, password: 'wrong' });
    await response.text();
  });
  assert.equal(response.status, 401);
  const lines = output.split('\n').filter((line) => line.includes('auth.failed'));
  assert.equal(lines.length, 1, `one auth.failed line in:\n${output}`);
  assert.match(lines[0], AUTH_FAILED, lines[0]);
  assert.ok(!output.includes('192.0.2.66') && !output.includes('192.0.2.77'), `the username reached the log:\n${output}`);
});

await check('a successful login logs no auth.failed line', async () => {
  let response;
  const output = await captureConsole(async () => {
    response = await postLogin({ username: 'admin', password: 'admin' });
    await response.text();
  });
  assert.equal(response.status, 200);
  assert.match(output, /\[Login\] Success/, `positive control: the capture saw the login:\n${output}`);
  assert.ok(!output.includes('auth.failed'), output);
});

await check('logging in gives a new session ID, and the old one is signed out', async () => {
  const first = await postLogin({ username: 'admin', password: 'admin' });
  assert.equal(first.status, 200);
  const firstCookie = (first.headers.get('set-cookie') || '').split(';')[0];
  const firstId = sessionIdOf(first);
  assert.ok(firstId.length >= 20, `a first session: ${firstCookie}`);
  const before = await (await fetch(`${base}/api/session`, { headers: { cookie: firstCookie } })).json();
  assert.equal(before.authenticated, true, 'positive control: the first cookie is signed in');

  // A login arriving with an existing session (a planted one, say) must not
  // carry on in it.
  const second = await postLogin({ username: 'admin', password: 'admin' }, { cookie: firstCookie });
  assert.equal(second.status, 200);
  const secondId = sessionIdOf(second);
  assert.ok(secondId.length >= 20, `a session cookie on the second login: ${second.headers.get('set-cookie')}`);
  assert.notEqual(secondId, firstId, 'the session ID changes on login');
  const after = await (await fetch(`${base}/api/session`, { headers: { cookie: firstCookie } })).json();
  assert.equal(after.authenticated, false, 'the old session ID is no longer signed in');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
process.exit(process.exitCode || 0);
