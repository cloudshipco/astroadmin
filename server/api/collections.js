/**
 * Collections API Router
 * Endpoints for discovering and listing content collections
 */

import express from 'express';
import {
  getAllCollections,
  getCollectionNames,
  getCollectionEntries,
  getCollectionSchema,
} from '../utils/collections.js';

const router = express.Router();

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
    const { type, schema } = await getCollectionSchema(collectionName);

    res.json({
      success: true,
      collection: {
        name: collectionName,
        type,
        entries,
        entryCount: entries.length,
        schema,
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
