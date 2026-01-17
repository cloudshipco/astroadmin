/**
 * Content utility
 * Read and write content files (markdown, JSON)
 * Supports both glob (directory) and file (JSON array) loaders
 */

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { config } from '../config.js';
import { loadSchemas } from './collections.js';

/**
 * Check if a collection uses a file loader (JSON array)
 * @param {string} collection - Collection name
 * @returns {Promise<{isFile: boolean, filePath?: string}>}
 */
async function getCollectionLoaderInfo(collection) {
  try {
    const schemas = await loadSchemas();
    const schema = schemas[collection];

    if (schema?.loaderType === 'file' && schema.loaderFilePath) {
      return {
        isFile: true,
        filePath: path.join(config.paths.projectRoot, schema.loaderFilePath),
      };
    }
  } catch (error) {
    console.warn(`Could not get loader info for ${collection}:`, error.message);
  }

  return { isFile: false };
}

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
  // Check if this is a file-based collection
  const loaderInfo = await getCollectionLoaderInfo(collection);

  if (loaderInfo.isFile) {
    // File-based collection: read from JSON array
    return await readFileCollectionEntry(loaderInfo.filePath, slug);
  }

  // Glob-based collection: read from directory
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
 * Read an entry from a file-based (JSON array) collection
 * @param {string} filePath - Path to the JSON file
 * @param {string} entryId - Entry ID to find
 */
async function readFileCollectionEntry(filePath, entryId) {
  const content = await fs.readFile(filePath, 'utf-8');
  const data = JSON.parse(content);

  if (!Array.isArray(data)) {
    throw new Error(`File collection is not an array: ${filePath}`);
  }

  const entry = data.find(item => item.id === entryId || item.slug === entryId);

  if (!entry) {
    throw new Error(`Entry not found in file collection: ${entryId}`);
  }

  return {
    type: 'data',
    data: entry,
    body: null,
    filePath,
    locale: null,
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
  // Check if this is a file-based collection
  const loaderInfo = await getCollectionLoaderInfo(collection);

  if (loaderInfo.isFile) {
    // File-based collection: update entry in JSON array
    return await writeFileCollectionEntry(loaderInfo.filePath, slug, data);
  }

  // Glob-based collection: write to directory
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
 * Write an entry to a file-based (JSON array) collection
 * @param {string} filePath - Path to the JSON file
 * @param {string} entryId - Entry ID to update (or create)
 * @param {object} entryData - Entry data to write
 */
async function writeFileCollectionEntry(filePath, entryId, entryData) {
  const content = await fs.readFile(filePath, 'utf-8');
  const data = JSON.parse(content);

  if (!Array.isArray(data)) {
    throw new Error(`File collection is not an array: ${filePath}`);
  }

  // Find existing entry index
  const existingIndex = data.findIndex(item => item.id === entryId || item.slug === entryId);

  if (existingIndex >= 0) {
    // Update existing entry (preserve position)
    data[existingIndex] = { ...entryData, id: entryId };
  } else {
    // Add new entry
    data.push({ ...entryData, id: entryId });
  }

  // Write back the entire JSON file
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');

  return { filePath, locale: null };
}

/**
 * Delete content entry
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function deleteContent(collection, slug, locale = null) {
  // Check if this is a file-based collection
  const loaderInfo = await getCollectionLoaderInfo(collection);

  if (loaderInfo.isFile) {
    // File-based collection: remove entry from JSON array
    return await deleteFileCollectionEntry(loaderInfo.filePath, slug);
  }

  // Glob-based collection: delete file
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
 * Delete an entry from a file-based (JSON array) collection
 * @param {string} filePath - Path to the JSON file
 * @param {string} entryId - Entry ID to delete
 */
async function deleteFileCollectionEntry(filePath, entryId) {
  const content = await fs.readFile(filePath, 'utf-8');
  const data = JSON.parse(content);

  if (!Array.isArray(data)) {
    throw new Error(`File collection is not an array: ${filePath}`);
  }

  // Find existing entry index
  const existingIndex = data.findIndex(item => item.id === entryId || item.slug === entryId);

  if (existingIndex < 0) {
    throw new Error(`Entry not found in file collection: ${entryId}`);
  }

  // Remove entry
  data.splice(existingIndex, 1);

  // Write back the entire JSON file
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');

  return { deleted: filePath, locale: null };
}

/**
 * Check if content exists
 * @param {string} collection - Collection name
 * @param {string} slug - Entry slug (without locale suffix)
 * @param {string|null} locale - Locale code (null for non-i18n sites)
 */
export async function contentExists(collection, slug, locale = null) {
  // Check if this is a file-based collection
  const loaderInfo = await getCollectionLoaderInfo(collection);

  if (loaderInfo.isFile) {
    // File-based collection: check if entry exists in JSON array
    return await fileCollectionEntryExists(loaderInfo.filePath, slug);
  }

  // Glob-based collection: check if file exists
  const { possiblePaths } = getContentPath(collection, slug, locale);
  const filePath = await findExistingFile(possiblePaths);
  return filePath !== null;
}

/**
 * Check if an entry exists in a file-based (JSON array) collection
 * @param {string} filePath - Path to the JSON file
 * @param {string} entryId - Entry ID to check
 */
async function fileCollectionEntryExists(filePath, entryId) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);

    if (!Array.isArray(data)) {
      return false;
    }

    return data.some(item => item.id === entryId || item.slug === entryId);
  } catch {
    return false;
  }
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
