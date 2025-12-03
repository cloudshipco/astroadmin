/**
 * Collections utility
 * Reads and parses Astro Content Collections
 *
 * Now uses dynamic schema parsing from config.ts
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { parseAstroSchemas } from './schema-parser.js';

// Cache for parsed schemas
let cachedSchemas = null;
let schemasLoading = null;

/**
 * Load and cache schemas from config.ts
 * Uses a singleton pattern to avoid re-parsing
 */
export async function loadSchemas() {
  // Return cached schemas if available
  if (cachedSchemas) {
    return cachedSchemas;
  }

  // If already loading, wait for that to complete
  if (schemasLoading) {
    return schemasLoading;
  }

  // Start loading
  schemasLoading = (async () => {
    try {
      console.log('🔄 Parsing content schemas from config.ts...');
      cachedSchemas = await parseAstroSchemas(config.paths.projectRoot);
      console.log(`✅ Loaded ${Object.keys(cachedSchemas).length} collection schemas`);
      return cachedSchemas;
    } catch (error) {
      console.error('❌ Failed to parse schemas:', error.message);
      // Reset loading state so it can be retried
      schemasLoading = null;
      throw error;
    }
  })();

  return schemasLoading;
}

/**
 * Clear cached schemas (useful for development/testing)
 */
export function clearSchemaCache() {
  cachedSchemas = null;
  schemasLoading = null;
}

/**
 * Get list of all collections by reading the content directory
 */
export async function getCollectionNames() {
  try {
    const contentDir = config.paths.content;
    const entries = await fs.readdir(contentDir, { withFileTypes: true });

    const collections = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);

    return collections;
  } catch (error) {
    console.error('Error reading collections:', error);
    return [];
  }
}

/**
 * Get all entry slugs for a collection
 */
export async function getCollectionEntries(collectionName) {
  try {
    const collectionDir = path.join(config.paths.content, collectionName);

    // Check if directory exists
    try {
      await fs.access(collectionDir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(collectionDir);

    // Filter for .md, .mdx, and .json files
    const contentFiles = entries.filter(file =>
      file.endsWith('.md') ||
      file.endsWith('.mdx') ||
      file.endsWith('.json')
    );

    // Convert filenames to slugs (remove extension)
    const slugs = contentFiles.map(file => {
      const ext = path.extname(file);
      return path.basename(file, ext);
    });

    return slugs;
  } catch (error) {
    console.error(`Error reading collection ${collectionName}:`, error);
    return [];
  }
}

/**
 * Get collection type from schema or file inspection
 */
export async function getCollectionType(collectionName) {
  // First try to get from parsed schema
  try {
    const schemas = await loadSchemas();
    if (schemas[collectionName]) {
      return schemas[collectionName].type || 'content';
    }
  } catch {
    // Fall back to file-based detection
  }

  // File-based heuristic
  const collectionDir = path.join(config.paths.content, collectionName);

  try {
    const entries = await fs.readdir(collectionDir);
    const hasMarkdown = entries.some(file => file.endsWith('.md') || file.endsWith('.mdx'));

    return hasMarkdown ? 'content' : 'data';
  } catch {
    return 'content'; // Default
  }
}

/**
 * Get collection schema from parsed config.ts
 */
export async function getCollectionSchema(collectionName) {
  try {
    const schemas = await loadSchemas();
    const collectionSchema = schemas[collectionName];

    if (!collectionSchema) {
      console.warn(`⚠️  No schema found for collection "${collectionName}"`);
      return {
        type: await getCollectionType(collectionName),
        schema: { type: 'object', properties: {} },
        discriminatedUnions: [],
      };
    }

    return {
      type: collectionSchema.type,
      schema: collectionSchema.schema,
      discriminatedUnions: collectionSchema.discriminatedUnions || [],
    };
  } catch (error) {
    console.error(`Error getting schema for ${collectionName}:`, error.message);
    return {
      type: 'content',
      schema: { type: 'object', properties: {} },
      discriminatedUnions: [],
    };
  }
}

/**
 * Get all collections with their metadata
 */
export async function getAllCollections() {
  const collectionNames = await getCollectionNames();

  // Try to load schemas (don't fail if it doesn't work)
  let schemas = {};
  try {
    schemas = await loadSchemas();
  } catch (error) {
    console.warn('Could not load schemas, using basic collection info');
  }

  const collections = await Promise.all(
    collectionNames.map(async (name) => {
      const entries = await getCollectionEntries(name);
      const schemaInfo = schemas[name] || {};

      return {
        name,
        type: schemaInfo.type || await getCollectionType(name),
        entries,
        entryCount: entries.length,
        schema: schemaInfo.schema || { type: 'object', properties: {} },
        discriminatedUnions: schemaInfo.discriminatedUnions || [],
      };
    })
  );

  return collections;
}

/**
 * Check if a collection has discriminated unions (for block editor)
 */
export async function hasBlockEditor(collectionName) {
  try {
    const schemas = await loadSchemas();
    const schema = schemas[collectionName];

    if (!schema) return false;

    return (schema.discriminatedUnions || []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Get all entries with preview data for a collection
 * Returns entries with slug, title, and preview text
 */
export async function getCollectionEntriesWithPreview(collectionName) {
  const { readContent } = await import('./content.js');
  const slugs = await getCollectionEntries(collectionName);

  const entries = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const content = await readContent(collectionName, slug);
        const data = content.data || {};

        // Try to extract a title from common field names
        const title = data.title || data.name || data.heading || slug;

        // Try to extract preview text from common field names
        const previewFields = ['quote', 'description', 'content', 'excerpt', 'summary', 'subheading'];
        let preview = '';
        for (const field of previewFields) {
          if (data[field] && typeof data[field] === 'string') {
            preview = data[field].substring(0, 100);
            if (data[field].length > 100) preview += '...';
            break;
          }
        }

        return {
          slug,
          title,
          preview,
          data, // Include all frontmatter for richer display
        };
      } catch (error) {
        // If we can't read the file, just return basic info
        return {
          slug,
          title: slug,
          preview: '',
        };
      }
    })
  );

  return entries;
}
