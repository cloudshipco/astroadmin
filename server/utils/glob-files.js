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
export const DEFAULT_GLOB_PATTERN = '*.{md,mdx,json}';

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
 * Match pattern(s) for a glob collection. Defaults to `*.{md,mdx,json}`.
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
