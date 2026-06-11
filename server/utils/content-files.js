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
 * importer via glob-files.js. Writes are atomic (temp file + rename) and
 * serialized per target file, so concurrent saves can't tear a file or lose
 * a file()-collection update.
 */

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { getConfig } from '../config.js';
import { loadSchemas } from './collections.js';
import {
  getGlobBaseDirectory,
  getGlobPatterns,
  findMatchingFiles,
  splitLocale,
  resolveProjectPath,
  sanitizePath,
  allowedContentExtensions,
  CONTENT_EXTENSIONS,
} from './glob-files.js';

async function getI18n() {
  // Must be the merged config — i18n is only enableable via astroadmin.config.js.
  const fullConfig = await getConfig();
  return fullConfig.i18n || { enabled: false, locales: [] };
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
function candidatePaths(baseDirectory, slug, locale, extensions = CONTENT_EXTENSIONS) {
  const baseSlug = locale ? `${sanitizePath(slug)}.${locale}` : sanitizePath(slug);
  return extensions.map((ext) => path.join(baseDirectory, baseSlug + ext));
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
// Write safety: per-file serialization + atomic replace
// ---------------------------------------------------------------------------

const fileWriteQueues = new Map();

/**
 * Serialize tasks targeting the same file so read-modify-write cycles (the
 * file()-collection array) can't interleave and lose an update.
 */
function withFileWriteQueue(filePath, task) {
  const previous = fileWriteQueues.get(filePath) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  fileWriteQueues.set(filePath, run);
  const cleanup = () => {
    if (fileWriteQueues.get(filePath) === run) fileWriteQueues.delete(filePath);
  };
  run.then(cleanup, cleanup);
  return run;
}

/**
 * Write via temp file + rename so a concurrent reader (the Astro dev server,
 * a parallel request) never sees a truncated file. Creates parent directories
 * — slugs may be nested (e.g. "guides/start").
 */
async function atomicWriteFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}

// ---------------------------------------------------------------------------
// file()-collection array helpers
// ---------------------------------------------------------------------------

/**
 * Read a file() collection's JSON array. With missingOk, a missing file reads
 * as an empty array — so the first entry of a fresh collection can be created
 * and lookups report "not found" rather than ENOENT.
 */
async function readFileCollectionArray(filePath, { missingOk = false } = {}) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (missingOk && error.code === 'ENOENT') return [];
    throw error;
  }
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error(`File collection is not an array: ${filePath}`);
  }
  return arr;
}

/** Entry identity within a file() collection array: id, falling back to slug. */
function findEntryIndex(arr, entryId) {
  return arr.findIndex((item) => item.id === entryId || item.slug === entryId);
}

function serializeFileCollection(arr) {
  return `${JSON.stringify(arr, null, 2)}\n`;
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
  const arr = await readFileCollectionArray(filePath, { missingOk: true });
  const index = findEntryIndex(arr, entryId);
  if (index < 0) {
    throw new Error(`Content not found: ${entryId}`);
  }
  return { type: 'data', data: arr[index], body: null, filePath, locale: null };
}

/**
 * Extension for a brand-new entry: data is always JSON; content gets whatever
 * markdown flavour the collection's loader pattern expects (.mdx only when the
 * pattern excludes .md, e.g. '**' + '/*.mdx').
 */
function newEntryExtension(effectiveType, allowedExtensions) {
  if (effectiveType === 'data') return '.json';
  if (!allowedExtensions.includes('.md') && allowedExtensions.includes('.mdx')) return '.mdx';
  return '.md';
}

export async function writeContent(collection, slug, { data, body, type }, locale = null) {
  sanitizePath(collection);
  sanitizePath(slug);

  const info = await getCollectionLoaderInfo(collection);

  if (info.isFile) {
    return writeFileCollectionEntry(info.filePath, slug, data);
  }

  const baseSlug = locale ? `${sanitizePath(slug)}.${locale}` : sanitizePath(slug);
  const allowedExtensions = allowedContentExtensions(info.patterns);

  // An update must land in the entry's existing file (considering only
  // extensions the loader pattern can match, so a stale out-of-pattern file
  // can't absorb the write invisibly), and a new entry gets the extension the
  // pattern expects — editing home.mdx never creates a duplicate home.md, and
  // creates on an mdx-only collection don't produce unreachable .md files.
  let filePath = await findExistingFile(
    candidatePaths(info.baseDirectory, slug, locale, allowedExtensions)
  );
  if (!filePath) {
    const effectiveType = type || info.type || 'content';
    filePath = path.join(
      info.baseDirectory,
      baseSlug + newEntryExtension(effectiveType, allowedExtensions)
    );
  }

  let content;
  if (path.extname(filePath).toLowerCase() === '.json') {
    // A JSON file can't hold a markdown body — fail loudly rather than
    // silently dropping it.
    if (typeof body === 'string' && body.trim() !== '') {
      throw new Error(
        `Entry ${collection}/${slug} is stored as JSON (${filePath}); a markdown body cannot be saved into it`
      );
    }
    content = `${JSON.stringify(data, null, 2)}\n`;
  } else {
    content = matter.stringify(body || '', data);
  }

  await withFileWriteQueue(filePath, () => atomicWriteFile(filePath, content));
  return { filePath, locale };
}

/**
 * Replace a file() collection's entire array (used by the DB→files exporter),
 * through the same serialized + atomic write path as entry-level updates so
 * the on-disk format has exactly one definition.
 */
export async function writeFileCollectionArray(filePath, array) {
  await withFileWriteQueue(filePath, () => atomicWriteFile(filePath, serializeFileCollection(array)));
  return { filePath };
}

async function writeFileCollectionEntry(filePath, entryId, entryData) {
  await withFileWriteQueue(filePath, async () => {
    const arr = await readFileCollectionArray(filePath, { missingOk: true });
    const index = findEntryIndex(arr, entryId);
    const next = { ...entryData, id: entryId };
    if (index >= 0) {
      arr[index] = next; // preserve array order (position)
    } else {
      arr.push(next);
    }
    await atomicWriteFile(filePath, serializeFileCollection(arr));
  });
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

  // Queued like writes, so a delete can't interleave with a pending save's
  // rename and resurrect the file.
  await withFileWriteQueue(filePath, () => fs.unlink(filePath));
  return { deleted: filePath, locale };
}

async function deleteFileCollectionEntry(filePath, entryId) {
  await withFileWriteQueue(filePath, async () => {
    const arr = await readFileCollectionArray(filePath, { missingOk: true });
    const index = findEntryIndex(arr, entryId);
    if (index < 0) {
      throw new Error(`Content not found: ${entryId}`);
    }
    arr.splice(index, 1);
    await atomicWriteFile(filePath, serializeFileCollection(arr));
  });
  return { deleted: filePath, locale: null };
}

export async function contentExists(collection, slug, locale = null) {
  const info = await getCollectionLoaderInfo(collection);
  if (info.isFile) {
    try {
      const arr = await readFileCollectionArray(info.filePath, { missingOk: true });
      return findEntryIndex(arr, slug) >= 0;
    } catch {
      return false;
    }
  }
  const filePath = await findExistingFile(candidatePaths(info.baseDirectory, slug, locale));
  return filePath !== null;
}

export async function getAvailableLocales(collection, baseSlug, configuredLocales) {
  const info = await getCollectionLoaderInfo(collection);

  // file() collections have no locale variants (parity with the db store,
  // which stored them locale-less and listed no locales for them).
  if (info.isFile) return [];

  const available = [];
  for (const locale of configuredLocales) {
    const filePath = await findExistingFile(candidatePaths(info.baseDirectory, baseSlug, locale));
    if (filePath) available.push(locale);
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
      const arr = await readFileCollectionArray(info.filePath, { missingOk: true });
      return arr.map((item, index) => item.id || item.slug || String(index));
    } catch {
      return [];
    }
  }

  const i18n = await getI18n();
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
