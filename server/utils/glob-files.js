/**
 * Glob file-discovery helpers
 *
 * Shared between the file→DB importer (import-files.js) and the file-based
 * content store (content-files.js) so both resolve a collection's on-disk
 * location the same way: honour an Astro 6 glob() loader's `base`/`pattern`
 * when present, else fall back to `src/content/<collection>`.
 *
 * Extracted from the original importer to keep one source of truth for glob
 * base/pattern resolution and locale splitting.
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

export const CONTENT_EXTENSIONS = ['.md', '.mdx', '.json'];
// Recursive, matching Astro's legacy src/content semantics — entries may be
// nested (e.g. guides/start.md), and the store writes nested slugs.
export const DEFAULT_GLOB_PATTERN = '**/*.{md,mdx,json}';

/**
 * A request named a path the content store will not touch: an undeclared
 * collection, a malformed slug, or a file that resolves outside its
 * collection's directory. The API answers 400 with `message`, which never
 * names a server path.
 */
export class ContentPathError extends Error {
  constructor(message = 'Invalid content path') {
    super(message);
    this.name = 'ContentPathError';
    this.code = 'INVALID_CONTENT_PATH';
    this.status = 400;
  }
}

/** @param {unknown} error @returns {boolean} */
export function isContentPathError(error) {
  return Boolean(error) && error.code === 'INVALID_CONTENT_PATH';
}

/**
 * Defence-in-depth path guard. Slugs/collections become path segments, so
 * reject traversal even though callers are already schema-bounded. Not
 * sufficient on its own: `path.normalize('/../../')` is `/`, which passes,
 * which is why collections are also checked against the declared set
 * (assertDeclaredCollection) and every final path for containment
 * (assertContainedPath).
 */
export function sanitizePath(userPath) {
  if (typeof userPath !== 'string') {
    throw new ContentPathError('Invalid path');
  }
  const normalized = path.normalize(userPath);
  if (normalized.includes('..')) {
    throw new ContentPathError('Invalid path: directory traversal not allowed');
  }
  return normalized;
}

/**
 * A collection must be one the content config declares, by exact own-key
 * match (so `__proto__`, `constructor` and every encoded path are refused).
 * @param {unknown} collection
 * @param {Record<string, unknown>} schemas - parsed content config
 */
export function assertDeclaredCollection(collection, schemas) {
  if (typeof collection !== 'string' || !schemas || !Object.hasOwn(schemas, collection)) {
    throw new ContentPathError('Unknown collection');
  }
  return collection;
}

// Leaves room under the usual 255-byte filename limit for `.<locale>`, the
// extension and the atomic write's `.<pid>.tmp` suffix.
const MAX_SLUG_SEGMENT_BYTES = 200;
const MAX_SLUG_LENGTH = 1024;
// Control characters (NUL included) and backslashes, a separator on Windows.
const FORBIDDEN_SLUG_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/**
 * A glob entry's slug becomes a relative path under the collection's base:
 * '/'-separated segments, none empty, '.' or '..', none too long for a
 * filename. Nested slugs (`2024/first-post`) are fine.
 * @param {unknown} slug
 */
export function assertSafeSlug(slug) {
  if (typeof slug !== 'string' || slug === '' || slug.length > MAX_SLUG_LENGTH) {
    throw new ContentPathError('Invalid slug');
  }
  if (FORBIDDEN_SLUG_CHARACTERS.test(slug) || path.isAbsolute(slug)) {
    throw new ContentPathError('Invalid slug');
  }
  for (const segment of slug.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ContentPathError('Invalid slug');
    }
    if (Buffer.byteLength(segment, 'utf8') > MAX_SLUG_SEGMENT_BYTES) {
      throw new ContentPathError('Invalid slug');
    }
  }
  return slug;
}

/** True when `candidate` is strictly inside `root` (both absolute). */
function isStrictlyInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

/**
 * realpath() of a path that may not exist yet: resolve the deepest existing
 * ancestor and re-append the rest. A dangling symlink on the way is refused,
 * since writing through it would land wherever it points.
 */
async function realpathAllowingMissing(targetPath) {
  const missingTail = [];
  let current = path.resolve(targetPath);
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...missingTail);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new ContentPathError();
      }
    }
    let isDanglingLink = false;
    try {
      isDanglingLink = (await fs.lstat(current)).isSymbolicLink();
    } catch {
      // nothing there at all
    }
    if (isDanglingLink) throw new ContentPathError();
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(targetPath);
    missingTail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Every file the content store reads, writes or deletes for a request is
 * checked here AFTER its final name is built: it must lie strictly inside
 * `rootDirectory`, both as written and with symlinks resolved.
 * @param {string} rootDirectory - the collection's base directory
 * @param {string} candidatePath - the resolved file path
 * @returns {Promise<string>} candidatePath, unchanged
 */
export async function assertContainedPath(rootDirectory, candidatePath) {
  if (!isStrictlyInside(path.resolve(rootDirectory), path.resolve(candidatePath))) {
    throw new ContentPathError();
  }
  const [realRoot, realCandidate] = await Promise.all([
    realpathAllowingMissing(rootDirectory),
    realpathAllowingMissing(candidatePath),
  ]);
  if (!isStrictlyInside(realRoot, realCandidate)) {
    throw new ContentPathError();
  }
  return candidatePath;
}

export function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function resolveProjectPath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(config.paths.projectRoot, filePath);
}

/**
 * Base directory for a glob (directory) collection. Uses the loader's declared
 * `base` when available, else `src/content/<collection>`.
 */
export function getGlobBaseDirectory(collectionName, schema) {
  return schema?.loaderBase
    ? resolveProjectPath(schema.loaderBase)
    : path.join(config.paths.content, collectionName);
}

/**
 * Subset of CONTENT_EXTENSIONS the collection's pattern(s) can match (probed
 * at top level and nested). Falls back to all extensions when the patterns
 * match none — better to over-match than to make entries unreachable.
 */
export function allowedContentExtensions(patterns) {
  const allowed = CONTENT_EXTENSIONS.filter((ext) =>
    [`probe${ext}`, `nested/probe${ext}`].some((probe) => matchesAnyPattern(probe, patterns))
  );
  return allowed.length > 0 ? allowed : CONTENT_EXTENSIONS;
}

/**
 * Match pattern(s) for a glob collection. Defaults to `**\/*.{md,mdx,json}`.
 */
export function getGlobPatterns(schema) {
  if (Array.isArray(schema?.loaderPattern) && schema.loaderPattern.length > 0) {
    return schema.loaderPattern.map(String);
  }
  if (typeof schema?.loaderPattern === 'string' && schema.loaderPattern.trim()) {
    return [schema.loaderPattern];
  }
  return [DEFAULT_GLOB_PATTERN];
}

function normalizeGlobPattern(pattern) {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function globPatternToRegExp(pattern) {
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

export function matchesAnyPattern(relativeFilePath, patterns) {
  return patterns
    .map(globPatternToRegExp)
    .some((patternRegex) => patternRegex.test(relativeFilePath));
}

/**
 * Recursively find files under `baseDirectory` matching any of `patterns`,
 * restricted to content extensions. Returns POSIX-relative paths, sorted.
 */
export async function findMatchingFiles(baseDirectory, patterns) {
  // Compile once per call, not per file visited.
  const patternRegexes = patterns.map(globPatternToRegExp);
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
      if (!patternRegexes.some((patternRegex) => patternRegex.test(relativePath))) continue;

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
export function splitLocale(nameWithoutExt, i18nConfig) {
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
