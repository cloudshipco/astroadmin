/**
 * Collections utility
 * Reads and parses Astro Content Collections
 *
 * Now uses dynamic schema parsing from config.ts
 */

import path from 'path';
import chokidar from 'chokidar';
import { config } from '../config.js';
import { parseAstroSchemas } from './schema-parser.js';
import { listSlugs, distinctCollections, getCollectionTypeFromDb } from './db.js';

// Cache for parsed schemas
let cachedSchemas = null;
let schemasLoading = null;
let schemaWatcher = null;

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
 * Start watching schema config file for changes
 * Automatically clears cache when config.ts changes
 */
export function watchSchemaConfig() {
  if (schemaWatcher) return; // Already watching

  const projectRoot = config.paths.projectRoot;
  const configPatterns = [
    // Astro 5+ locations
    path.join(projectRoot, 'src/content.config.ts'),
    path.join(projectRoot, 'src/content.config.mts'),
    path.join(projectRoot, 'src/content.config.js'),
    // Astro 4.x legacy locations
    path.join(projectRoot, 'src/content/config.ts'),
    path.join(projectRoot, 'src/content/config.mts'),
    path.join(projectRoot, 'src/content/config.js'),
  ];

  schemaWatcher = chokidar.watch(configPatterns, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500 }
  });

  schemaWatcher.on('change', (filePath) => {
    console.log(`📝 Schema config changed: ${path.basename(filePath)}`);
    clearSchemaCache();
    // Pre-load schemas so next request is fast
    loadSchemas().then(() => {
      console.log('✅ Schemas automatically reloaded');
    }).catch(err => {
      console.error('❌ Failed to reload schemas:', err.message);
    });
  });

}

/**
 * Get list of all collections from parsed schemas.
 * This includes both directory-based (glob) and file-based (file) collections.
 */
export async function getCollectionNames() {
  try {
    // Get collection names from parsed schemas (the source of truth)
    const schemas = await loadSchemas();
    return Object.keys(schemas);
  } catch (error) {
    console.error('Error loading schemas for collection names:', error);

    // Fallback to collections present in the content database
    try {
      return distinctCollections();
    } catch (fallbackError) {
      console.error('Error reading collections from database:', fallbackError);
      return [];
    }
  }
}

/**
 * Get all entry slugs for a collection.
 *
 * Slugs are stored in the content database without a locale suffix, so i18n
 * deduplication is inherent (one row per slug+locale, SELECT DISTINCT slug).
 * The file()-vs-glob distinction no longer affects listing — both are rows;
 * file collections keep their original array order via the `position` column.
 *
 * @param {string} collectionName - Collection name
 */
export async function getCollectionEntries(collectionName) {
  try {
    return listSlugs(collectionName);
  } catch (error) {
    console.error(`Error reading collection ${collectionName}:`, error);
    return [];
  }
}

/**
 * Get entries with their available locales (for i18n sites)
 * @param {string} collectionName - Collection name
 * @param {string[]} locales - Configured locales
 * @returns {Promise<Array<{slug: string, locales: string[]}>>}
 */
export async function getCollectionEntriesWithLocales(collectionName, locales) {
  const { getAvailableLocales } = await import('./content.js');
  const slugs = await getCollectionEntries(collectionName, {
    i18nEnabled: true,
    locales,
  });

  const entries = await Promise.all(
    slugs.map(async (slug) => {
      const availableLocales = await getAvailableLocales(collectionName, slug, locales);
      return {
        slug,
        locales: availableLocales,
      };
    })
  );

  return entries;
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
    // Fall back to database inspection
  }

  // Infer from any stored entry's type
  try {
    return getCollectionTypeFromDb(collectionName) || 'content';
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
 * Build a map of which blocks reference which collections.
 * Aggregates blockCollectionRefs from all schemas that have blocks (typically 'pages').
 *
 * @param {Object} schemas - Loaded schemas from parseAstroSchemas
 * @returns {Object} - Map of collectionName -> [{ type, field }]
 */
function buildCollectionBlockMap(schemas) {
  /** @type {Record<string, Array<{type: string, field: string}>>} */
  const collectionBlockMap = {};

  for (const [schemaName, schemaInfo] of Object.entries(schemas)) {
    const refs = schemaInfo.blockCollectionRefs || {};

    for (const [collectionName, blockRefs] of Object.entries(refs)) {
      if (!collectionBlockMap[collectionName]) {
        collectionBlockMap[collectionName] = [];
      }
      // Add each block reference
      for (const ref of blockRefs) {
        collectionBlockMap[collectionName].push({
          type: ref.blockType,
          field: ref.field,
        });
      }
    }
  }

  return collectionBlockMap;
}

/**
 * Get all collections with their metadata
 * @param {object} options - { i18nEnabled: boolean, locales: string[] }
 */
export async function getAllCollections(options = {}) {
  const collectionNames = await getCollectionNames();

  // Try to load schemas (don't fail if it doesn't work)
  let schemas = {};
  try {
    schemas = await loadSchemas();
  } catch (error) {
    console.warn('Could not load schemas, using basic collection info');
  }

  // Build map of which blocks reference which collections
  const collectionBlockMap = buildCollectionBlockMap(schemas);

  const collections = await Promise.all(
    collectionNames.map(async (name) => {
      // Pass i18n options to getCollectionEntries for proper deduplication
      const entries = await getCollectionEntries(name, options);
      const schemaInfo = schemas[name] || {};

      return {
        name,
        type: schemaInfo.type || await getCollectionType(name),
        entries,
        entryCount: entries.length,
        schema: schemaInfo.schema || { type: 'object', properties: {} },
        discriminatedUnions: schemaInfo.discriminatedUnions || [],
        // Which blocks reference this collection (for component preview)
        usedByBlocks: collectionBlockMap[name] || [],
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
