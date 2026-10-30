/**
 * A TLS proxy the app does not trust (server/utils/untrusted-proxy.js), on a
 * real server in production mode.
 *
 * Production trusts a loopback proxy only. Behind a TLS proxy on another
 * machine or container, `X-Forwarded-Proto: https` is ignored, so the request
 * looks like plain HTTP and express-session silently drops the HTTPS-only
 * session cookie: the login used to answer 200 with no Set-Cookie, and the
 * editor was sent back to the login page for ever. Now:
 *
 * - a correct login through such a proxy is refused with our fixed sentence
 *   naming TRUST_PROXY (no address), and no session cookie;
 * - a wrong password is still a 401 with its `auth.failed` line, so the
 *   check gives no way round fail2ban;
 * - the server log gets one fixed warning naming TRUST_PROXY and the docs
 *   section, with no address, and not again for the next request;
 * - controls: the same peer named in TRUST_PROXY signs in with a cookie and
 *   no warning; a direct request with no forwarded headers gets no warning.
 *
 * The peer is simulated by overriding the accepted socket's remoteAddress,
 * as tests/rate-limit.test.js does.
 *
 *   bun tests/untrusted-proxy.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-untrusted-proxy-')));
process.env.NODE_ENV = 'production';
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.SESSION_DB_PATH = path.join(projectRoot, 'data/sessions.db');
process.env.SESSION_SECRET = 'untrusted-proxy-test-secret-0123456789abcdef';
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.SESSION_COOKIE_NAME;
delete process.env.SESSION_COOKIE_DOMAIN;
delete process.env.ASTROADMIN_CONTENT_STORE;
delete process.env.TRUST_PROXY;

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

/** Every console.log / console.warn line written while `fn` runs. */
async function captureLog(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines = [];
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return lines;
}

/** Serve `serverApp` with every connection's peer address replaced. */
async function listenAsPeer(serverApp, peerAddress) {
  const peerServer = serverApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => peerServer.once('listening', resolve));
  let connections = 0;
  peerServer.prependListener('connection', (socket) => {
    connections++;
    Object.defineProperty(socket, 'remoteAddress', { value: peerAddress, configurable: true });
  });
  return { peerServer, peerBase: `http://127.0.0.1:${peerServer.address().port}`, connections: () => connections };
}

const PEER = '198.51.100.80';
const CLIENT = '203.0.113.7';

/** A browser's login as a TLS proxy forwards it. */
const proxiedLogin = (peerBase, password, forwarded = true) => fetch(`${peerBase}/api/login`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    ...(forwarded ? { 'X-Forwarded-For': CLIENT, 'X-Forwarded-Proto': 'https' } : {}),
  },
  body: JSON.stringify({ username: 'admin', password }),
});

const { createServer } = await import('../server/index.js');

console.log('\n🧪 A TLS proxy that is not trusted\n' + '='.repeat(40));

const { app } = await createServer();
assert.equal(app.get('trust proxy fn')(PEER, 0), false, 'positive control: the peer is not trusted by default');

await check('a correct login through an untrusted proxy is refused with a sentence naming TRUST_PROXY, and logs one warning', async () => {
  const { peerServer, peerBase, connections } = await listenAsPeer(app, PEER);
  try {
    let response;
    let body;
    let second;
    const lines = await captureLog(async () => {
      response = await proxiedLogin(peerBase, 'admin');
      body = await response.json();
      second = await proxiedLogin(peerBase, 'admin');
      await second.arrayBuffer();
    });
    assert.ok(connections() > 0, 'positive control: the peer address was applied');
    assert.equal(response.headers.get('set-cookie'), null, 'no session cookie');
    assert.notEqual(response.status, 200, `status ${response.status}: ${JSON.stringify(body)}`);
    assert.equal(body.success, false);
    assert.match(body.error, /TRUST_PROXY/, body.error);
    assert.ok(!body.error.includes(PEER) && !body.error.includes(CLIENT), 'no address in the response');
    assert.equal(second.status, response.status, 'the second attempt is refused the same way');

    const warnings = lines.filter((line) => line.includes('TRUST_PROXY'));
    assert.equal(warnings.length, 1, `one warning, not one per request:\n${lines.join('\n')}`);
    assert.match(warnings[0], /Trusted proxies/, 'names the docs section');
    assert.ok(!warnings[0].includes(PEER) && !warnings[0].includes(CLIENT), 'no address in the log line');
    assert.ok(!lines.some((line) => line.startsWith('[Login] Success')), 'no session was made');
  } finally {
    peerServer.close();
  }
});

await check('a wrong password through an untrusted proxy is still a 401 with its auth.failed line', async () => {
  const { peerServer, peerBase } = await listenAsPeer(app, PEER);
  try {
    let response;
    const lines = await captureLog(async () => {
      response = await proxiedLogin(peerBase, 'wrong');
      await response.arrayBuffer();
    });
    assert.equal(response.status, 401);
    assert.ok(lines.some((line) => line.endsWith(`auth.failed ip=${PEER}`)), lines.join('\n'));
  } finally {
    peerServer.close();
  }
});

await check('a direct request with no forwarded headers logs no proxy warning (control)', async () => {
  const fresh = (await createServer()).app;
  const { peerServer, peerBase } = await listenAsPeer(fresh, PEER);
  try {
    const lines = await captureLog(async () => {
      const response = await proxiedLogin(peerBase, 'wrong', false);
      await response.arrayBuffer();
      assert.equal(response.status, 401);
    });
    assert.ok(!lines.some((line) => line.includes('TRUST_PROXY')), lines.join('\n'));
  } finally {
    peerServer.close();
  }
});

await check('the same proxy named in TRUST_PROXY signs in with a cookie and no warning (control)', async () => {
  process.env.TRUST_PROXY = `${PEER}, loopback`;
  let trusted;
  try {
    trusted = (await createServer()).app;
  } finally {
    delete process.env.TRUST_PROXY;
  }
  const { peerServer, peerBase } = await listenAsPeer(trusted, PEER);
  try {
    let response;
    const lines = await captureLog(async () => {
      response = await proxiedLogin(peerBase, 'admin');
      await response.arrayBuffer();
    });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('set-cookie') || '').includes('Secure'), `a secure cookie: ${response.headers.get('set-cookie')}`);
    assert.ok(!lines.some((line) => line.includes('TRUST_PROXY')), lines.join('\n'));
  } finally {
    peerServer.close();
  }
});

await check('the warning repeats once the interval has passed, not before', async () => {
  const { untrustedProxyWarning, WARNING_INTERVAL_MS } = await import('../server/utils/untrusted-proxy.js');
  let time = 1_000_000;
  const lines = [];
  const middleware = untrustedProxyWarning({ cookieSecure: true, now: () => time, warn: (line) => lines.push(line) });
  const request = {
    secure: false,
    socket: { remoteAddress: PEER },
    app: { get: () => () => false },
    get: (name) => (name === 'x-forwarded-proto' ? 'https' : undefined),
  };
  const send = () => new Promise((resolve) => middleware(request, {}, resolve));
  await send();
  time += WARNING_INTERVAL_MS - 1;
  await send();
  assert.equal(lines.length, 1, 'not again within the interval');
  time += 1;
  await send();
  assert.equal(lines.length, 2, 'again after it');
  const secureOff = untrustedProxyWarning({ cookieSecure: false, warn: (line) => lines.push(line) });
  await new Promise((resolve) => secureOff(request, {}, resolve));
  assert.equal(lines.length, 2, 'never with a cookie that is not HTTPS-only (development)');
});

fs.rmSync(projectRoot, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(process.exitCode || 0);
