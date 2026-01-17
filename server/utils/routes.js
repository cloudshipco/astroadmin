/**
 * Route detection utility
 * Auto-detects preview routes by scanning Astro pages directory
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

// Cache for detected routes
let cachedRoutes = null;

/**
 * Pluralize a word (simple English rules)
 * post -> posts, review -> reviews, category -> categories
 */
function pluralize(word) {
  if (word.endsWith('y') && !['ay', 'ey', 'oy', 'uy'].some(v => word.endsWith(v))) {
    return word.slice(0, -1) + 'ies';
  }
  if (word.endsWith('s') || word.endsWith('x') || word.endsWith('ch') || word.endsWith('sh')) {
    return word + 'es';
  }
  return word + 's';
}

/**
 * Singularize a word (simple English rules)
 * posts -> post, reviews -> review, categories -> category
 */
function singularize(word) {
  if (word.endsWith('ies')) {
    return word.slice(0, -3) + 'y';
  }
  if (word.endsWith('es') && (word.endsWith('xes') || word.endsWith('ches') || word.endsWith('shes') || word.endsWith('sses'))) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Extract dynamic param name from filename
 * [slug].astro -> slug
 * [post].astro -> post
 * [...slug].astro -> slug (catch-all)
 */
function extractParamName(filename) {
  const match = filename.match(/^\[(?:\.\.\.)?([^\]]+)\]\.(?:astro|md|mdx)$/);
  return match ? match[1] : null;
}

/**
 * Scan pages directory and detect routes for collections
 * Returns a map of collection name -> route pattern
 */
export async function detectPreviewRoutes() {
  if (cachedRoutes) {
    return cachedRoutes;
  }

  const pagesDir = path.join(config.paths.projectRoot, 'src/pages');
  const routes = {};

  try {
    await scanDirectory(pagesDir, '', routes);
    cachedRoutes = routes;

    if (Object.keys(routes).length > 0) {
      console.log(`🔍 Auto-detected preview routes:`);
      for (const [collection, route] of Object.entries(routes)) {
        console.log(`   ${collection} -> ${route}`);
      }
    }

    return routes;
  } catch (error) {
    console.warn('Could not scan pages directory for routes:', error.message);
    return {};
  }
}

/**
 * Recursively scan a directory for dynamic routes
 */
async function scanDirectory(dir, routePrefix, routes) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Check if directory name is a dynamic param
      const dirParam = extractParamName(entry.name + '.astro'); // Hack to reuse extraction
      if (entry.name.startsWith('[') && entry.name.endsWith(']')) {
        // Dynamic directory like [category] - skip for now (complex nested routes)
        continue;
      }

      // Recurse into subdirectory
      await scanDirectory(fullPath, `${routePrefix}/${entry.name}`, routes);
    } else if (entry.isFile()) {
      const paramName = extractParamName(entry.name);

      if (paramName) {
        // Found a dynamic route file like [post].astro
        const routePattern = `${routePrefix}/{slug}`;

        // Try to match param name to a collection
        // Common patterns: [post] -> posts, [slug] -> (directory name), [review] -> reviews
        const possibleCollections = [
          pluralize(paramName),  // post -> posts
          paramName,             // slug -> slug (if collection is named that)
          singularize(routePrefix.split('/').pop() || ''), // /blog/[post] -> blog (singular)
          routePrefix.split('/').pop() || '', // /blog/[post] -> blog
        ].filter(Boolean);

        // Store all possible mappings (will be filtered against actual collections later)
        for (const collection of possibleCollections) {
          if (!routes[collection]) {
            routes[collection] = routePattern;
          }
        }
      }
    }
  }
}

/**
 * Get preview route for a specific collection
 * Checks user config first, then falls back to auto-detected routes
 */
export async function getPreviewRoute(collectionName, userConfig = {}) {
  // Check user-configured routes first
  const userRoutes = userConfig.preview?.routes || {};
  if (userRoutes[collectionName]) {
    return userRoutes[collectionName];
  }

  // Fall back to auto-detected routes
  const detectedRoutes = await detectPreviewRoutes();
  return detectedRoutes[collectionName] || null;
}

/**
 * Clear route cache (called when pages change)
 */
export function clearRouteCache() {
  cachedRoutes = null;
}
