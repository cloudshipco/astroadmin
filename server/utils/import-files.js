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
import { upsertEntry, computeDigest, countAll, getMeta, setMeta, withTransaction } from './db.js';

const CONTENT_EXTENSIONS = ['.md', '.mdx', '.json'];
const DEFAULT_GLOB_PATTERN = '*.{md,mdx,json}';

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function resolveProjectPath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(config.paths.projectRoot, filePath);
}

function getGlobBaseDirectory(collectionName, schema) {
  return schema.loaderBase
    ? resolveProjectPath(schema.loaderBase)
    : path.join(config.paths.content, collectionName);
}

function getGlobPatterns(schema) {
  if (Array.isArray(schema.loaderPattern) && schema.loaderPattern.length > 0) {
    return schema.loaderPattern.map(String);
  }
  if (typeof schema.loaderPattern === 'string' && schema.loaderPattern.trim()) {
    return [schema.loaderPattern];
  }
  return [DEFAULT_GLOB_PATTERN];
}

function normalizeGlobPattern(pattern) {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '');
}

function globPatternToRegExp(pattern) {
  const normalizedPattern = normalizeGlobPattern(pattern);
  let regexSource = '^';

  for (let index = 0; index < normalizedPattern.length; index++) {
    const char = normalizedPattern[index];

    if (char === '*') {
      const isGlobStar = normalizedPattern[index + 1] === '*';
      if (isGlobStar) {
        const hasFollowingSlash = normalizedPattern[index + 2] === '/';
        if (hasFollowingSlash) {
          regexSource += '(?:.*/)?';
          index += 2;
        } else {
          regexSource += '.*';
          index += 1;
        }
      } else {
        regexSource += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      regexSource += '[^/]';
      continue;
    }

    if (char === '{') {
      const closingIndex = normalizedPattern.indexOf('}', index + 1);
      if (closingIndex !== -1) {
        const alternatives = normalizedPattern
          .slice(index + 1, closingIndex)
          .split(',')
          .map((alternative) => escapeRegExp(alternative));
        regexSource += `(?:${alternatives.join('|')})`;
        index = closingIndex;
        continue;
      }
    }

    regexSource += escapeRegExp(char);
  }

  return new RegExp(`${regexSource}$`);
}

function matchesAnyPattern(relativeFilePath, patterns) {
  return patterns
    .map(globPatternToRegExp)
    .some((patternRegex) => patternRegex.test(relativeFilePath));
}

async function findMatchingFiles(baseDirectory, patterns) {
  const files = [];

  async function walk(directory) {
    let dirents;
    try {
      dirents = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      if (directory === baseDirectory) return;
      throw new Error(`Could not read directory: ${directory}`);
    }

    for (const dirent of dirents) {
      const fullPath = path.join(directory, dirent.name);
      if (dirent.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!dirent.isFile()) continue;

      const relativePath = toPosixPath(path.relative(baseDirectory, fullPath));
      const extension = path.extname(relativePath).toLowerCase();
      if (!CONTENT_EXTENSIONS.includes(extension)) continue;
      if (!matchesAnyPattern(relativePath, patterns)) continue;

      files.push(relativePath);
    }
  }

  await walk(baseDirectory);
  return files.sort();
}

/**
 * Split a filename (without extension) into base slug + locale, honouring the
 * site's i18n config (e.g. "home.fr" -> { slug: "home", locale: "fr" }).
 */
function splitLocale(nameWithoutExt, i18nConfig) {
  if (i18nConfig?.enabled && Array.isArray(i18nConfig.locales) && i18nConfig.locales.length > 0) {
    const escapedLocales = i18nConfig.locales.map((locale) => escapeRegExp(locale));
    const pattern = new RegExp(`\\.(${escapedLocales.join('|')})$`, 'i');
    const match = nameWithoutExt.match(pattern);
    if (match) {
      return { slug: nameWithoutExt.replace(pattern, ''), locale: match[1] };
    }
  }
  return { slug: nameWithoutExt, locale: null };
}

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
 * @param {object} [options.i18n] - i18n config override (defaults to config.i18n)
 * @returns {Promise<{total: number, collections: Record<string, number>}>}
 */
export async function importFiles({ i18n } = {}) {
  const schemas = await loadSchemas();
  const i18nConfig = i18n || config.i18n || { enabled: false, locales: [] };

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
