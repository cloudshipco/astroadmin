/**
 * Preview navigation -> "View live site" link, with and without a base path.
 *
 * The preview iframe reports window.location.pathname, which INCLUDES the
 * preview's base path (an Astro site with base '/site', previewed at
 * PREVIEW_URL=http://localhost:4321/site, reports '/site/about/'). The live
 * link helper takes a SITE-relative path and adds publicUrl's base itself, so
 * passing the raw pathname doubled the base: https://example.com/site/site/about/.
 *
 * Runs the real message listener and setLivePagePath from dashboard.js (the
 * dashboard touches the DOM at import, so they are lifted out of the source as
 * tests/focus-editor-field.test.js does) with the real liveSiteHref and
 * preview sync (ui/preview-sync.js), against a stubbed window and document.
 *
 * Run: bun tests/preview-live-link.test.js
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { liveSiteHref } from '../ui/live-url.js';
import { createPreviewSync } from '../ui/preview-sync.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(dir, '../ui/dashboard.js'), 'utf8');

const listenerSrc = src.match(/window\.addEventListener\('message', \(event\) => \{[\s\S]*?\n\}\);/)?.[0];
assert.ok(listenerSrc, 'message listener not found in dashboard.js');
const setLiveSrc = src.match(/function setLivePagePath\(pagePath\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(setLiveSrc, 'setLivePagePath not found in dashboard.js');
const previewOriginSrc = src.match(/function previewOrigin\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(previewOriginSrc, 'previewOrigin not found in dashboard.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.error(`❌ ${name}\n   ${e.message}`); }
}

const PAGES = [
  { collection: 'pages', slug: 'home' },
  { collection: 'pages', slug: 'about' },
  { collection: 'pages', slug: 'contact' },
];

// Deliver one pageNavigation from the preview iframe to the real listener.
// Returns the live link's href and any entry the editor was told to load.
function navigate({ previewUrl, publicUrl, pathname, current = { collection: 'pages', slug: 'about' } }) {
  const previewWindow = {};
  const link = { hidden: true, href: undefined, removeAttribute() { this.href = undefined; } };
  const loads = [];
  let handler = null;
  const windowStub = { addEventListener: (type, fn) => { if (type === 'message') handler = fn; } };
  const documentStub = {
    getElementById: (id) => {
      if (id === 'previewFrame') return { contentWindow: previewWindow };
      if (id === 'viewLiveBtn') return link;
      return null;
    },
  };
  // Every helper and module variable the listener's pageNavigation branch reaches.
  const preamble = `
    let livePagePath = null;
    let lastPreviewScrollY = 0;
    let currentCollection = current.collection;
    let currentSlug = current.slug;
    const allPages = PAGES, allCollections = [], collectionOrder = [];
    const location = { href: 'http://localhost:4000/' };
    const previewSync = createPreviewSync(() => ({
      previewUrl, entries: allPages, collections: allCollections, collectionOrder,
      i18n: { enabled: false }, locale: null, selectedBlock: null,
    }));
    const openEntryRef = () => ({ collection: currentCollection, slug: currentSlug });
    function focusEditorField() {}
    function loadEntry(collection, slug) { loads.push(collection + '/' + slug); }
  `;
  new Function(
    'window', 'document', 'previewUrl', 'publicUrl', 'current', 'PAGES', 'loads',
    'liveSiteHref', 'createPreviewSync',
    `${preamble}\n${previewOriginSrc}\n${setLiveSrc}\n${listenerSrc}`,
  )(windowStub, documentStub, previewUrl, publicUrl, current, PAGES, loads, liveSiteHref, createPreviewSync);
  assert.ok(handler, 'listener did not register');
  handler({ source: previewWindow, origin: new URL(previewUrl).origin, data: { type: 'pageNavigation', pathname } });
  return { href: link.href, hidden: link.hidden, loads };
}

const noBase = { previewUrl: 'http://localhost:4321', publicUrl: 'https://example.com' };
const withBase = { previewUrl: 'http://localhost:4321/site', publicUrl: 'https://example.com/site' };

check('no base: preview path maps straight onto the public site (control)', () => {
  assert.strictEqual(navigate({ ...noBase, pathname: '/about/' }).href, 'https://example.com/about/');
  assert.strictEqual(navigate({ ...noBase, pathname: '/' }).href, 'https://example.com/');
});
check('no base: navigating to another page opens its entry (control)', () => {
  assert.deepStrictEqual(navigate({ ...noBase, pathname: '/contact/' }).loads, ['pages/contact']);
});
check('base path: the preview base is not doubled in the live link', () => {
  assert.strictEqual(navigate({ ...withBase, pathname: '/site/about/' }).href, 'https://example.com/site/about/');
  assert.strictEqual(navigate({ ...withBase, pathname: '/site/about' }).href, 'https://example.com/site/about');
});
check('base path: the preview base root is the site root', () => {
  assert.strictEqual(navigate({ ...withBase, pathname: '/site/' }).href, 'https://example.com/site/');
  assert.strictEqual(navigate({ ...withBase, pathname: '/site' }).href, 'https://example.com/site/');
});
check('base path: navigating to another page opens its entry', () => {
  assert.deepStrictEqual(navigate({ ...withBase, pathname: '/site/contact/' }).loads, ['pages/contact']);
});
check('different preview and public bases: the preview base is swapped for the public one', () => {
  const href = navigate({ previewUrl: 'http://localhost:4321/preview', publicUrl: 'https://example.com/site', pathname: '/preview/about/' }).href;
  assert.strictEqual(href, 'https://example.com/site/about/');
});
check('base path: a path outside the preview base is ignored, not linked', () => {
  const result = navigate({ ...withBase, pathname: '/elsewhere/about/' });
  assert.strictEqual(result.href, undefined);
  assert.deepStrictEqual(result.loads, []);
  // "/sitemap" shares the "/site" prefix but is not under the base.
  assert.strictEqual(navigate({ ...withBase, pathname: '/sitemap/' }).href, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
