/**
 * File → database importer (Phase 7)
 *
 * One-time, non-destructive import of existing src/content files into the
 * SQLite content store. Self-contained (fs + gray-matter); writes through the
 * db.js upsert so re-running is idempotent (upsert by collection+slug+locale).
 *
 * Run via `astroadmin migrate`, or automatically on first boot when the DB is
 * empty (config.database.autoImportOnEmpty).
 *
 * Run this BEFORE switching a site's content.config.ts to astroadminLoader —
 * while the config still declares glob()/file() loaders — so collection
 * loader types and file paths are still discoverable.
 *
 * Glob base/pattern resolution and locale splitting are shared with the file
 * store via glob-files.js.
 */

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { getConfig } from '../config.js';
import { loadSchemas } from './collections.js';
import { activeStoreMode } from './content-store.js';
import { upsertEntry, computeDigest, countAll, getMeta, setMeta, withTransaction } from './db.js';
import {
  getGlobBaseDirectory,
  getGlobPatterns,
  findMatchingFiles,
  splitLocale,
  resolveProjectPath,
} from './glob-files.js';

/**
 * Collect entries for a glob (directory) collection using the loader's base
 * and pattern metadata when available.
 */
async function collectGlobCollectionEntries(name, schema, i18nConfig) {
  const baseDirectory = getGlobBaseDirectory(name, schema);
  const patterns = getGlobPatterns(schema);
  const files = await findMatchingFiles(baseDirectory, patterns);
  const entries = [];

  for (const relativeFilePath of files) {
    const ext = path.extname(relativeFilePath).toLowerCase();
    const nameWithoutExt = relativeFilePath.slice(0, -ext.length);
    const { slug, locale } = splitLocale(nameWithoutExt, i18nConfig);
    const raw = await fs.readFile(path.join(baseDirectory, relativeFilePath), 'utf-8');

    let type;
    let data;
    let body;
    if (ext === '.json') {
      type = 'data';
      data = JSON.parse(raw);
      body = null;
    } else {
      type = 'content';
      const parsed = matter(raw);
      data = parsed.data;
      body = parsed.content;
    }

    const dataJson = JSON.stringify(data);
    entries.push({
      collection: name,
      slug,
      locale,
      type,
      data: dataJson,
      body,
      position: null,
      digest: computeDigest(dataJson, body),
    });
  }

  return entries;
}

/**
 * Collect entries for a file() collection: a single JSON array of objects.
 */
async function collectFileCollectionEntries(name, loaderFilePath) {
  const fullPath = resolveProjectPath(loaderFilePath);

  let raw;
  try {
    raw = await fs.readFile(fullPath, 'utf-8');
  } catch {
    return [];
  }

  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) return [];

  return arr.map((item, index) => {
    const slug = item.id || item.slug || String(index);
    const data = { ...item, id: slug };
    const dataJson = JSON.stringify(data);
    return {
      collection: name,
      slug,
      locale: null,
      type: 'data',
      data: dataJson,
      body: null,
      position: index,
      digest: computeDigest(dataJson, null),
    };
  });
}

/**
 * Import every configured collection's files into the content database.
 * @param {object} [options]
 * @param {object} [options.i18n] - i18n config override (defaults to the merged config's i18n)
 * @returns {Promise<{total: number, collections: Record<string, number>}>}
 */
export async function importFiles({ i18n } = {}) {
  const schemas = await loadSchemas();
  // Merged config — i18n is only enableable via astroadmin.config.js.
  const i18nConfig = i18n || (await getConfig()).i18n || { enabled: false, locales: [] };

  const summary = { total: 0, collections: {} };
  const pendingEntries = [];

  for (const [name, schema] of Object.entries(schemas)) {
    const entries =
      schema.loaderType === 'file' && schema.loaderFilePath
        ? await collectFileCollectionEntries(name, schema.loaderFilePath)
        : await collectGlobCollectionEntries(name, schema, i18nConfig);

    pendingEntries.push(...entries);
    summary.collections[name] = entries.length;
    summary.total += entries.length;
  }

  withTransaction(() => {
    for (const entry of pendingEntries) {
      upsertEntry(entry);
    }
  });

  return summary;
}

/**
 * Auto-import existing src/content on first boot, when enabled and the DB is
 * empty. Marked done in astroadmin_meta so it never clobbers later edits even
 * if the DB is emptied. Non-fatal on error.
 * @returns {Promise<{imported: boolean, summary?: object}>}
 */
export async function maybeAutoImport() {
  try {
    // Only meaningful for the db store; in files mode there is no DB to seed
    // (and touching it would create a stray content.db).
    if ((await activeStoreMode()) !== 'db') return { imported: false };

    const fullConfig = await getConfig();
    if (!fullConfig.database?.autoImportOnEmpty) return { imported: false };
    if (getMeta('imported') === '1') return { imported: false };
    if (countAll() > 0) return { imported: false };

    const summary = await importFiles();
    setMeta('imported', '1');

    if (summary.total > 0) {
      console.log(`📥 Auto-imported ${summary.total} entries from src/content into the content store`);
    }
    return { imported: summary.total > 0, summary };
  } catch (error) {
    console.warn(`⚠️  Auto-import skipped: ${error.message}`);
    return { imported: false };
  }
}
