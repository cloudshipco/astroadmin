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
import { getConfig } from '../config.js';
import { dateFieldsFromSchema, orderLike, parseFrontmatter, serializeJson, serializeMarkdown } from './content-format.js';
import { loadSchemas } from './collections.js';
import {
  getGlobBaseDirectory,
  getGlobPatterns,
  findMatchingFiles,
  splitLocale,
  resolveProjectPath,
  sanitizePath,
  assertDeclaredCollection,
  assertSafeSlug,
  assertContainedPath,
  allowedContentExtensions,
  CONTENT_EXTENSIONS,
} from './glob-files.js';
import { withCheckoutWrite } from './checkout-lock.js';
import { saveOrderVerdict, recordWrittenSave } from './save-order.js';

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
  // The single funnel from a request's collection name to a directory: only a
  // collection the content config declares resolves, by exact match. There is
  // deliberately no fallback when the config cannot be parsed — joining an
  // unchecked name onto src/content is how `/../../` reached the site root.
  const schemas = await loadSchemas();
  assertDeclaredCollection(collection, schemas);
  const schema = schemas[collection] || {};

  if (schema.loaderType === 'file' && schema.loaderFilePath) {
    return { isFile: true, filePath: resolveProjectPath(schema.loaderFilePath), type: 'data' };
  }

  return {
    isFile: false,
    baseDirectory: getGlobBaseDirectory(collection, schema),
    patterns: getGlobPatterns(schema),
    type: schema.type || 'content',
    // The parsed JSON schema: which fields are dates, for the serialiser.
    jsonSchema: schema.schema || null,
  };
}

/** Candidate file paths for a glob entry, in extension preference order. */
function candidatePaths(baseDirectory, slug, locale, extensions = CONTENT_EXTENSIONS) {
  return extensions.map((ext) => path.join(baseDirectory, entryBaseName(slug, locale) + ext));
}

/** `<slug>` or `<slug>.<locale>`: the entry's path under its base, sans extension. */
function entryBaseName(slug, locale) {
  assertSafeSlug(slug);
  const baseSlug = sanitizePath(slug);
  return locale ? `${baseSlug}.${locale}` : baseSlug;
}

/**
 * First candidate that exists. Each is checked for containment in the
 * collection's base first, so a symlink cannot carry a read, write or delete
 * outside it.
 */
async function findExistingFile(baseDirectory, paths) {
  for (const filePath of paths) {
    await assertContainedPath(baseDirectory, filePath);
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
 * file()-collection array) can't interleave and lose an update. Each task is
 * also a checkout write, so it never runs while publish commits and rebases.
 */
function withFileWriteQueue(filePath, task) {
  const previous = fileWriteQueues.get(filePath) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => withCheckoutWrite(task));
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
  return (await readFileCollection(filePath, { missingOk })).array;
}

/** The array and the text it was read from (null for a missing file). */
async function readFileCollection(filePath, { missingOk = false } = {}) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (missingOk && error.code === 'ENOENT') return { array: [], raw: null };
    throw error;
  }
  const array = JSON.parse(raw);
  if (!Array.isArray(array)) {
    throw new Error(`File collection is not an array: ${filePath}`);
  }
  return { array, raw };
}

/**
 * A file() collection item's entry id, as Astro's file() loader derives it:
 * `(item.id ?? item.slug)?.toString()` (astro/dist/content/loaders/file.js).
 * So a numeric `id: 1` is the entry "1", and `id: 0` is not missing. Astro
 * skips an item whose id is empty; so does this (undefined).
 * @param {unknown} item - one element of the collection's array
 * @returns {string|undefined}
 */
export function fileEntryId(item) {
  if (item === null || typeof item !== 'object') return undefined;
  const entryId = (item.id ?? item.slug)?.toString();
  return entryId === '' ? undefined : entryId;
}

/** Whether an item has a key Astro reads as its id (`??`: not null or undefined). */
function hasIdentityValue(value) {
  return value !== undefined && value !== null;
}

/**
 * The key an existing item is keyed by: `id`, or `slug` when it has no id
 * (Astro's `item.id ?? item.slug`).
 * @returns {'id'|'slug'}
 */
function identityKeyOf(item) {
  return hasIdentityValue(item.id) ? 'id' : 'slug';
}

/**
 * The key a NEW entry is keyed by. An id the form sent wins (Astro reads it
 * first); otherwise the collection's own convention: slug when every entry is
 * keyed by slug, id when any is. An empty collection follows the form (the
 * renderer starts a new entry with its id field, else its slug field).
 * @returns {'id'|'slug'}
 */
function newEntryIdentityKey(arr, entryData) {
  if (hasIdentityValue(entryData.id)) return 'id';
  if (arr.length > 0) return arr.every((item) => identityKeyOf(item) === 'slug') ? 'slug' : 'id';
  return hasIdentityValue(entryData.slug) ? 'slug' : 'id';
}

/**
 * An entry as it is written: what the editor sent, with its identity fixed.
 * An existing entry keeps the key it is keyed by, with its stored value and
 * type (`id: 1` stays the number 1); renaming it would orphan the entry and
 * break references to it. A slug-keyed entry gets no `id` it did not have (a
 * `.strict()` schema refuses one, and Astro would key the entry by it). A new
 * entry is written under the name it was created with, keeping the form's
 * value when it is that name (a number input's 5 stays 5).
 */
function withEntryIdentity(storedItem, arr, entryId, entryData) {
  const next = { ...entryData };
  if (storedItem) {
    const identityKey = identityKeyOf(storedItem);
    next[identityKey] = storedItem[identityKey];
    if (identityKey === 'slug') {
      if ('id' in storedItem) next.id = storedItem.id;
      else delete next.id;
    }
    return next;
  }
  const identityKey = newEntryIdentityKey(arr, entryData);
  const sentValue = entryData[identityKey];
  next[identityKey] = hasIdentityValue(sentValue) && String(sentValue) === entryId ? sentValue : entryId;
  return next;
}

/** The index of the item whose entry id (fileEntryId) is `entryId`, or -1. */
function findEntryIndex(arr, entryId) {
  return arr.findIndex((item) => fileEntryId(item) === entryId);
}

/**
 * The array as file text. Given the text it replaces, unchanged entries keep
 * their original text and changed ones follow the file's style
 * (content-format.js); without it, plain two-space JSON.
 */
function serializeFileCollection(arr, originalText = null) {
  return serializeJson(arr, originalText);
}

/** The current text of a file, or null if it does not exist. */
async function readExistingText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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

  const filePath = await findExistingFile(info.baseDirectory, candidatePaths(info.baseDirectory, slug, locale));
  if (!filePath) {
    const localeHint = locale ? ` (${locale})` : '';
    throw new Error(`Content not found: ${collection}/${slug}${localeHint}`);
  }

  const raw = await fs.readFile(filePath, 'utf-8');
  if (path.extname(filePath).toLowerCase() === '.json') {
    return { type: 'data', data: JSON.parse(raw), body: null, filePath, locale };
  }
  const parsed = parseFrontmatter(raw);
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
 * Extension for a brand-new entry: one the collection's loader pattern can
 * read, preferring JSON for data and markdown (.md, then .mdx) for content.
 * The pattern wins over the type: the editor sends type 'content' for any
 * glob() collection, and a .md file in a '**' + '/*.json' collection is never
 * loaded.
 */
function newEntryExtension(effectiveType, allowedExtensions) {
  const preference = effectiveType === 'data' ? ['.json', '.md', '.mdx'] : ['.md', '.mdx', '.json'];
  return preference.find((extension) => allowedExtensions.includes(extension)) || preference[0];
}

/**
 * @param {{data: Object, body?: string, type?: string, keepStoredBody?: boolean}} entry -
 *   `keepStoredBody`: the save says nothing about the body, so the body stored
 *   when the write runs is kept. It is read inside the file's write queue: read
 *   any earlier, a save queued ahead could replace the body in between and the
 *   old one would be written back.
 *   `saveOrder`: the editor page's number for this save (save-order.js). A save
 *   older than one that page already had written here is not written, and the
 *   result says `superseded: true`; a repeat of the newest is not written again.
 */
export async function writeContent(collection, slug, { data, body, type, keepStoredBody = false, saveOrder = null }, locale = null) {
  sanitizePath(collection);
  sanitizePath(slug);

  const info = await getCollectionLoaderInfo(collection);

  if (info.isFile) {
    return writeFileCollectionEntry(info.filePath, slug, data, saveOrder);
  }

  const allowedExtensions = allowedContentExtensions(info.patterns);

  // An update must land in the entry's existing file (considering only
  // extensions the loader pattern can match, so a stale out-of-pattern file
  // can't absorb the write invisibly), and a new entry gets the extension the
  // pattern expects — editing home.mdx never creates a duplicate home.md, and
  // creates on an mdx-only collection don't produce unreachable .md files.
  let filePath = await findExistingFile(
    info.baseDirectory,
    candidatePaths(info.baseDirectory, slug, locale, allowedExtensions)
  );
  if (!filePath) {
    const effectiveType = type || info.type || 'content';
    filePath = await assertContainedPath(
      info.baseDirectory,
      path.join(
        info.baseDirectory,
        entryBaseName(slug, locale) + newEntryExtension(effectiveType, allowedExtensions)
      )
    );
  }

  const isJson = path.extname(filePath).toLowerCase() === '.json';
  // A JSON file can't hold a markdown body — fail loudly rather than
  // silently dropping it.
  if (isJson && typeof body === 'string' && body.trim() !== '') {
    throw new Error(
      `Entry ${collection}/${slug} is stored as JSON (${filePath}); a markdown body cannot be saved into it`
    );
  }

  // Serialised against the file it replaces, inside the queue so the original
  // is the latest write: existing keys keep their place, unchanged values their
  // text, and dates their type (content-format.js).
  const superseded = await withFileWriteQueue(filePath, async () => {
    const verdict = saveOrderVerdict(filePath, saveOrder);
    if (verdict !== 'write') return verdict === 'superseded';
    const originalText = await readExistingText(filePath);
    let content;
    if (isJson) {
      let original = null;
      try {
        original = originalText === null ? null : JSON.parse(originalText);
      } catch {
        original = null;
      }
      content = serializeJson(orderLike(original, data), originalText);
    } else {
      const bodyText = keepStoredBody ? (originalText === null ? '' : parseFrontmatter(originalText).content) : body || '';
      content = serializeMarkdown(bodyText, data, originalText, { dateFields: dateFieldsFromSchema(info.jsonSchema) });
    }
    await atomicWriteFile(filePath, content);
    recordWrittenSave(filePath, saveOrder);
    return false;
  });
  return { filePath, locale, superseded };
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

async function writeFileCollectionEntry(filePath, entryId, entryData, saveOrder = null) {
  const orderKey = `${filePath}\0${entryId}`;
  const superseded = await withFileWriteQueue(filePath, async () => {
    const verdict = saveOrderVerdict(orderKey, saveOrder);
    if (verdict !== 'write') return verdict === 'superseded';
    const { array: arr, raw } = await readFileCollection(filePath, { missingOk: true });
    const index = findEntryIndex(arr, entryId);
    const next = withEntryIdentity(index >= 0 ? arr[index] : null, arr, entryId, entryData);
    if (index >= 0) {
      // Preserve array order (position), and the entry's own key order: the
      // editor sends `id` last and keys in form order.
      arr[index] = orderLike(arr[index], next);
    } else {
      arr.push(next);
    }
    await atomicWriteFile(filePath, serializeFileCollection(arr, raw));
    recordWrittenSave(orderKey, saveOrder);
    return false;
  });
  return { filePath, locale: null, superseded };
}

export async function deleteContent(collection, slug, locale = null) {
  sanitizePath(collection);
  sanitizePath(slug);

  const info = await getCollectionLoaderInfo(collection);

  if (info.isFile) {
    return deleteFileCollectionEntry(info.filePath, slug);
  }

  const filePath = await findExistingFile(info.baseDirectory, candidatePaths(info.baseDirectory, slug, locale));
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
    const { array: arr, raw } = await readFileCollection(filePath, { missingOk: true });
    const index = findEntryIndex(arr, entryId);
    if (index < 0) {
      throw new Error(`Content not found: ${entryId}`);
    }
    arr.splice(index, 1);
    await atomicWriteFile(filePath, serializeFileCollection(arr, raw));
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
  const filePath = await findExistingFile(info.baseDirectory, candidatePaths(info.baseDirectory, slug, locale));
  return filePath !== null;
}

export async function getAvailableLocales(collection, baseSlug, configuredLocales) {
  const info = await getCollectionLoaderInfo(collection);

  // file() collections have no locale variants (parity with the db store,
  // which stored them locale-less and listed no locales for them).
  if (info.isFile) return [];

  const available = [];
  for (const locale of configuredLocales) {
    const filePath = await findExistingFile(info.baseDirectory, candidatePaths(info.baseDirectory, baseSlug, locale));
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
      return arr.map((item, index) => fileEntryId(item) ?? String(index));
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

/**
 * Every entry of a collection with its data, in listSlugs order: `{slug,
 * data}`, or `{slug, error}` for one readContent would refuse. A file()
 * collection's file is read and parsed ONCE (reading each slug through
 * readContent parsed the whole file per entry); a glob() collection reads
 * each entry's file once. The results match listSlugs + readContent: an item
 * with no id is listed by its index and has no data, and a repeated id gives
 * the first item with that id.
 * @returns {Promise<Array<{slug: string, data?: Object, error?: Error}>>}
 */
export async function listEntries(collection) {
  sanitizePath(collection);
  const info = await getCollectionLoaderInfo(collection);

  if (!info.isFile) {
    const slugs = await listSlugs(collection);
    return Promise.all(slugs.map(async (slug) => {
      try {
        return { slug, data: (await readContent(collection, slug)).data };
      } catch (error) {
        return { slug, error };
      }
    }));
  }

  let arr;
  try {
    arr = await readFileCollectionArray(info.filePath, { missingOk: true });
  } catch {
    return []; // as listSlugs
  }
  const firstById = new Map();
  for (const item of arr) {
    const id = fileEntryId(item);
    if (id !== undefined && !firstById.has(id)) firstById.set(id, item);
  }
  return arr.map((item, index) => {
    const slug = fileEntryId(item) ?? String(index);
    try {
      sanitizePath(slug); // as readContent
    } catch (error) {
      return { slug, error };
    }
    return firstById.has(slug)
      ? { slug, data: firstById.get(slug) }
      : { slug, error: new Error(`Content not found: ${slug}`) };
  });
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
