/**
 * Content API Router
 * CRUD operations for content entries
 */

import express from 'express';
import {
  readContent,
  writeContent,
  deleteContent,
  contentExists,
} from '../utils/content.js';

const router = express.Router();

/**
 * GET /api/content/:collection/:slug
 * Read a content entry
 */
router.get('/:collection/:slug', async (req, res) => {
  try {
    const { collection, slug } = req.params;

    const content = await readContent(collection, slug);

    res.json({
      success: true,
      collection,
      slug,
      ...content,
    });
  } catch (error) {
    console.error(`Error reading content ${req.params.collection}/${req.params.slug}:`, error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: 'Content not found',
        message: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to read content',
        message: error.message,
      });
    }
  }
});

/**
 * POST /api/content/:collection/:slug
 * Create or update a content entry
 */
router.post('/:collection/:slug', async (req, res) => {
  try {
    const { collection, slug } = req.params;
    const { data, body, type } = req.body;

    // Validate request
    if (!data) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: data',
      });
    }

    // Write content
    const result = await writeContent(collection, slug, {
      data,
      body,
      type: type || 'content',
    });

    res.json({
      success: true,
      collection,
      slug,
      ...result,
      message: 'Content saved successfully',
    });
  } catch (error) {
    console.error(`Error writing content ${req.params.collection}/${req.params.slug}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to write content',
      message: error.message,
    });
  }
});

/**
 * PUT /api/content/:collection/:slug
 * Update a content entry (alias for POST)
 */
router.put('/:collection/:slug', async (req, res) => {
  try {
    const { collection, slug } = req.params;
    const { data, body, type } = req.body;

    // Check if content exists
    const exists = await contentExists(collection, slug);
    if (!exists) {
      return res.status(404).json({
        success: false,
        error: 'Content not found',
        message: `Cannot update non-existent content: ${collection}/${slug}`,
      });
    }

    // Write content
    const result = await writeContent(collection, slug, {
      data,
      body,
      type: type || 'content',
    });

    res.json({
      success: true,
      collection,
      slug,
      ...result,
      message: 'Content updated successfully',
    });
  } catch (error) {
    console.error(`Error updating content ${req.params.collection}/${req.params.slug}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to update content',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/content/:collection/:slug
 * Delete a content entry
 */
router.delete('/:collection/:slug', async (req, res) => {
  try {
    const { collection, slug } = req.params;

    const result = await deleteContent(collection, slug);

    res.json({
      success: true,
      collection,
      slug,
      ...result,
      message: 'Content deleted successfully',
    });
  } catch (error) {
    console.error(`Error deleting content ${req.params.collection}/${req.params.slug}:`, error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: 'Content not found',
        message: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to delete content',
        message: error.message,
      });
    }
  }
});

export default router;
