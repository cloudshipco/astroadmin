/**
 * Content utility
 * Read and write content entries.
 *
 * Content is stored in the SQLite content store (server/utils/db.js), not on
 * disk. The Astro site reads the same database at build time via the
 * content-layer loader (loader/index.js).
 *
 * Public signatures and return shapes are preserved from the previous
 * file-backed implementation so server/api/content.js and collections.js keep
 * working unchanged:
 *   - readContent  -> { type, data, body, filePath, locale }
 *   - writeContent -> { filePath, locale }
 *   - deleteContent -> { deleted, locale }
 *   - contentExists -> boolean
 *   - getAvailableLocales -> string[]
 *
 * `filePath` no longer points at a file; it is a synthetic logical id kept for
 * API/UI compatibility.
 */

import path from 'path';
import { loadSchemas } from './collections.js';
import {
  getEntry,
  upsertEntry,
  deleteEntry,
  entryExists,
  listLocales,
  maxPosition,
  computeDigest,
  touchSentinel,
} from './db.js';

/**
 * Look up storage-relevant metadata for a collection from the parsed schema.
 * File collections (Astro's file() loader) are always locale-less and store an
 * `id` field inside their data, matching the previous JSON-array behaviour.
 * @param {string} collection - Collection name
 * @returns {Promise<{isFile: boolean, type?: string}>}
 */
async function getCollectionLoaderInfo(collection) {
  try {
    const schemas = await loadSchemas();
    const schema = schemas[collection];
    return { isFile: schema?.loaderType === 'file', type: schema?.type };
  } catch (error) {
    console.warn(`Could not get loader info for ${collection}:`, error.message);
    return { isFile: false };
  }
}

/**
 * Sanitize a collection/slug value to prevent traversal-style ids.
 * Defense-in-depth: the values are db keys now, not paths, but keep the guard.
 */
function sanitizePath(userPath) {
  const normalized = path.normalize(userPath);

  if (normalized.includes('..')) {
    throw new Error('Invalid path: directory traversal not allowed');
  }

  return normalized;
}

/**
 * Build the synthetic logical id returned as `filePath`.
 */
function logicalId(collection, slug, locale) {
  return `db:${collection}/${slug}${locale ? `.${locale}` : ''}`;
}

/**
 * Read a content entry
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function readContent(collection, slug, locale = null) {
  sanitizePath(collection);
  sanitizePath(slug);

  const { isFile } = await getCollectionLoaderInfo(collection);
  const effectiveLocale = isFile ? null : locale;

  const row = getEntry(collection, slug, effectiveLocale);

  if (!row) {
    const localeHint = effectiveLocale ? ` (${effectiveLocale})` : '';
    throw new Error(`Content not found: ${collection}/${slug}${localeHint}`);
  }

  return {
    type: row.type,
    data: JSON.parse(row.data),
    body: row.body ?? null,
    filePath: logicalId(collection, slug, effectiveLocale),
    locale: effectiveLocale,
  };
}

/**
 * Write content entry
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {object} options - { data, body, type }
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function writeContent(collection, slug, { data, body, type }, locale = null) {
  sanitizePath(collection);
  sanitizePath(slug);

  const { isFile } = await getCollectionLoaderInfo(collection);
  const effectiveLocale = isFile ? null : locale;

  let storedData = data;
  let storedType = type || (isFile ? 'data' : 'content');
  let storedBody = storedType === 'data' ? null : body || '';
  let position = null;

  if (isFile) {
    // File collections store the id inside data and preserve array order.
    storedData = { ...data, id: slug };
    storedType = 'data';
    storedBody = null;

    const existing = getEntry(collection, slug, null);
    position =
      existing && existing.position !== null && existing.position !== undefined
        ? existing.position
        : (maxPosition(collection) ?? -1) + 1;
  }

  const dataJson = JSON.stringify(storedData);
  const digest = computeDigest(dataJson, storedBody);

  upsertEntry({
    collection,
    slug,
    locale: effectiveLocale,
    type: storedType,
    data: dataJson,
    body: storedBody,
    position,
    digest,
  });

  touchSentinel();

  return { filePath: logicalId(collection, slug, effectiveLocale), locale: effectiveLocale };
}

/**
 * Delete content entry
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function deleteContent(collection, slug, locale = null) {
  sanitizePath(collection);
  sanitizePath(slug);

  const { isFile } = await getCollectionLoaderInfo(collection);
  const effectiveLocale = isFile ? null : locale;

  const changes = deleteEntry(collection, slug, effectiveLocale);

  if (changes === 0) {
    const localeHint = effectiveLocale ? ` (${effectiveLocale})` : '';
    throw new Error(`Content not found: ${collection}/${slug}${localeHint}`);
  }

  touchSentinel();

  return { deleted: logicalId(collection, slug, effectiveLocale), locale: effectiveLocale };
}

/**
 * Check if content exists
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function contentExists(collection, slug, locale = null) {
  const { isFile } = await getCollectionLoaderInfo(collection);
  const effectiveLocale = isFile ? null : locale;
  return entryExists(collection, slug, effectiveLocale);
}

/**
 * Get which locales exist for a given entry
 * @param {string} collection - Collection name
 * @param {string} baseSlug - Base slug without locale suffix
 * @param {string[]} configuredLocales - List of configured locales to check
 * @returns {Promise<string[]>} - Array of available locale codes
 */
export async function getAvailableLocales(collection, baseSlug, configuredLocales) {
  const present = listLocales(collection, baseSlug);
  return configuredLocales.filter((locale) => present.includes(locale));
}
