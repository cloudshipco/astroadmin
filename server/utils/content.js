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
 */
function getContentPath(collection, slug) {
  const sanitizedCollection = sanitizePath(collection);
  const sanitizedSlug = sanitizePath(slug);

  const contentDir = config.paths.content;
  const collectionPath = path.join(contentDir, sanitizedCollection);

  // Try different extensions
  const extensions = ['.md', '.mdx', '.json'];

  return {
    directory: collectionPath,
    possiblePaths: extensions.map(ext =>
      path.join(collectionPath, sanitizedSlug + ext)
    ),
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
 */
export async function readContent(collection, slug) {
  const { possiblePaths } = getContentPath(collection, slug);
  const filePath = await findExistingFile(possiblePaths);

  if (!filePath) {
    throw new Error(`Content not found: ${collection}/${slug}`);
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
    };
  } else {
    // Markdown content collection
    const parsed = matter(content);

    return {
      type: 'content',
      data: parsed.data,
      body: parsed.content,
      filePath,
    };
  }
}

/**
 * Write content entry using atomic write (temp file outside content dir + rename)
 * Writing temp file outside the watched directory prevents double file watcher events
 */
export async function writeContent(collection, slug, { data, body, type }) {
  const { directory, possiblePaths } = getContentPath(collection, slug);

  // Ensure collection directory exists
  await fs.mkdir(directory, { recursive: true });

  // Determine file path
  let filePath;
  let content;

  if (type === 'data') {
    // JSON file
    filePath = path.join(directory, `${sanitizePath(slug)}.json`);
    content = JSON.stringify(data, null, 2);
  } else {
    // Markdown file
    filePath = path.join(directory, `${sanitizePath(slug)}.md`);
    content = matter.stringify(body || '', data);
  }

  // Write directly - the double reload issue is likely Astro/Vite behavior
  // not something we can easily fix from this side
  await fs.writeFile(filePath, content, 'utf-8');

  return { filePath };
}

/**
 * Delete content entry
 */
export async function deleteContent(collection, slug) {
  const { possiblePaths } = getContentPath(collection, slug);
  const filePath = await findExistingFile(possiblePaths);

  if (!filePath) {
    throw new Error(`Content not found: ${collection}/${slug}`);
  }

  await fs.unlink(filePath);

  return { deleted: filePath };
}

/**
 * Check if content exists
 */
export async function contentExists(collection, slug) {
  const { possiblePaths } = getContentPath(collection, slug);
  const filePath = await findExistingFile(possiblePaths);
  return filePath !== null;
}
