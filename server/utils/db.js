/**
 * Content database (SQLite via bun:sqlite)
 *
 * Single source of truth for content entries. Mirrors the pattern in
 * server/session-store.js (Database with WAL, a prepared-statement object).
 *
 * The site's Astro content-layer loader (loader/index.js) reads this same file
 * concurrently with server writes, so WAL mode matters.
 *
 * Locale convention: callers pass `null` for locale-less entries; at this
 * boundary `null`/`undefined` map to the empty string `''` so locale can sit
 * inside the primary key. Rows are mapped back to `null` on the way out.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

let db = null;
let stmts = null;

/**
 * Resolve the database file path from config (env-overridable via ASTROADMIN_DB).
 */
function getDbPath() {
  return (
    config.database?.path ||
    path.join(config.paths.projectRoot, '.astroadmin/content.db')
  );
}

/**
 * Map a caller-facing locale (null/undefined = none) to its stored form.
 */
function localeToDb(locale) {
  return locale === null || locale === undefined ? '' : locale;
}

/**
 * Map a stored locale back to its caller-facing form ('' = none -> null).
 */
function localeFromDb(value) {
  return value === '' ? null : value;
}

/**
 * Open (once) and return the database, creating the schema and prepared
 * statements on first use. Safe to call repeatedly.
 */
export function getDb() {
  if (db) return db;

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_collection ON entries(collection)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS astroadmin_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  stmts = {
    get: db.prepare(
      'SELECT * FROM entries WHERE collection = ? AND slug = ? AND locale = ?'
    ),
    upsert: db.prepare(`
      INSERT INTO entries
        (collection, slug, locale, type, data, body, position, digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, slug, locale) DO UPDATE SET
        type = excluded.type,
        data = excluded.data,
        body = excluded.body,
        position = excluded.position,
        digest = excluded.digest,
        updated_at = excluded.updated_at
    `),
    delete: db.prepare(
      'DELETE FROM entries WHERE collection = ? AND slug = ? AND locale = ?'
    ),
    exists: db.prepare(
      'SELECT 1 FROM entries WHERE collection = ? AND slug = ? AND locale = ? LIMIT 1'
    ),
    listSlugs: db.prepare(
      'SELECT DISTINCT slug FROM entries WHERE collection = ? ORDER BY position, slug'
    ),
    listLocales: db.prepare(
      "SELECT locale FROM entries WHERE collection = ? AND slug = ? AND locale <> ''"
    ),
    maxPosition: db.prepare(
      'SELECT MAX(position) AS max FROM entries WHERE collection = ?'
    ),
    typeForCollection: db.prepare(
      'SELECT type FROM entries WHERE collection = ? LIMIT 1'
    ),
    distinctCollections: db.prepare('SELECT DISTINCT collection FROM entries'),
    listAll: db.prepare(
      'SELECT collection, slug, locale, type, data, body, position FROM entries ORDER BY collection, position, slug, locale'
    ),
    countAll: db.prepare('SELECT COUNT(*) AS count FROM entries'),
    metaGet: db.prepare('SELECT value FROM astroadmin_meta WHERE key = ?'),
    metaSet: db.prepare(
      'INSERT OR REPLACE INTO astroadmin_meta (key, value) VALUES (?, ?)'
    ),
  };

  console.log(`[Content DB] SQLite content store initialized at ${dbPath}`);
  return db;
}

function ensureStmts() {
  if (!stmts) getDb();
  return stmts;
}

/**
 * Compute a stable write-time digest of an entry's content. Stored so the
 * loader can populate Astro's entry digest without recomputing.
 */
export function computeDigest(dataJson, body) {
  return createHash('sha1')
    .update(dataJson)
    .update(body || '')
    .digest('hex');
}

/**
 * Read a single entry row. Returns the raw row (locale mapped back to null) or
 * null if not found.
 */
export function getEntry(collection, slug, locale = null) {
  const row = ensureStmts().get.get(collection, slug, localeToDb(locale));
  if (!row) return null;
  return { ...row, locale: localeFromDb(row.locale) };
}

/**
 * Insert or update an entry.
 * @param {object} entry - { collection, slug, locale, type, data (JSON string), body, position, digest }
 */
export function upsertEntry({
  collection,
  slug,
  locale = null,
  type,
  data,
  body = null,
  position = null,
  digest = null,
}) {
  const now = Date.now();
  ensureStmts().upsert.run(
    collection,
    slug,
    localeToDb(locale),
    type,
    data,
    body,
    position,
    digest,
    now,
    now
  );
}

/**
 * Delete an entry. Returns the number of rows removed.
 */
export function deleteEntry(collection, slug, locale = null) {
  return ensureStmts().delete.run(collection, slug, localeToDb(locale)).changes;
}

/**
 * Whether an entry exists.
 */
export function entryExists(collection, slug, locale = null) {
  return Boolean(ensureStmts().exists.get(collection, slug, localeToDb(locale)));
}

/**
 * Distinct slugs in a collection, ordered by file()-loader position then slug.
 */
export function listSlugs(collection) {
  return ensureStmts()
    .listSlugs.all(collection)
    .map((row) => row.slug);
}

/**
 * Locales present for a given entry (excludes the locale-less '' rows).
 */
export function listLocales(collection, slug) {
  return ensureStmts()
    .listLocales.all(collection, slug)
    .map((row) => row.locale);
}

/**
 * Highest position value in a collection, or null when none set.
 */
export function maxPosition(collection) {
  const row = ensureStmts().maxPosition.get(collection);
  return row?.max ?? null;
}

/**
 * The stored type ('content'|'data') for a collection, inferred from any row.
 */
export function getCollectionTypeFromDb(collection) {
  return ensureStmts().typeForCollection.get(collection)?.type ?? null;
}

/**
 * All collection names that currently have at least one entry.
 */
export function distinctCollections() {
  return ensureStmts()
    .distinctCollections.all()
    .map((row) => row.collection);
}

/**
 * Every entry row (locale mapped back to null), ordered by collection then
 * file()-position then slug. Used by the DB→files exporter.
 */
export function listAllEntries() {
  return ensureStmts()
    .listAll.all()
    .map((row) => ({ ...row, locale: localeFromDb(row.locale) }));
}

/**
 * Total entry count across all collections (used for the empty-DB check).
 */
export function countAll() {
  return ensureStmts().countAll.get().count;
}

/**
 * Read a value from the astroadmin_meta key/value table.
 */
export function getMeta(key) {
  return ensureStmts().metaGet.get(key)?.value ?? null;
}

/**
 * Write a value to the astroadmin_meta key/value table.
 */
export function setMeta(key, value) {
  ensureStmts().metaSet.run(key, String(value));
}

/**
 * Run synchronous database writes atomically. Bun's transaction helper rolls
 * back automatically when the callback throws.
 */
export function withTransaction(callback) {
  const transaction = getDb().transaction(callback);
  return transaction();
}

/**
 * Touch the dev-reload sentinel file. WAL writes don't reliably fire a
 * filesystem `change` event on the .db file, so the loader watches this
 * sentinel instead. Resolves alongside the DB under the project's .astroadmin/.
 */
export function touchSentinel() {
  try {
    const sentinel = path.join(config.paths.projectRoot, '.astroadmin/.touch');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, String(Date.now()));
  } catch (error) {
    // Non-fatal: live-reload is a convenience, not correctness.
    console.warn(`[Content DB] Could not touch reload sentinel: ${error.message}`);
  }
}

/**
 * Close the database (tests / shutdown).
 */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
    stmts = null;
  }
}
