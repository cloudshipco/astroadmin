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
  getCollectionSchema,
} from '../utils/collections.js';

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
 */
router.get('/', async (req, res) => {
  try {
    const collections = await getAllCollections();

    res.json({
      success: true,
      collections,
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

    res.json({
      success: true,
      collection: {
        name: collectionName,
        type,
        entries,
        entryCount: entries.length,
        schema: enrichedSchema,
        discriminatedUnions,
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

export default router;
