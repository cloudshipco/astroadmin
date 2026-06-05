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
 */

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { config } from '../config.js';
import { loadSchemas } from './collections.js';
import { upsertEntry, computeDigest, countAll, getMeta, setMeta } from './db.js';

const CONTENT_EXTENSIONS = ['.md', '.mdx', '.json'];

/**
 * Split a filename (without extension) into base slug + locale, honouring the
 * site's i18n config (e.g. "home.fr" -> { slug: "home", locale: "fr" }).
 */
function splitLocale(nameWithoutExt, i18nConfig) {
  if (i18nConfig?.enabled && Array.isArray(i18nConfig.locales) && i18nConfig.locales.length > 0) {
    const pattern = new RegExp(`\\.(${i18nConfig.locales.join('|')})$`, 'i');
    const match = nameWithoutExt.match(pattern);
    if (match) {
      return { slug: nameWithoutExt.replace(pattern, ''), locale: match[1] };
    }
  }
  return { slug: nameWithoutExt, locale: null };
}

/**
 * Import a glob (directory) collection: src/content/<name>/*.{md,mdx,json}.
 */
async function importGlobCollection(name, i18nConfig) {
  const dir = path.join(config.paths.content, name);

  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return 0; // Collection has no directory yet — nothing to import.
  }

  let imported = 0;
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!CONTENT_EXTENSIONS.includes(ext)) continue; // skip .bak etc.

    const nameWithoutExt = path.basename(file, ext);
    const { slug, locale } = splitLocale(nameWithoutExt, i18nConfig);
    const raw = await fs.readFile(path.join(dir, file), 'utf-8');

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
    upsertEntry({
      collection: name,
      slug,
      locale,
      type,
      data: dataJson,
      body,
      position: null,
      digest: computeDigest(dataJson, body),
    });
    imported++;
  }

  return imported;
}

/**
 * Import a file() collection: a single JSON array of objects.
 */
async function importFileCollection(name, loaderFilePath) {
  const fullPath = path.join(config.paths.projectRoot, loaderFilePath);

  let raw;
  try {
    raw = await fs.readFile(fullPath, 'utf-8');
  } catch {
    return 0;
  }

  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) return 0;

  let imported = 0;
  arr.forEach((item, index) => {
    const slug = item.id || item.slug || String(index);
    const data = { ...item, id: slug };
    const dataJson = JSON.stringify(data);
    upsertEntry({
      collection: name,
      slug,
      locale: null,
      type: 'data',
      data: dataJson,
      body: null,
      position: index,
      digest: computeDigest(dataJson, null),
    });
    imported++;
  });

  return imported;
}

/**
 * Import every configured collection's files into the content database.
 * @param {object} [options]
 * @param {object} [options.i18n] - i18n config override (defaults to config.i18n)
 * @returns {Promise<{total: number, collections: Record<string, number>}>}
 */
export async function importFiles({ i18n } = {}) {
  const schemas = await loadSchemas();
  const i18nConfig = i18n || config.i18n || { enabled: false, locales: [] };

  const summary = { total: 0, collections: {} };

  for (const [name, schema] of Object.entries(schemas)) {
    const imported =
      schema.loaderType === 'file' && schema.loaderFilePath
        ? await importFileCollection(name, schema.loaderFilePath)
        : await importGlobCollection(name, i18nConfig);

    summary.collections[name] = imported;
    summary.total += imported;
  }

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
    if (!config.database?.autoImportOnEmpty) return { imported: false };
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
