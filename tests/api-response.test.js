/**
 * The dashboard reads /api bodies through ui/api-response.js `readJson`.
 *
 * A heavy editing session once hit the rate limit and the editor showed
 * "Failed to load entry: Unexpected token 'T', "Too many r"... is not valid
 * JSON", because the limiter answered in plain text and the dashboard parsed
 * every body as JSON. Now:
 *
 * - a 429 throws a readable "Too many requests, try again in N minutes.",
 *   from the admin's JSON body or, for a plain-text or HTML 429 (nginx's own
 *   login limit), from Retry-After;
 * - any other body that is not JSON (a proxy's error page) throws a readable
 *   error, not a SyntaxError;
 * - a JSON error body (a 401, a 400) is still returned for the caller to read;
 * - no file in ui/ calls `.json()` on a response itself.
 *
 *   bun tests/api-response.test.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { readJson, tooManyRequestsMessage, failureText, ApiResponseError } from '../ui/api-response.js';

const repoRoot = path.resolve(import.meta.dir, '..');

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

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const text = (status, body, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });

async function thrown(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a throw');
}

console.log('\n🧪 Reading /api responses in the dashboard\n' + '='.repeat(40));

await check('the old plain-text 429 body is what broke the dashboard (control)', async () => {
  const error = await thrown(text(429, 'Too many requests, please try again later.').json());
  assert.ok(error instanceof SyntaxError, String(error));
});

await check('a plain-text 429 throws a readable message from Retry-After', async () => {
  const error = await thrown(readJson(text(429, 'Too many requests, please try again later.', { 'Retry-After': '600' })));
  assert.ok(error instanceof ApiResponseError);
  assert.equal(error.rateLimited, true);
  assert.equal(error.message, 'Too many requests, try again in 10 minutes.');
});

await check("the admin's JSON 429 throws its own message", async () => {
  const body = { error: 'Too many requests, try again in 1 minute.', message: 'Too many requests, try again in 1 minute.', retryAfter: 42 };
  const error = await thrown(readJson(json(429, body, { 'Retry-After': '42' })));
  assert.equal(error.rateLimited, true);
  assert.equal(error.message, 'Too many requests, try again in 1 minute.');
});

await check("nginx's 429 page with no Retry-After still reads well", async () => {
  const error = await thrown(readJson(text(429, '<html><body>429 Too Many Requests</body></html>')));
  assert.equal(error.message, 'Too many requests, try again in a few minutes.');
});

await check('a proxy error page throws a readable error, not a SyntaxError', async () => {
  const error = await thrown(readJson(new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'text/html' } })));
  assert.ok(error instanceof ApiResponseError);
  assert.equal(error.rateLimited, false);
  assert.equal(error.message, 'The server answered 502 Bad Gateway instead of data.');
});

await check('JSON bodies come back whatever the status', async () => {
  assert.deepEqual(await readJson(json(200, { success: true })), { success: true });
  assert.deepEqual(await readJson(json(401, { error: 'Authentication required' })), { error: 'Authentication required' });
});

await check('tooManyRequestsMessage rounds up to whole minutes, and reads an HTTP date', () => {
  assert.equal(tooManyRequestsMessage('1'), 'Too many requests, try again in 1 minute.');
  assert.equal(tooManyRequestsMessage('61'), 'Too many requests, try again in 2 minutes.');
  const now = Date.parse('2026-10-18T12:00:00Z');
  assert.equal(tooManyRequestsMessage('Sun, 18 Oct 2026 12:05:00 GMT', now), 'Too many requests, try again in 5 minutes.');
  assert.equal(tooManyRequestsMessage(null), 'Too many requests, try again in a few minutes.');
});

await check('failureText adds the reason only for a rate limit', () => {
  const limited = new ApiResponseError('Too many requests, try again in 3 minutes.', { status: 429, rateLimited: true });
  assert.equal(failureText('Failed to save changes', limited), 'Failed to save changes: Too many requests, try again in 3 minutes.');
  assert.equal(failureText('Failed to save changes', new Error('boom')), 'Failed to save changes');
});

await check('no file in ui/ parses a response body itself', () => {
  const offenders = [];
  for (const name of fs.readdirSync(path.join(repoRoot, 'ui'))) {
    if (!/\.(js|html)$/.test(name) || name === 'api-response.js') continue;
    const source = fs.readFileSync(path.join(repoRoot, 'ui', name), 'utf8');
    source.split('\n').forEach((line, index) => {
      if (/\.json\(\)/.test(line)) offenders.push(`ui/${name}:${index + 1}: ${line.trim()}`);
    });
  }
  // Positive control: the sweep sees the helper's own call.
  assert.match(fs.readFileSync(path.join(repoRoot, 'ui/api-response.js'), 'utf8'), /\.json\(\)/);
  assert.deepEqual(offenders, []);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
