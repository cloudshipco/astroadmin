/**
 * Content-layer loader tests (Chunk ② — Astro 6 loader)
 *
 * Seeds a throwaway content.db via the server's write path, then drives the
 * loader's load() with a mock Astro LoaderContext and asserts the entries it
 * pushes into the store.
 *
 * Run with:
 *   ASTROADMIN_DB=/tmp/aa-loader.db ASTROADMIN_PROJECT_ROOT=/tmp/aa-loader-root \
 *     bun tests/loader.test.js
 */

import assert from 'assert';
import { pathToFileURL } from 'url';
import { writeContent } from '../server/utils/content.js';
import { astroadminLoader } from '../loader/index.js';

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

// --- Seed the content store (treated as glob collections; no Astro config) ---
await writeContent('pages', 'home', { data: { title: 'Home' }, body: '# Welcome', type: 'content' }, null);
await writeContent('pages', 'about', { data: { title: 'About' }, body: 'About us', type: 'content' }, null);
await writeContent('pages', 'home', { data: { title: 'Accueil' }, body: 'Bonjour', type: 'content' }, 'fr');
await writeContent('settings', 'site', { data: { siteName: 'Acme' }, type: 'data' }, null);

// --- Minimal mock LoaderContext ---
function makeContext() {
  const entries = new Map();
  const root = pathToFileURL(`${process.env.ASTROADMIN_PROJECT_ROOT}/`);
  return {
    store: {
      set: (entry) => entries.set(entry.id, entry),
      clear: () => entries.clear(),
    },
    parseData: async ({ data }) => data, // passthrough (no schema validation here)
    generateDigest: (data) => `digest:${JSON.stringify(data)}`,
    renderMarkdown: async (body) => ({ html: `<p>${body}</p>`, metadata: {} }),
    logger: { info: () => {}, warn: () => {}, error: (m) => console.error(m) },
    config: { root },
    _entries: entries,
  };
}

console.log('\n🧪 Content-layer loader\n' + '='.repeat(40));

await check('loads content entries with rendered bodies', async () => {
  const ctx = makeContext();
  const loader = astroadminLoader({ collection: 'pages' });
  await loader.load(ctx);

  const ids = [...ctx._entries.keys()].sort();
  assert.deepEqual(ids, ['about', 'home', 'home/fr'], 'one id per slug+locale');

  const home = ctx._entries.get('home');
  assert.equal(home.data.title, 'Home', 'data parsed');
  assert.equal(home.body, '# Welcome', 'body present');
  assert.ok(home.rendered?.html.includes('Welcome'), 'rendered html present');
  assert.ok(home.digest, 'digest present');

  const fr = ctx._entries.get('home/fr');
  assert.equal(fr.data.title, 'Accueil', 'locale variant distinct');
});

await check('data collection has no rendered body', async () => {
  const ctx = makeContext();
  await astroadminLoader({ collection: 'settings' }).load(ctx);

  const site = ctx._entries.get('site');
  assert.equal(site.data.siteName, 'Acme', 'data round-trips');
  assert.equal(site.body, undefined, 'no body for data entry');
  assert.equal(site.rendered, undefined, 'no rendered for data entry');
});

await check('unknown collection loads nothing (no throw)', async () => {
  const ctx = makeContext();
  await astroadminLoader({ collection: 'nope' }).load(ctx);
  assert.equal(ctx._entries.size, 0, 'empty store');
});

await check('missing collection option throws', async () => {
  assert.throws(() => astroadminLoader({}), /collection.*required/i);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(0);
