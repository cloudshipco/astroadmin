/**
 * The /api rate limits (server/utils/rate-limit.js), on a real server in
 * production mode, the only mode that limits.
 *
 * - a signed-in session doing a burst of 150 requests is not limited (one
 *   address's 100-request budget used to cover the editor too, and a heavy
 *   editing session ran out of it); its own budget is sessionMax;
 * - anyone not signed in still gets 100 requests per address per window;
 * - every login attempt, even from a signed-in session, still counts against
 *   the address's 100, and a FAILED one also against the address's login
 *   budget (loginMax, 10), so password guessing stops long before the 100;
 * - "per address" is per IPv4 address and per IPv6 /56: failed logins from
 *   many addresses in one /56 share a budget, and an IPv4-mapped address
 *   shares its IPv4 address's (an attacker with a /64 used to rotate);
 * - a failed login logs one `auth.failed ip=<address>` line, the address being
 *   the one express sees through the trusted proxy (the client's own, not
 *   its /56);
 * - a refusal is JSON ({ error, message }) with a Retry-After header, not the
 *   plain text the dashboard failed to parse.
 *
 * Requests carry X-Forwarded-For from 127.0.0.1 (production trusts a
 * loopback proxy, as nginx on the same host), so each case has its own
 * address. A peer that is not loopback has its X-Forwarded-For ignored
 * (counted and logged by its own address) unless TRUST_PROXY names it. That
 * peer is simulated by overriding the accepted socket's remoteAddress, which
 * is what express reads, since a test host may have no second interface to
 * connect from.
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

/** Capture console.log while `fn` runs; return the lines. */
async function captureLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

await check('failed logins get 10 per address, then a JSON 429, while other requests still pass', async () => {
  assert.equal(limits.loginMax, 10, 'the login budget');
  const statuses = await burst(limits.loginMax, () => login('10.0.0.3', 'wrong'));
  assert.deepEqual([...new Set(statuses)], [401]);
  await assertJsonRefusal(await login('10.0.0.3', 'wrong'));
  await assertJsonRefusal(await login('10.0.0.3', 'admin'));
  // The address's general budget is not spent: an anonymous GET still passes.
  const anonymous = await fetch(`${base}/api/session`, { headers: via('10.0.0.3') });
  assert.equal(anonymous.status, 200, 'an anonymous GET from the same address');
  // Another address has its own login budget.
  assert.equal((await login('10.0.0.30', 'wrong')).status, 401, 'another address');
});

await check('failed logins from many addresses in one IPv6 /56 share one budget', async () => {
  // An IPv6 client is usually given a /64 or more: counting each address on
  // its own let it make 10 guesses per address, without end. Spread over
  // two /64s inside one /56, written in different spellings.
  const addresses = Array.from({ length: limits.loginMax }, (_, index) =>
    index % 2 === 0 ? `2001:db8:aa:10::${index + 1}` : `2001:0db8:00aa:0011:0:0:0:${(index + 1).toString(16)}`);
  const statuses = [];
  for (const address of addresses) {
    const response = await login(address, 'wrong');
    await response.arrayBuffer();
    statuses.push(response.status);
  }
  assert.deepEqual([...new Set(statuses)], [401]);
  await assertJsonRefusal(await login('2001:db8:aa:ff:1234:5678:9abc:def0', 'wrong'));
  // Another /56 has its own budget (positive control).
  assert.equal((await login('2001:db8:ab::1', 'wrong')).status, 401, 'another /56');
});

await check('an IPv4-mapped IPv6 address shares its IPv4 address\'s budget', async () => {
  const statuses = await burst(limits.loginMax, () => login('192.0.2.44', 'wrong'));
  assert.deepEqual([...new Set(statuses)], [401]);
  await assertJsonRefusal(await login('::ffff:192.0.2.44', 'wrong'));
  assert.equal((await login('::ffff:192.0.2.45', 'wrong')).status, 401, 'the next IPv4 address is its own');
});

await check('a failed login from IPv6 logs the client\'s own address, not its /56', async () => {
  const lines = await captureLog(async () => {
    assert.equal((await login('2001:db8:cc::abcd', 'wrong')).status, 401);
    assert.equal((await login('::ffff:198.51.100.24', 'wrong')).status, 401);
  });
  const failures = lines.filter((line) => line.includes('auth.failed'));
  assert.deepEqual(failures.map((line) => line.split('] ')[1]), ['auth.failed ip=2001:db8:cc::abcd', 'auth.failed ip=198.51.100.24']);
});

await check('rateLimitKey: one key per IPv4 address and per IPv6 /56, whatever the spelling', async () => {
  const { rateLimitKey, clientAddress } = await import('../server/utils/client-address.js');
  assert.equal(rateLimitKey('203.0.113.9'), 'ipv4:203.0.113.9');
  assert.equal(rateLimitKey('::ffff:203.0.113.9'), 'ipv4:203.0.113.9');
  assert.equal(rateLimitKey('::FFFF:203.0.113.9'), 'ipv4:203.0.113.9');
  assert.equal(rateLimitKey('2001:db8:1234:5600::1'), 'ipv6:2001:db8:1234:5600::/56');
  assert.equal(rateLimitKey('2001:db8:1234:56ff:ffff:ffff:ffff:ffff'), 'ipv6:2001:db8:1234:5600::/56');
  assert.equal(rateLimitKey('2001:DB8:1234:56AB::1%en0'), 'ipv6:2001:db8:1234:5600::/56');
  assert.equal(rateLimitKey('64:ff9b::203.0.113.9'), 'ipv6:64:ff9b:0:0::/56');
  assert.notEqual(rateLimitKey('2001:db8:1234:5700::1'), rateLimitKey('2001:db8:1234:5600::1'), 'the next /56');
  assert.equal(rateLimitKey('::1'), 'ipv6:0:0:0:0::/56');
  for (const junk of [undefined, '', 'not-an-address', '1.2.3.4.5']) assert.equal(rateLimitKey(junk), 'invalid', String(junk));
  assert.equal(clientAddress('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(clientAddress('2001:db8::1'), '2001:db8::1', 'the log keeps the whole address');
});

await check('successful logins do not use the login budget', async () => {
  const statuses = await burst(limits.loginMax + 5, () => login('10.0.0.6', 'admin'));
  assert.deepEqual([...new Set(statuses)], [200]);
  // Failures after them still have the whole budget.
  const failures = await burst(limits.loginMax, () => login('10.0.0.6', 'wrong'));
  assert.deepEqual([...new Set(failures)], [401]);
  await assertJsonRefusal(await login('10.0.0.6', 'wrong'));
});

await check('every login attempt still counts against the address\'s general budget', async () => {
  // A successful login skips the login budget but not the general one.
  const statuses = await burst(limits.max, () => login('10.0.0.7', 'admin'));
  assert.deepEqual([...new Set(statuses)], [200]);
  await assertJsonRefusal(await login('10.0.0.7', 'admin'));
});

await check('a failed login logs the address express sees behind the proxy', async () => {
  const lines = await captureLog(async () => {
    const response = await login('198.51.100.23', 'wrong');
    assert.equal(response.status, 401);
  });
  const failures = lines.filter((line) => line.includes('auth.failed'));
  assert.equal(failures.length, 1, `one auth.failed line in:\n${lines.join('\n')}`);
  assert.match(failures[0], /^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d\] auth\.failed ip=198\.51\.100\.23$/, failures[0]);
});

await check('failed logins from a signed-in session still count against the address', async () => {
  const statuses = await burst(limits.loginMax, () => login('10.0.0.4', 'wrong', { cookie }));
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

/**
 * Serve `serverApp` on 127.0.0.1, but with every connection's peer address
 * replaced by `peerAddress` before the request is parsed: what express (via
 * req.socket.remoteAddress) sees when a client connects from another host.
 * It proves the app's trust decision follows the socket address; it does not
 * exercise a real non-loopback route, which a test host may not have.
 */
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

const peerLogin = (peerBase, forwardedFor) => fetch(`${peerBase}/api/login`, {
  method: 'POST',
  headers: via(forwardedFor, { 'Content-Type': 'application/json' }),
  body: JSON.stringify({ username: 'admin', password: 'wrong' }),
});

await check('by default only a loopback peer is a trusted proxy: another peer\'s X-Forwarded-For is ignored', async () => {
  const { peerServer, peerBase, connections } = await listenAsPeer(app, '198.51.100.70');
  try {
    // Ten failed logins, each claiming a different client. Trusted, they
    // would be ten addresses with a budget each; ignored, they are one.
    let lines;
    const statuses = [];
    lines = await captureLog(async () => {
      for (let index = 0; index < limits.loginMax; index++) {
        const response = await peerLogin(peerBase, `203.0.113.${100 + index}`);
        await response.arrayBuffer();
        statuses.push(response.status);
      }
    });
    assert.ok(connections() > 0, 'positive control: the peer address was applied');
    assert.deepEqual([...new Set(statuses)], [401]);
    await assertJsonRefusal(await peerLogin(peerBase, '203.0.113.200'));
    const failures = lines.filter((line) => line.includes('auth.failed'));
    assert.ok(failures.length === limits.loginMax && failures.every((line) => line.endsWith('auth.failed ip=198.51.100.70')), failures.join('\n'));
  } finally {
    peerServer.close();
  }
});

await check('TRUST_PROXY names other proxies: then their X-Forwarded-For is the client', async () => {
  process.env.TRUST_PROXY = '198.51.100.0/24, loopback';
  let overridden;
  try {
    overridden = (await createServer()).app;
  } finally {
    delete process.env.TRUST_PROXY;
  }
  assert.deepEqual(overridden.get('trust proxy fn')('198.51.100.71', 0), true, 'the named range is trusted');
  const { peerServer, peerBase } = await listenAsPeer(overridden, '198.51.100.71');
  try {
    const lines = await captureLog(async () => {
      assert.equal((await peerLogin(peerBase, '203.0.113.201')).status, 401);
    });
    assert.ok(lines.some((line) => line.endsWith('auth.failed ip=203.0.113.201')), lines.join('\n'));
  } finally {
    peerServer.close();
  }
});

await check('trustProxySetting: express\'s forms from TRUST_PROXY', async () => {
  const { trustProxySetting } = await import('../server/config.js');
  assert.equal(trustProxySetting(undefined, true), 'loopback', 'production default');
  assert.equal(trustProxySetting(undefined, false), false, 'development default');
  assert.equal(trustProxySetting('', true), 'loopback', 'empty is unset');
  assert.equal(trustProxySetting('2', true), 2, 'a number of hops');
  assert.equal(trustProxySetting('false', true), false);
  assert.equal(trustProxySetting('true', true), true);
  assert.equal(trustProxySetting('loopback, 10.0.0.0/8', true), 'loopback, 10.0.0.0/8');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
process.exit(process.exitCode || 0);
