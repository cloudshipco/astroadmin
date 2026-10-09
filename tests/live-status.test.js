/**
 * live-status SSRF guard test
 *
 * resolveLiveUrl() appends a client-supplied page path to the admin-configured
 * public origin. It MUST refuse any path that would change the origin (an SSRF
 * vector: //evil.com, http://internal, etc.) while allowing normal same-site
 * paths.
 *
 *   bun tests/live-status.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The endpoint reads publicUrl from config, which reads PUBLIC_URL when it is
// first imported, so the env is set before publish.js is loaded. A fresh empty
// project root means no astroadmin.config.js can override it.
process.env.ASTROADMIN_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'astroadmin-live-status-'));
process.env.PUBLIC_URL = 'https://example.com';
const { resolveLiveUrl, liveStatusHandler } = await import('../server/api/publish.js');

const base = 'https://example.com';
let passed = 0;
class CheckFailed extends Error {}
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { console.error(`❌ ${name}\n   ${e.stack || e.message}`); throw new CheckFailed(name); }
}

// Drive the real handler with a stubbed fetch, recording every URL it fetches.
async function callLiveStatus(requestedPath) {
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { fetched.push(String(url)); return new Response('<html>live</html>', { status: 200 }); };
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return res; },
    json(body) { response.body = body; return res; },
  };
  try {
    await liveStatusHandler({ query: { path: requestedPath } }, res);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { ...response, fetched };
}

try {
  await check('root path resolves same-origin', () => {
    assert.strictEqual(resolveLiveUrl(base, '/').href, 'https://example.com/');
  });
  await check('normal page path resolves same-origin', () => {
    assert.strictEqual(resolveLiveUrl(base, '/about').href, 'https://example.com/about');
  });
  await check('empty/undefined path defaults to root', () => {
    assert.strictEqual(resolveLiveUrl(base, undefined).href, 'https://example.com/');
  });
  await check('protocol-relative //host is rejected', () => {
    assert.throws(() => resolveLiveUrl(base, '//evil.com/x'), /public site/);
  });
  await check('absolute http URL is rejected', () => {
    assert.throws(() => resolveLiveUrl(base, 'http://evil.com'), /public site/);
  });
  await check('absolute https URL to another host is rejected', () => {
    assert.throws(() => resolveLiveUrl(base, 'https://evil.com/x'), /public site/);
  });
  await check('dot-dot traversal stays within origin (normalized, allowed)', () => {
    // new URL normalizes ../ but can't leave the origin.
    assert.strictEqual(resolveLiveUrl(base, '/a/../../etc').origin, 'https://example.com');
  });
  await check('base with a subpath still guards origin', () => {
    assert.strictEqual(resolveLiveUrl('https://example.com/site', '/page').origin, 'https://example.com');
    assert.throws(() => resolveLiveUrl('https://example.com/site', 'https://evil.com'), /public site/);
  });

  await check('live-status fetches an ordinary page on the public site (positive control)', async () => {
    const result = await callLiveStatus('/about');
    assert.deepStrictEqual(result.fetched, ['https://example.com/about']);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.reachable, true);
    assert.ok(result.body.hash);
  });
  for (const hostile of ['/.//evil.example/x', '/..//evil.example/x', '/%2e//evil.example/x', '/./\\evil.example',
    '/.\n//evil.example', '//evil.example/x', 'https://evil.example/x']) {
    await check(`live-status refuses ${JSON.stringify(hostile)} without fetching it`, async () => {
      const result = await callLiveStatus(hostile);
      assert.deepStrictEqual(result.fetched, [], `fetched ${result.fetched.join(', ')}`);
      assert.strictEqual(result.statusCode, 400);
      assert.match(result.body.error, /public site/);
    });
  }

  console.log(`\n${passed} checks passed`);
} catch (e) {
  if (!(e instanceof CheckFailed)) console.error(e);
  process.exitCode = 1;
}
