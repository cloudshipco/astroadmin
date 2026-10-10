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
import { validateStoredEntry } from '../utils/content-validation.js';
import { getConfig } from '../config.js';
import { isContentPathError } from '../utils/glob-files.js';
import { clientErrorMessage } from '../utils/redact-server-paths.js';

const router = express.Router();

/**
 * Answer a refused path (undeclared collection, malformed slug, a file outside
 * its collection) with a 400 whose message names no server path.
 * @returns {boolean} true when the response was sent
 */
function refusedPath(error, res) {
  if (!isContentPathError(error)) return false;
  res.status(400).json({ success: false, error: 'Invalid content path', message: clientErrorMessage(error) });
  return true;
}

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
 * Check a stored entry against its collection schema. After a save, the save
 * has already succeeded and stays saved (an autosave of a half-finished edit must
 * reach disk); the result only tells the editor what the build would reject.
 * Publish is where invalid content is refused.
 * @returns {Promise<import('../utils/content-validation.js').EntryValidation>}
 */
async function validateSavedEntry(collection, slug, locale) {
  try {
    return await validateStoredEntry(collection, slug, locale);
  } catch (error) {
    return { status: 'unchecked', issues: [], reason: clientErrorMessage(error) };
  }
}

/**
 * The body part of a save. A request with NO `body` key says nothing about the
 * body, so the store keeps the stored one (an explicit `body: ''` still clears
 * it). Without this a client that omitted the body, as the editor did for a
 * schema with `blocks`, deleted the entry's markdown on every save.
 *
 * The store reads the stored body itself, inside the file's write queue
 * (`keepStoredBody`). Reading it here, before queueing, let a concurrent save
 * that wrote a new body land in between, and this save then wrote the old
 * body back.
 * @param {Object} requestBody - the parsed request body
 * @returns {{body?: string, keepStoredBody?: boolean}}
 */
function bodyToWrite(requestBody) {
  if (Object.prototype.hasOwnProperty.call(requestBody, 'body')) return { body: requestBody.body };
  return { keepStoredBody: true };
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
      // An entry already broken on disk says so as soon as it is opened.
      validation: await validateSavedEntry(collection, slug, locale),
    });
  } catch (error) {
    if (refusedPath(error, res)) return;
    console.error(`Error reading content ${req.params.collection}/${req.params.slug}:`, error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: 'Content not found',
        message: clientErrorMessage(error),
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to read content',
        message: clientErrorMessage(error),
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
    const { data, type } = req.body;
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
      ...bodyToWrite(req.body),
      type: type || 'content',
    }, locale);

    res.json({
      success: true,
      collection,
      slug,
      locale,
      ...result,
      validation: await validateSavedEntry(collection, slug, locale),
      message: 'Content saved successfully',
    });
  } catch (error) {
    if (refusedPath(error, res)) return;
    console.error(`Error writing content ${req.params.collection}/${req.params.slug}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to write content',
      message: clientErrorMessage(error),
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
    const { data, type } = req.body;
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
      ...bodyToWrite(req.body),
      type: type || 'content',
    }, locale);

    res.json({
      success: true,
      collection,
      slug,
      locale,
      ...result,
      validation: await validateSavedEntry(collection, slug, locale),
      message: 'Content updated successfully',
    });
  } catch (error) {
    if (refusedPath(error, res)) return;
    console.error(`Error updating content ${req.params.collection}/${req.params.slug}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to update content',
      message: clientErrorMessage(error),
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
    if (refusedPath(error, res)) return;
    console.error(`Error deleting content ${req.params.collection}/${req.params.slug}:`, error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: 'Content not found',
        message: clientErrorMessage(error),
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to delete content',
        message: clientErrorMessage(error),
      });
    }
  }
});

export default router;
