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
import {
  listSlugs,
  listEntries,
  distinctCollections,
  getCollectionType as getCollectionTypeFromStore,
  getAvailableLocales,
} from './content.js';
import { isContentPathError } from './glob-files.js';

// Cache for parsed schemas
let cachedSchemas = null;
let schemasLoading = null;
let schemaWatcher = null;
// Bumped by every clearSchemaCache, so caches derived from the schemas (the
// preview routes, which keep only declared collections) can tell a reload
// happened, including one that lands while they are being computed.
let schemaGeneration = 0;

// The parser loadSchemas calls; replaced only by tests (setSchemaParserForTests).
let parseSchemas = parseAstroSchemas;

/** For tests: parse with `parser` (null restores the real one). */
export function setSchemaParserForTests(parser) {
  parseSchemas = parser || parseAstroSchemas;
}

/** The current schema generation (see clearSchemaCache). */
export function getSchemaGeneration() {
  return schemaGeneration;
}

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

  // Start loading. The load belongs to this generation: if clearSchemaCache
  // runs while it parses, its result (from the old config) is returned to its
  // own callers but never cached, and its failure never clears a newer load's
  // promise. Otherwise a late old load overwrote the new generation's schemas,
  // and the route cache stored the old collections under the new generation.
  const generation = schemaGeneration;
  const loading = (async () => {
    try {
      console.log('🔄 Parsing content schemas from content.config.ts...');
      const schemas = await parseSchemas(config.paths.projectRoot);
      console.log(`✅ Loaded ${Object.keys(schemas).length} collection schemas`);
      if (generation === schemaGeneration) cachedSchemas = schemas;
      return schemas;
    } catch (error) {
      console.error('❌ Failed to parse schemas:', error.message);
      throw error;
    } finally {
      // Settled: a retry (after a failure) starts a fresh load. Only this
      // load's own promise is cleared.
      if (schemasLoading === loading) schemasLoading = null;
    }
  })();
  schemasLoading = loading;

  return loading;
}

/**
 * Clear cached schemas (useful for development/testing)
 */
export function clearSchemaCache() {
  cachedSchemas = null;
  schemasLoading = null;
  schemaGeneration++;
}

/**
 * Start watching schema config file for changes
 * Automatically clears cache when config.ts changes
 */
export function watchSchemaConfig() {
  if (schemaWatcher) return; // Already watching

  const projectRoot = config.paths.projectRoot;
  const configPatterns = [
    path.join(projectRoot, 'src/content.config.ts'),
    path.join(projectRoot, 'src/content.config.mts'),
    path.join(projectRoot, 'src/content.config.js'),
    path.join(projectRoot, 'src/content.config.mjs'),
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

    // Fallback to collections present in the content store. Only the db store
    // can answer without schemas (the files store needs them to locate
    // collections, so files mode degrades to []). Must await — the store
    // functions are async, and an un-awaited return would skip the catch.
    try {
      return await distinctCollections();
    } catch (fallbackError) {
      console.error('Error reading collections from the content store:', fallbackError);
      return [];
    }
  }
}

/**
 * Get all entry slugs for a collection.
 *
 * The store handles i18n deduplication itself (the db store keys rows by
 * slug+locale; the file store strips locale suffixes via the merged config),
 * so listing needs no i18n options. file() collections keep their original
 * array order.
 *
 * @param {string} collectionName - Collection name
 */
export async function getCollectionEntries(collectionName) {
  try {
    // Must await — listSlugs is async, and an un-awaited return would skip
    // the catch and bubble store errors to API callers as 500s.
    return await listSlugs(collectionName);
  } catch (error) {
    // A request for an undeclared collection is the caller's error (400), not
    // an empty collection.
    if (isContentPathError(error)) throw error;
    console.error(`Error reading collection ${collectionName}:`, error);
    return [];
  }
}

/**
 * Every entry with its data (`{slug, data}`, or `{slug, error}` for one that
 * cannot be read), listed and read in one pass: a file() collection's file is
 * read once, not once per entry. Errors as getCollectionEntries.
 * @param {string} collectionName
 */
async function getCollectionEntriesWithData(collectionName) {
  try {
    return await listEntries(collectionName);
  } catch (error) {
    if (isContentPathError(error)) throw error;
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
  const slugs = await getCollectionEntries(collectionName);

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
    return (await getCollectionTypeFromStore(collectionName)) || 'content';
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
export function buildCollectionBlockMap(schemas) {
  /** @type {Record<string, Array<{type: string, field: string}>>} */
  const collectionBlockMap = {};

  for (const [schemaName, schemaInfo] of Object.entries(schemas)) {
    const refs = schemaInfo.blockCollectionRefs || {};

    // Already DECLARED collection names: the schema parser resolves a field
    // (`teamIds` -> `teams` or `team`, ...) with resolveCollectionName.
    for (const [collectionName, blockRefs] of Object.entries(refs)) {
      if (!collectionBlockMap[collectionName]) {
        collectionBlockMap[collectionName] = [];
      }
      // Add each block reference
      for (const ref of blockRefs) {
        collectionBlockMap[collectionName].push({
          type: ref.blockType,
          field: ref.field,
          // A single id or reference() (not a list), and whether it is an
          // Astro reference(): the preview builds the field value from these.
          ...(ref.single ? { single: true } : {}),
          ...(ref.reference ? { reference: true } : {}),
        });
      }
    }
  }

  return collectionBlockMap;
}

/**
 * Which block types reference a collection (for component preview). Derived
 * purely from the cached schemas — no store/filesystem access.
 */
export async function getCollectionUsedByBlocks(collectionName) {
  try {
    const schemas = await loadSchemas();
    return buildCollectionBlockMap(schemas)[collectionName] || [];
  } catch {
    return [];
  }
}

/**
 * Humanise a slug into a display label. Used as the last-resort title when an
 * entry has no title/name/heading field, so the page selector reads "Agencies"
 * rather than "agencies".
 */
function humaniseSlug(slug) {
  const s = String(slug).replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A display title for each entry listed with its data
 * (getCollectionEntriesWithData), keyed by slug.
 *
 * Lets the page selector show "Journal" for an entry whose slug is "blog"
 * (its slug matches the URL it is served at, which the preview navigation
 * relies on, but is a poor label). Falls back to a humanised slug when the
 * entry has no title-like field, and to the raw slug if the file can't be read.
 * @returns {Record<string, string>}
 */
function entryTitlesOf(listed) {
  return Object.fromEntries(listed.map(({ slug, data, error }) => {
    if (error) return [slug, slug];
    const fields = data || {};
    return [slug, fields.title || fields.name || fields.heading || humaniseSlug(slug)];
  }));
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

  // Build map of which blocks reference which collections
  const collectionBlockMap = buildCollectionBlockMap(schemas);

  const collections = await Promise.all(
    collectionNames.map(async (name) => {
      // One pass lists the entries and reads their titles. A collection the
      // store refuses by name is listed empty, as any other unreadable one
      // is: the whole list must not fail for it.
      let listed;
      try {
        listed = await getCollectionEntriesWithData(name);
      } catch (error) {
        if (!isContentPathError(error)) throw error;
        console.error(`Collection ${JSON.stringify(name)} cannot be listed:`, error.message);
        listed = [];
      }
      const entries = listed.map(({ slug }) => slug);
      const entryTitles = entryTitlesOf(listed);
      const schemaInfo = schemas[name] || {};

      return {
        name,
        type: schemaInfo.type || await getCollectionType(name),
        entries,
        // Display label per entry (slug -> title); the selector shows this
        // instead of the raw slug. Slugs stay in `entries` for value/URL use.
        entryTitles,
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
  const listed = await getCollectionEntriesWithData(collectionName);

  return listed.map(({ slug, data: storedData, error }) => {
    // If we can't read the entry, just return basic info
    if (error) return { slug, title: slug, preview: '' };
    const data = storedData || {};

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
  });
}
