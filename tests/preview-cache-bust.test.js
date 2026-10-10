/**
 * Cache-busted preview URLs (ui/cache-bust.js). The dashboard reloads and
 * polls preview pages with a `t=<timestamp>` parameter. It used to append
 * `'?t=' + Date.now()` by hand, so a URL that already had a query (the
 * component preview's `?field=members`) became `?field=members?t=...`: the
 * field name was lost and the preview rendered an empty block.
 *
 *   bun tests/preview-cache-bust.test.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { withCacheBuster } from '../ui/cache-bust.js';

const repoRoot = path.resolve(import.meta.dir, '..');
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${error.message}`);
  }
}

check('a URL with a query keeps its parameters and gains t', () => {
  const busted = withCacheBuster('http://localhost:4321/component-preview/team/ada?field=members', 123);
  const url = new URL(busted);
  assert.equal(url.searchParams.get('field'), 'members', busted);
  assert.equal(url.searchParams.get('t'), '123', busted);
  assert.equal((busted.match(/\?/g) || []).length, 1, busted);
});

check('a URL without a query gains ?t=', () => {
  assert.equal(withCacheBuster('http://localhost:4321/about', 5), 'http://localhost:4321/about?t=5');
});

check('an existing t is replaced, and a hash stays last', () => {
  assert.equal(withCacheBuster('http://localhost:4321/a?t=1#top', 9), 'http://localhost:4321/a?t=9#top');
});

check('a root-relative URL stays root-relative', () => {
  assert.equal(withCacheBuster('/blog/post?x=1', 7), '/blog/post?x=1&t=7');
});

check('dashboard.js adds no cache-buster by hand', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
  assert.ok(!/['"`]\?t=/.test(source), "ui/dashboard.js still appends '?t=' by string concatenation");
});

// The dashboard's real preview functions, extracted from ui/dashboard.js (it
// boots on import) and run with their globals stubbed: the URLs they load and
// poll must carry t AND keep the component preview's ?field=. The source
// check above passes with every withCacheBuster call removed; these do not.
const dashboardSource = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
function extractFunction(name) {
  const source = dashboardSource.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(source, `${name} not found in ui/dashboard.js`);
  return source;
}
const COMPONENT_PREVIEW = 'http://localhost:4321/component-preview/team/ada?field=members';
function assertBusted(url, label) {
  assert.ok(url, `${label}: no URL was requested`);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/component-preview/team/ada', `${label}: ${url}`);
  assert.equal(parsed.searchParams.get('field'), 'members', `${label} lost ?field=: ${url}`);
  assert.match(parsed.searchParams.get('t') || '', /^\d+$/, `${label} has no t cache-buster: ${url}`);
}
function previewDocument(loaded) {
  const element = () => ({
    style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, removeEventListener() {},
    contentWindow: { location: { replace: (url) => loaded.push(url) }, postMessage() {} },
  });
  const elements = { previewFrame: element(), previewPlaceholder: element(), previewControls: element() };
  return { getElementById: (id) => elements[id] || null };
}
const quietConsole = { log() {}, warn() {}, error() {} };

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${error.message}`);
  }
}

await checkAsync('updatePreview loads the iframe at a cache-busted URL that keeps ?field=', async () => {
  const loaded = [];
  const updatePreview = new Function('document', 'getPreviewPageUrl', 'escapeHtml', 'currentCollection',
    'lastPreviewScrollY', 'withCacheBuster', 'requestAnimationFrame', 'setTimeout', 'console',
    `${extractFunction('updatePreview')}\nreturn updatePreview;`)(
    previewDocument(loaded), () => COMPONENT_PREVIEW, (text) => text, 'team', 0, withCacheBuster,
    () => {}, () => 0, quietConsole);
  await updatePreview();
  assert.equal(loaded.length, 1, `positive control: one load (${loaded.join(', ')})`);
  assertBusted(loaded[0], 'updatePreview');
});

await checkAsync('updateVirtualPagePreview loads a cache-busted URL', async () => {
  const loaded = [];
  const updateVirtualPagePreview = new Function('document', 'previewUrl', 'withCacheBuster',
    `${extractFunction('updateVirtualPagePreview')}\nreturn updateVirtualPagePreview;`)(
    previewDocument(loaded), 'http://localhost:4321', withCacheBuster);
  updateVirtualPagePreview({ url: '/component-preview/team/ada?field=members' });
  assert.equal(loaded.length, 1, `positive control: one load (${loaded.join(', ')})`);
  assertBusted(loaded[0], 'updateVirtualPagePreview');
});

await checkAsync('waitForContentChange polls cache-busted URLs that keep ?field=', async () => {
  const requested = [];
  const fetchStub = async (url) => {
    requested.push(url);
    return { text: async () => '<p>changed</p>' };
  };
  const quickHash = new Function(`${extractFunction('quickHash')}\nreturn quickHash;`)();
  const waitForContentChange = new Function('getPreviewPageUrl', 'fetch', 'quickHash', 'withCacheBuster', 'console',
    `${extractFunction('waitForContentChange')}\nreturn waitForContentChange;`)(
    () => COMPONENT_PREVIEW, fetchStub, quickHash, withCacheBuster, quietConsole);
  const result = await waitForContentChange(quickHash('<p>before</p>'), 1000);
  assert.equal(result.changed, true, `positive control: the change was seen (${JSON.stringify(result)})`);
  assert.ok(requested.length >= 1, 'positive control: it polled');
  for (const url of requested) assertBusted(url, 'waitForContentChange');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
