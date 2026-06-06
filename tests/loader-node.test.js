/**
 * Loader fallback test — Node runtime (better-sqlite3 driver path).
 *
 * The content-layer loader normally reads via Bun's `bun:sqlite`, but a site
 * may build under Node (Netlify/CI). This test seeds a temp content.db with
 * better-sqlite3, then drives the loader's load() UNDER NODE and asserts it
 * reads the rows — proving the non-Bun driver works without bun:sqlite.
 *
 * Run with:  node tests/loader-node.test.js
 * Skips cleanly (exit 0) if better-sqlite3 is not installed.
 */

import assert from 'assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

if (process.versions.bun) {
  console.log('⏭  Running under Bun — the Node fallback test is a no-op here.');
  process.exit(0);
}

let Database;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch {
  console.log('⏭  better-sqlite3 not installed — skipping Node loader fallback test.');
  process.exit(0);
}

// --- Seed a throwaway content.db with the production schema, via better-sqlite3 ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-loader-node-'));
const dbPath = path.join(dir, 'content.db');

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE entries (
    collection TEXT NOT NULL,
    slug       TEXT NOT NULL,
    locale     TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL,
    data       TEXT NOT NULL,
    body       TEXT,
    position   INTEGER,
    digest     TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection, slug, locale)
  )
`);
const insert = db.prepare(`
  INSERT INTO entries
    (collection, slug, locale, type, data, body, position, digest, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insert.run('pages', 'home', '', 'content', JSON.stringify({ title: 'Home' }), '# Welcome', 0, 'd1', 0, 0);
insert.run('pages', 'about', '', 'content', JSON.stringify({ title: 'About' }), 'About us', 1, 'd2', 0, 0);
insert.run('pages', 'home', 'fr', 'content', JSON.stringify({ title: 'Accueil' }), 'Bonjour', 0, 'd3', 0, 0);
insert.run('settings', 'site', '', 'data', JSON.stringify({ siteName: 'Acme' }), null, null, 'd4', 0, 0);
db.close();

// --- Import the loader AFTER seeding (it must not statically import bun:sqlite) ---
const { astroadminLoader } = await import('../loader/index.js');

function makeContext() {
  const entries = new Map();
  return {
    store: {
      set: (entry) => entries.set(entry.id, entry),
      clear: () => entries.clear(),
    },
    parseData: async ({ data }) => data,
    generateDigest: (data) => `digest:${JSON.stringify(data)}`,
    renderMarkdown: async (body) => ({ html: `<p>${body}</p>`, metadata: {} }),
    logger: { info: () => {}, warn: () => {}, error: (m) => console.error(m) },
    config: { root: new URL(`file://${dir}/`) },
    _entries: entries,
  };
}

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

console.log('\n🧪 Content-layer loader (Node / better-sqlite3)\n' + '='.repeat(40));

await check('reads content entries via the Node driver', async () => {
  const ctx = makeContext();
  await astroadminLoader({ collection: 'pages', dbPath }).load(ctx);

  const ids = [...ctx._entries.keys()].sort();
  assert.deepEqual(ids, ['about', 'home', 'home/fr'], 'one id per slug+locale');

  const home = ctx._entries.get('home');
  assert.equal(home.data.title, 'Home', 'data parsed');
  assert.equal(home.body, '# Welcome', 'body present');
  assert.ok(home.rendered?.html.includes('Welcome'), 'rendered html present');
});

await check('data collection has no rendered body', async () => {
  const ctx = makeContext();
  await astroadminLoader({ collection: 'settings', dbPath }).load(ctx);

  const site = ctx._entries.get('site');
  assert.equal(site.data.siteName, 'Acme', 'data round-trips');
  assert.equal(site.rendered, undefined, 'no rendered for data entry');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
