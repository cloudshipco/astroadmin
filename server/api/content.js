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
import { getConfig } from '../config.js';

const router = express.Router();

/**
 * Extract locale from request query param
 * Returns null if i18n is disabled or no valid locale specified
 * @param {Request} req - Express request
 * @returns {Promise<string|null>} - Locale code or null
 */
async function getLocaleFromRequest(req) {
  const fullConfig = await getConfig();

  // If i18n is disabled, always return null
  if (!fullConfig.i18n?.enabled) {
    return null;
  }

  const locale = req.query.locale;

  // Validate locale is in configured list
  if (locale && fullConfig.i18n.locales.includes(locale)) {
    return locale;
  }

  // Return default locale if none specified
  return fullConfig.i18n.defaultLocale;
}

/**
 * GET /api/content/:collection/:slug
 * Read a content entry
 * Query params: ?locale=en (optional, uses default locale if i18n enabled)
 */
router.get('/:collection/:slug', async (req, res) => {
  try {
    const { collection, slug } = req.params;
    const locale = await getLocaleFromRequest(req);

    const content = await readContent(collection, slug, locale);

    res.json({
      success: true,
      collection,
      slug,
      locale,
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
 * Query params: ?locale=en (optional, uses default locale if i18n enabled)
 */
router.post('/:collection/:slug', async (req, res) => {
  try {
    const { collection, slug } = req.params;
    const { data, body, type } = req.body;
    const locale = await getLocaleFromRequest(req);

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
    }, locale);

    res.json({
      success: true,
      collection,
      slug,
      locale,
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
 * Query params: ?locale=en (optional, uses default locale if i18n enabled)
 */
router.put('/:collection/:slug', async (req, res) => {
  try {
    const { collection, slug } = req.params;
    const { data, body, type } = req.body;
    const locale = await getLocaleFromRequest(req);

    // Check if content exists
    const exists = await contentExists(collection, slug, locale);
    if (!exists) {
      const localeHint = locale ? ` (${locale})` : '';
      return res.status(404).json({
        success: false,
        error: 'Content not found',
        message: `Cannot update non-existent content: ${collection}/${slug}${localeHint}`,
      });
    }

    // Write content
    const result = await writeContent(collection, slug, {
      data,
      body,
      type: type || 'content',
    }, locale);

    res.json({
      success: true,
      collection,
      slug,
      locale,
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
 * Query params: ?locale=en (optional, uses default locale if i18n enabled)
 */
router.delete('/:collection/:slug', async (req, res) => {
  try {
    const { collection, slug } = req.params;
    const locale = await getLocaleFromRequest(req);

    const result = await deleteContent(collection, slug, locale);

    res.json({
      success: true,
      collection,
      slug,
      locale,
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
