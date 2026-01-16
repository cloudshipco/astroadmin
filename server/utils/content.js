/**
 * Content utility
 * Read and write content files (markdown, JSON)
 */

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { config } from '../config.js';

/**
 * Sanitize file path to prevent directory traversal attacks
 */
function sanitizePath(userPath) {
  const normalized = path.normalize(userPath);

  if (normalized.includes('..')) {
    throw new Error('Invalid path: directory traversal not allowed');
  }

  return normalized;
}

/**
 * Get the full path to a content file
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
function getContentPath(collection, slug, locale = null) {
  const sanitizedCollection = sanitizePath(collection);
  const sanitizedSlug = sanitizePath(slug);

  const contentDir = config.paths.content;
  const collectionPath = path.join(contentDir, sanitizedCollection);

  // Build filename based on whether locale is provided
  // With locale: slug.locale (e.g., "home.en")
  // Without locale: slug (e.g., "home")
  const baseSlug = locale ? `${sanitizedSlug}.${locale}` : sanitizedSlug;

  // Try different extensions
  const extensions = ['.md', '.mdx', '.json'];

  return {
    directory: collectionPath,
    possiblePaths: extensions.map(ext =>
      path.join(collectionPath, baseSlug + ext)
    ),
    baseSlug: sanitizedSlug,
    locale,
  };
}

/**
 * Find which file extension exists for a slug
 */
async function findExistingFile(possiblePaths) {
  for (const filePath of possiblePaths) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // File doesn't exist, try next
    }
  }
  return null;
}

/**
 * Read a content entry
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function readContent(collection, slug, locale = null) {
  const { possiblePaths } = getContentPath(collection, slug, locale);
  const filePath = await findExistingFile(possiblePaths);

  if (!filePath) {
    const localeHint = locale ? ` (${locale})` : '';
    throw new Error(`Content not found: ${collection}/${slug}${localeHint}`);
  }

  const content = await fs.readFile(filePath, 'utf-8');
  const ext = path.extname(filePath);

  if (ext === '.json') {
    // JSON data collection
    return {
      type: 'data',
      data: JSON.parse(content),
      body: null,
      filePath,
      locale,
    };
  } else {
    // Markdown content collection
    const parsed = matter(content);

    return {
      type: 'content',
      data: parsed.data,
      body: parsed.content,
      filePath,
      locale,
    };
  }
}

/**
 * Write content entry using atomic write (temp file outside content dir + rename)
 * Writing temp file outside the watched directory prevents double file watcher events
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {object} options - { data, body, type }
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function writeContent(collection, slug, { data, body, type }, locale = null) {
  const { directory } = getContentPath(collection, slug, locale);

  // Ensure collection directory exists
  await fs.mkdir(directory, { recursive: true });

  // Build filename with locale if provided
  const sanitizedSlug = sanitizePath(slug);
  const baseSlug = locale ? `${sanitizedSlug}.${locale}` : sanitizedSlug;

  // Determine file path
  let filePath;
  let content;

  if (type === 'data') {
    // JSON file
    filePath = path.join(directory, `${baseSlug}.json`);
    content = JSON.stringify(data, null, 2);
  } else {
    // Markdown file
    filePath = path.join(directory, `${baseSlug}.md`);
    content = matter.stringify(body || '', data);
  }

  await fs.writeFile(filePath, content, 'utf-8');

  return { filePath, locale };
}

/**
 * Delete content entry
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function deleteContent(collection, slug, locale = null) {
  const { possiblePaths } = getContentPath(collection, slug, locale);
  const filePath = await findExistingFile(possiblePaths);

  if (!filePath) {
    const localeHint = locale ? ` (${locale})` : '';
    throw new Error(`Content not found: ${collection}/${slug}${localeHint}`);
  }

  await fs.unlink(filePath);

  return { deleted: filePath, locale };
}

/**
 * Check if content exists
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function contentExists(collection, slug, locale = null) {
  const { possiblePaths } = getContentPath(collection, slug, locale);
  const filePath = await findExistingFile(possiblePaths);
  return filePath !== null;
}

/**
 * Get which locales exist for a given entry
 * @param {string} collection - Collection name
 * @param {string} baseSlug - Base slug without locale suffix
 * @param {string[]} configuredLocales - List of configured locales to check
 * @returns {Promise<string[]>} - Array of available locale codes
 */
export async function getAvailableLocales(collection, baseSlug, configuredLocales) {
  const available = [];

  for (const locale of configuredLocales) {
    const exists = await contentExists(collection, baseSlug, locale);
    if (exists) {
      available.push(locale);
    }
  }

  return available;
}
