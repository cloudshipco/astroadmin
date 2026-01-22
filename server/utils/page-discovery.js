/**
 * Page discovery utility
 * Discovers static pages from src/pages/ directory
 * Excludes dynamic routes, partials, and error pages
 */

import fs from 'fs/promises';
import path from 'path';
import { parseAstroCollectionRefs } from './astro-parser.js';
import { config } from '../config.js';

/** @typedef {{ path: string, slug: string, name: string, url: string, collections: string[] }} StaticPage */

// Cache for discovered pages
let cachedPages = null;

/**
 * Discover static pages from src/pages/
 * Returns array of page objects with metadata and collection references
 *
 * @param {string} projectRoot - Path to the Astro project root
 * @returns {Promise<StaticPage[]>} - Array of discovered pages
 */
export async function discoverStaticPages(projectRoot) {
  if (cachedPages) {
    return cachedPages;
  }

  const pagesDir = path.join(projectRoot, 'src/pages');
  const pages = [];

  try {
    await scanPagesDirectory(pagesDir, '', pages, projectRoot);
    cachedPages = pages;

    if (pages.length > 0 && config.debug) {
      console.log(`📄 Discovered ${pages.length} static pages`);
    }

    return pages;
  } catch (error) {
    console.warn('Could not scan pages directory:', error.message);
    return [];
  }
}

/**
 * Recursively scan pages directory for static pages
 *
 * @param {string} dir - Current directory to scan
 * @param {string} routePrefix - URL prefix built from parent directories
 * @param {StaticPage[]} pages - Array to collect discovered pages
 * @param {string} projectRoot - Project root for relative paths
 */
async function scanPagesDirectory(dir, routePrefix, pages, projectRoot) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip dynamic directories like [slug]
      if (entry.name.startsWith('[') && entry.name.endsWith(']')) {
        continue;
      }
      // Skip underscore-prefixed directories (partials/layouts)
      if (entry.name.startsWith('_')) {
        continue;
      }

      // Recurse into subdirectory
      await scanPagesDirectory(fullPath, `${routePrefix}/${entry.name}`, pages, projectRoot);
    } else if (entry.isFile()) {
      const page = await processPageFile(entry.name, fullPath, routePrefix, projectRoot);
      if (page) {
        pages.push(page);
      }
    }
  }
}

/**
 * Process a single page file and extract metadata
 *
 * @param {string} filename - Just the filename
 * @param {string} fullPath - Full filesystem path to the file
 * @param {string} routePrefix - URL prefix from parent directories
 * @param {string} projectRoot - Project root for relative paths
 * @returns {Promise<StaticPage|null>} - Page object or null if should be excluded
 */
async function processPageFile(filename, fullPath, routePrefix, projectRoot) {
  // Only process .astro, .md, .mdx files
  const validExtensions = ['.astro', '.md', '.mdx'];
  const ext = path.extname(filename);
  if (!validExtensions.includes(ext)) {
    return null;
  }

  // Skip dynamic routes like [slug].astro, [...slug].astro
  if (filename.startsWith('[')) {
    return null;
  }

  // Skip partials (underscore-prefixed)
  if (filename.startsWith('_')) {
    return null;
  }

  // Skip error pages
  const baseName = path.basename(filename, ext);
  const errorPages = ['404', '500'];
  if (errorPages.includes(baseName)) {
    return null;
  }

  // Map filename to URL
  const url = fileToUrl(baseName, routePrefix);

  // Create slug from the path (unique identifier)
  const slug = urlToSlug(url);

  // Create display name from filename
  const name = formatPageName(baseName, routePrefix);

  // Get relative path for display
  const relativePath = path.relative(projectRoot, fullPath);

  // Parse collection references for .astro files
  let collections = [];
  if (ext === '.astro') {
    collections = await parseAstroCollectionRefs(fullPath);
  }

  return {
    path: relativePath,
    slug,
    name,
    url,
    collections,
  };
}

/**
 * Convert filename to URL path
 * index.astro -> /, about.astro -> /about, blog/index.astro -> /blog
 *
 * @param {string} baseName - Filename without extension
 * @param {string} routePrefix - URL prefix from parent directories
 * @returns {string} - URL path
 */
function fileToUrl(baseName, routePrefix) {
  if (baseName === 'index') {
    // index files map to their directory
    return routePrefix || '/';
  }
  return `${routePrefix}/${baseName}`;
}

/**
 * Convert URL to a slug (unique identifier)
 * / -> home, /about -> about, /blog/index -> blog
 *
 * @param {string} url - URL path
 * @returns {string} - Slug
 */
function urlToSlug(url) {
  if (url === '/') {
    return 'home';
  }
  // Remove leading slash and convert slashes to underscores
  return url.slice(1).replace(/\//g, '_');
}

/**
 * Format page name for display
 * index -> "Home" (for root), "Blog" (for /blog/index)
 * about -> "About"
 *
 * @param {string} baseName - Filename without extension
 * @param {string} routePrefix - URL prefix from parent directories
 * @returns {string} - Display name
 */
function formatPageName(baseName, routePrefix) {
  if (baseName === 'index') {
    // Use directory name for index pages, or "Home" for root
    const dirName = routePrefix.split('/').pop();
    return dirName ? capitalize(dirName) : 'Home';
  }
  return capitalize(baseName.replace(/-/g, ' '));
}

/**
 * Capitalize first letter of each word
 *
 * @param {string} str - String to capitalize
 * @returns {string} - Capitalized string
 */
function capitalize(str) {
  return str.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(' ');
}

/**
 * Clear page cache (called when pages change)
 */
export function clearPageCache() {
  cachedPages = null;
}
