/**
 * File-based content store
 *
 * Reads and writes content as files on disk (markdown with frontmatter for
 * `content` collections, JSON for `data`/`file()` collections), so the site's
 * native Astro loaders (glob()/file()) read them directly and git is the
 * source of truth. This is the default store; the SQLite store (content-db.js)
 * is selected via `config.content.store = 'db'` for the future DB-backed path.
 *
 * Public interface (matches content-db.js so content-store.js can dispatch):
 *   readContent / writeContent / deleteContent / contentExists /
 *   getAvailableLocales / listSlugs / distinctCollections / getCollectionType
 *
 * Glob base/pattern resolution and locale splitting are shared with the
 * importer via glob-files.js.
 */

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { config } from '../config.js';
import { loadSchemas } from './collections.js';
import {
  getGlobBaseDirectory,
  getGlobPatterns,
  findMatchingFiles,
  splitLocale,
  resolveProjectPath,
  CONTENT_EXTENSIONS,
} from './glob-files.js';

/**
 * Defence-in-depth path guard. Slugs/collections become path segments, so
 * reject traversal even though callers are already schema-bounded.
 */
function sanitizePath(userPath) {
  const normalized = path.normalize(userPath);
  if (normalized.includes('..')) {
    throw new Error('Invalid path: directory traversal not allowed');
  }
  return normalized;
}

function getI18n() {
  return config.i18n || { enabled: false, locales: [] };
}

/**
 * Resolve storage info for a collection from its parsed schema.
 * @returns {Promise<{isFile: boolean, filePath?: string, baseDirectory?: string, patterns?: string[], type?: string}>}
 */
async function getCollectionLoaderInfo(collection) {
  let schema = {};
  try {
    const schemas = await loadSchemas();
    schema = schemas[collection] || {};
  } catch (error) {
    // No/partial content config: treat as a default glob collection under
    // src/content/<collection>, matching the db store's tolerance.
    console.warn(`Could not load schemas for ${collection}; treating as glob:`, error.message);
  }

  if (schema.loaderType === 'file' && schema.loaderFilePath) {
    return { isFile: true, filePath: resolveProjectPath(schema.loaderFilePath), type: 'data' };
  }

  return {
    isFile: false,
    baseDirectory: getGlobBaseDirectory(collection, schema),
    patterns: getGlobPatterns(schema),
    type: schema.type || 'content',
  };
}

/** Candidate file paths for a glob entry, in extension preference order. */
function candidatePaths(baseDirectory, slug, locale) {
  const baseSlug = locale ? `${sanitizePath(slug)}.${locale}` : sanitizePath(slug);
  return CONTENT_EXTENSIONS.map((ext) => path.join(baseDirectory, baseSlug + ext));
}

async function findExistingFile(paths) {
  for (const filePath of paths) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // try next extension
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function readContent(collection, slug, locale = null) {
  sanitizePath(collection);
  sanitizePath(slug);

  const info = await getCollectionLoaderInfo(collection);

  if (info.isFile) {
    return readFileCollectionEntry(info.filePath, slug);
  }

  const filePath = await findExistingFile(candidatePaths(info.baseDirectory, slug, locale));
  if (!filePath) {
    const localeHint = locale ? ` (${locale})` : '';
    throw new Error(`Content not found: ${collection}/${slug}${localeHint}`);
  }

  const raw = await fs.readFile(filePath, 'utf-8');
  if (path.extname(filePath).toLowerCase() === '.json') {
    return { type: 'data', data: JSON.parse(raw), body: null, filePath, locale };
  }
  const parsed = matter(raw);
  return { type: 'content', data: parsed.data, body: parsed.content, filePath, locale };
}

async function readFileCollectionEntry(filePath, entryId) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error(`File collection is not an array: ${filePath}`);
  }
  const entry = arr.find((item) => item.id === entryId || item.slug === entryId);
  if (!entry) {
    throw new Error(`Content not found: ${entryId}`);
  }
  return { type: 'data', data: entry, body: null, filePath, locale: null };
}

export async function writeContent(collection, slug, { data, body, type }, locale = null) {
  sanitizePath(collection);
  sanitizePath(slug);

  const info = await getCollectionLoaderInfo(collection);

  if (info.isFile) {
    return writeFileCollectionEntry(info.filePath, slug, data);
  }

  await fs.mkdir(info.baseDirectory, { recursive: true });

  const baseSlug = locale ? `${sanitizePath(slug)}.${locale}` : sanitizePath(slug);
  const effectiveType = type || info.type || 'content';

  let filePath;
  let content;
  if (effectiveType === 'data') {
    filePath = path.join(info.baseDirectory, `${baseSlug}.json`);
    content = `${JSON.stringify(data, null, 2)}\n`;
  } else {
    filePath = path.join(info.baseDirectory, `${baseSlug}.md`);
    content = matter.stringify(body || '', data);
  }

  await fs.writeFile(filePath, content, 'utf-8');
  return { filePath, locale };
}

async function writeFileCollectionEntry(filePath, entryId, entryData) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error(`File collection is not an array: ${filePath}`);
  }

  const index = arr.findIndex((item) => item.id === entryId || item.slug === entryId);
  const next = { ...entryData, id: entryId };
  if (index >= 0) {
    arr[index] = next; // preserve array order (position)
  } else {
    arr.push(next);
  }

  await fs.writeFile(filePath, `${JSON.stringify(arr, null, 2)}\n`, 'utf-8');
  return { filePath, locale: null };
}

export async function deleteContent(collection, slug, locale = null) {
  sanitizePath(collection);
  sanitizePath(slug);

  const info = await getCollectionLoaderInfo(collection);

  if (info.isFile) {
    return deleteFileCollectionEntry(info.filePath, slug);
  }

  const filePath = await findExistingFile(candidatePaths(info.baseDirectory, slug, locale));
  if (!filePath) {
    const localeHint = locale ? ` (${locale})` : '';
    throw new Error(`Content not found: ${collection}/${slug}${localeHint}`);
  }

  await fs.unlink(filePath);
  return { deleted: filePath, locale };
}

async function deleteFileCollectionEntry(filePath, entryId) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error(`File collection is not an array: ${filePath}`);
  }
  const index = arr.findIndex((item) => item.id === entryId || item.slug === entryId);
  if (index < 0) {
    throw new Error(`Content not found: ${entryId}`);
  }
  arr.splice(index, 1);
  await fs.writeFile(filePath, `${JSON.stringify(arr, null, 2)}\n`, 'utf-8');
  return { deleted: filePath, locale: null };
}

export async function contentExists(collection, slug, locale = null) {
  const info = await getCollectionLoaderInfo(collection);
  if (info.isFile) {
    try {
      const arr = JSON.parse(await fs.readFile(info.filePath, 'utf-8'));
      return Array.isArray(arr) && arr.some((item) => item.id === slug || item.slug === slug);
    } catch {
      return false;
    }
  }
  const filePath = await findExistingFile(candidatePaths(info.baseDirectory, slug, locale));
  return filePath !== null;
}

export async function getAvailableLocales(collection, baseSlug, configuredLocales) {
  const available = [];
  for (const locale of configuredLocales) {
    if (await contentExists(collection, baseSlug, locale)) {
      available.push(locale);
    }
  }
  return available;
}

// ---------------------------------------------------------------------------
// Listing (mirrors the db.js functions collections.js depends on)
// ---------------------------------------------------------------------------

/** Distinct base slugs in a collection (locale-deduplicated), in stable order. */
export async function listSlugs(collection) {
  const info = await getCollectionLoaderInfo(collection);

  if (info.isFile) {
    try {
      const arr = JSON.parse(await fs.readFile(info.filePath, 'utf-8'));
      if (!Array.isArray(arr)) return [];
      return arr.map((item, index) => item.id || item.slug || String(index));
    } catch {
      return [];
    }
  }

  const i18n = getI18n();
  const files = await findMatchingFiles(info.baseDirectory, info.patterns);
  const seen = new Set();
  const slugs = [];
  for (const relativePath of files) {
    const ext = path.extname(relativePath).toLowerCase();
    const nameWithoutExt = relativePath.slice(0, -ext.length);
    const { slug } = splitLocale(nameWithoutExt, i18n);
    if (!seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
  }
  return slugs;
}

/** Collection names that currently have at least one entry on disk. */
export async function distinctCollections() {
  const schemas = await loadSchemas();
  const names = [];
  for (const name of Object.keys(schemas)) {
    const slugs = await listSlugs(name);
    if (slugs.length > 0) names.push(name);
  }
  return names;
}

/** Stored type for a collection inferred from disk; null when undeterminable. */
export async function getCollectionType(collection) {
  const info = await getCollectionLoaderInfo(collection);
  if (info.isFile) return 'data';

  const files = await findMatchingFiles(info.baseDirectory, info.patterns);
  if (files.length === 0) return null;
  const allJson = files.every((f) => path.extname(f).toLowerCase() === '.json');
  return allJson ? 'data' : 'content';
}
