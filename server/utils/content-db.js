/**
 * SQLite content store (shelved default; selected via config.content.store = 'db')
 *
 * Content lives in the SQLite content store (server/utils/db.js); the Astro
 * site reads the same database at build time via the content-layer loader
 * (loader/index.js). This is the v1.0.0 DB-backed path, retained behind the
 * `content.store` flag for the future SaaS/DB direction. The default store is
 * file-based (content-files.js).
 *
 * Public interface matches content-files.js so content-store.js can dispatch:
 *   readContent / writeContent / deleteContent / contentExists /
 *   getAvailableLocales / listSlugs / distinctCollections / getCollectionType
 *
 * `filePath` here is a synthetic logical id kept for API/UI compatibility.
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
  listSlugs as dbListSlugs,
  distinctCollections as dbDistinctCollections,
  getCollectionTypeFromDb,
} from './db.js';

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

function sanitizePath(userPath) {
  const normalized = path.normalize(userPath);
  if (normalized.includes('..')) {
    throw new Error('Invalid path: directory traversal not allowed');
  }
  return normalized;
}

function logicalId(collection, slug, locale) {
  return `db:${collection}/${slug}${locale ? `.${locale}` : ''}`;
}

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

export async function contentExists(collection, slug, locale = null) {
  const { isFile } = await getCollectionLoaderInfo(collection);
  const effectiveLocale = isFile ? null : locale;
  return entryExists(collection, slug, effectiveLocale);
}

export async function getAvailableLocales(collection, baseSlug, configuredLocales) {
  const present = listLocales(collection, baseSlug);
  return configuredLocales.filter((locale) => present.includes(locale));
}

// Listing interface (db.js is synchronous; wrapped async to match content-files.js).
export async function listSlugs(collection) {
  return dbListSlugs(collection);
}

export async function distinctCollections() {
  return dbDistinctCollections();
}

export async function getCollectionType(collection) {
  return getCollectionTypeFromDb(collection);
}
