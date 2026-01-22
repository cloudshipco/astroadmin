/**
 * Collections API Router
 * Endpoints for discovering and listing content collections
 */

import express from 'express';
import {
  getAllCollections,
  getCollectionNames,
  getCollectionEntries,
  getCollectionEntriesWithPreview,
  getCollectionEntriesWithLocales,
  getCollectionSchema,
} from '../utils/collections.js';
import { getConfig } from '../config.js';
import { detectPreviewRoutes, getPreviewRoute } from '../utils/routes.js';
import { discoverStaticPages } from '../utils/page-discovery.js';

const router = express.Router();

/**
 * Convert discriminatedUnions to blockTypes format on schema fields
 * This bridges the zod-to-json-schema output to what form-generator expects
 */
function enrichSchemaWithBlockTypes(schema, discriminatedUnions) {
  if (!discriminatedUnions || discriminatedUnions.length === 0) {
    return schema;
  }

  // Deep clone to avoid mutations
  const enriched = JSON.parse(JSON.stringify(schema));

  for (const union of discriminatedUnions) {
    // Navigate to the field at the union path
    let target = enriched;
    const pathToField = union.path.filter(p => p !== '[]'); // Remove array markers

    for (const key of pathToField) {
      if (target?.properties?.[key]) {
        target = target.properties[key];
      } else {
        target = null;
        break;
      }
    }

    if (target && target.type === 'array') {
      // Convert options to blockTypes format
      const blockTypes = {};
      for (const option of union.options) {
        blockTypes[option.value] = option.schema || { type: 'object', properties: {} };
      }
      target.blockTypes = blockTypes;
    }
  }

  return enriched;
}

/**
 * GET /api/collections
 * Get all collections with their metadata
 * Includes i18n configuration for frontend locale handling
 * Includes auto-detected preview routes for each collection
 */
router.get('/', async (req, res) => {
  try {
    const fullConfig = await getConfig();
    const i18nConfig = fullConfig.i18n || { enabled: false };

    // Pass i18n options for proper entry deduplication
    const collections = await getAllCollections({
      i18nEnabled: i18nConfig.enabled,
      locales: i18nConfig.locales,
    });

    // Detect preview routes for collections
    const detectedRoutes = await detectPreviewRoutes();
    const userRoutes = fullConfig.preview?.routes || {};

    // Add preview route to each collection
    const collectionsWithRoutes = collections.map(collection => ({
      ...collection,
      // User config takes precedence over auto-detected
      previewRoute: userRoutes[collection.name] || detectedRoutes[collection.name] || null,
    }));

    // Discover static pages from src/pages/
    const staticPages = await discoverStaticPages(fullConfig.paths?.projectRoot || process.cwd());

    res.json({
      success: true,
      collections: collectionsWithRoutes,
      pages: staticPages,
      i18n: {
        enabled: i18nConfig.enabled,
        defaultLocale: i18nConfig.defaultLocale,
        locales: i18nConfig.locales,
      },
    });
  } catch (error) {
    console.error('Error fetching collections:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch collections',
      message: error.message,
    });
  }
});

/**
 * GET /api/collections/:collectionName
 * Get details about a specific collection
 */
router.get('/:collectionName', async (req, res) => {
  try {
    const { collectionName } = req.params;

    const entries = await getCollectionEntries(collectionName);
    const { type, schema, discriminatedUnions } = await getCollectionSchema(collectionName);

    // Convert discriminatedUnions to blockTypes format for form-generator
    const enrichedSchema = enrichSchemaWithBlockTypes(schema, discriminatedUnions);

    // Get usedByBlocks from the full collections list
    // This tells us which block types reference this collection
    const allCollections = await getAllCollections();
    const thisCollection = allCollections.find(c => c.name === collectionName);
    const usedByBlocks = thisCollection?.usedByBlocks || [];

    res.json({
      success: true,
      collection: {
        name: collectionName,
        type,
        entries,
        entryCount: entries.length,
        schema: enrichedSchema,
        discriminatedUnions,
        usedByBlocks,
      },
    });
  } catch (error) {
    console.error(`Error fetching collection ${req.params.collectionName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch collection',
      message: error.message,
    });
  }
});

/**
 * GET /api/collections/:collectionName/entries
 * Get list of entry slugs for a collection
 */
router.get('/:collectionName/entries', async (req, res) => {
  try {
    const { collectionName } = req.params;
    const { preview } = req.query;

    // If preview=true, return entries with preview data
    if (preview === 'true') {
      const entries = await getCollectionEntriesWithPreview(collectionName);
      return res.json({
        success: true,
        collection: collectionName,
        entries,
        count: entries.length,
      });
    }

    // Default: return just slugs
    const entries = await getCollectionEntries(collectionName);

    res.json({
      success: true,
      collection: collectionName,
      entries,
      count: entries.length,
    });
  } catch (error) {
    console.error(`Error fetching entries for ${req.params.collectionName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch entries',
      message: error.message,
    });
  }
});

/**
 * GET /api/collections/:collectionName/entries-with-locales
 * Get entries with their available locales (for i18n sites)
 * Returns which locales exist for each entry
 */
router.get('/:collectionName/entries-with-locales', async (req, res) => {
  try {
    const { collectionName } = req.params;
    const fullConfig = await getConfig();

    if (!fullConfig.i18n?.enabled) {
      return res.status(400).json({
        success: false,
        error: 'i18n is not enabled',
        message: 'This endpoint requires i18n to be enabled in astroadmin.config.js',
      });
    }

    const entries = await getCollectionEntriesWithLocales(
      collectionName,
      fullConfig.i18n.locales
    );

    res.json({
      success: true,
      collection: collectionName,
      entries,
      locales: fullConfig.i18n.locales,
      count: entries.length,
    });
  } catch (error) {
    console.error(`Error fetching entries with locales for ${req.params.collectionName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch entries',
      message: error.message,
    });
  }
});

export default router;
