/**
 * Images API
 * Handles image upload, listing, and deletion
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config.js';

const router = express.Router();

// Metadata file path
const METADATA_FILENAME = '.metadata.json';

/**
 * Load image metadata from .metadata.json
 */
async function loadMetadata() {
  const metadataPath = path.join(config.paths.images, METADATA_FILENAME);
  try {
    const data = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Save image metadata to .metadata.json
 */
async function saveMetadata(metadata) {
  const metadataPath = path.join(config.paths.images, METADATA_FILENAME);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

/**
 * Get metadata for a specific image
 */
function getImageMetadata(metadata, filename) {
  return metadata[filename] || {};
}

// Allowed image extensions
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Configure multer storage
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    // Ensure images directory exists
    try {
      await fs.mkdir(config.paths.images, { recursive: true });
    } catch (err) {
      // Directory already exists, ignore
    }
    cb(null, config.paths.images);
  },
  filename: (req, file, cb) => {
    // Generate unique filename while preserving extension
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path.basename(file.originalname, ext)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const timestamp = Date.now();
    const uniqueName = `${baseName}-${timestamp}${ext}`;
    cb(null, uniqueName);
  },
});

// File filter to only allow images
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

/**
 * GET /api/images
 * List all images from both src/assets/images and public/images
 */
router.get('/', async (req, res) => {
  try {
    const allImages = [];
    const seenFilenames = new Set();
    const metadata = await loadMetadata();

    // Helper to get images from a directory
    async function getImagesFromDir(dirPath, source) {
      try {
        await fs.access(dirPath);
        const files = await fs.readdir(dirPath);

        for (const file of files) {
          // Skip metadata file
          if (file === METADATA_FILENAME) continue;

          const ext = path.extname(file).toLowerCase();
          if (!ALLOWED_EXTENSIONS.includes(ext)) continue;
          if (seenFilenames.has(file)) continue; // Skip duplicates

          const filePath = path.join(dirPath, file);
          try {
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) continue;

            const imageMeta = getImageMetadata(metadata, file);
            seenFilenames.add(file);
            allImages.push({
              filename: file,
              url: `/images/${file}`,
              size: stats.size,
              sizeFormatted: formatFileSize(stats.size),
              modified: stats.mtime.toISOString(),
              extension: ext.slice(1),
              source, // 'source' for src/assets/images, 'uploads' for public/images
              alt: imageMeta.alt || '',
              focalPoint: imageMeta.focalPoint || null,
            });
          } catch (err) {
            // Skip files we can't stat
          }
        }
      } catch (err) {
        // Directory doesn't exist, skip
      }
    }

    // Get images from source directory (src/assets/images)
    await getImagesFromDir(config.paths.srcImages, 'source');

    // Get images from uploads directory (public/images)
    await getImagesFromDir(config.paths.images, 'uploads');

    // Sort by modification date (newest first)
    allImages.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    res.json({
      success: true,
      images: allImages,
      count: allImages.length,
    });
  } catch (error) {
    console.error('Error listing images:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list images',
      message: error.message,
    });
  }
});

/**
 * POST /api/images
 * Upload a new image
 */
router.post('/', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided',
      });
    }

    const imageUrl = `/images/${req.file.filename}`;

    console.log(`Image uploaded: ${req.file.filename}`);

    res.json({
      success: true,
      image: {
        filename: req.file.filename,
        url: imageUrl,
        size: req.file.size,
        sizeFormatted: formatFileSize(req.file.size),
        mimetype: req.file.mimetype,
      },
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload image',
      message: error.message,
    });
  }
});

/**
 * GET /api/images/:filename/metadata
 * Get metadata for a specific image
 */
router.get('/:filename/metadata', async (req, res) => {
  try {
    const { filename } = req.params;
    const sanitizedFilename = path.basename(filename);
    const metadata = await loadMetadata();
    const imageMeta = getImageMetadata(metadata, sanitizedFilename);

    res.json({
      success: true,
      filename: sanitizedFilename,
      metadata: imageMeta,
    });
  } catch (error) {
    console.error('Error getting image metadata:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get image metadata',
      message: error.message,
    });
  }
});

/**
 * PUT /api/images/:filename/metadata
 * Update metadata for a specific image
 */
router.put('/:filename/metadata', express.json(), async (req, res) => {
  try {
    const { filename } = req.params;
    const sanitizedFilename = path.basename(filename);
    const { alt, focalPoint } = req.body;

    const metadata = await loadMetadata();

    // Initialize metadata for this file if it doesn't exist
    if (!metadata[sanitizedFilename]) {
      metadata[sanitizedFilename] = {};
    }

    // Update fields that were provided
    if (alt !== undefined) {
      metadata[sanitizedFilename].alt = alt;
    }
    if (focalPoint !== undefined) {
      metadata[sanitizedFilename].focalPoint = focalPoint;
    }

    await saveMetadata(metadata);

    console.log(`Metadata updated for: ${sanitizedFilename}`);

    res.json({
      success: true,
      filename: sanitizedFilename,
      metadata: metadata[sanitizedFilename],
    });
  } catch (error) {
    console.error('Error updating image metadata:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update image metadata',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/images/:filename
 * Delete an uploaded image (cannot delete source images)
 */
router.delete('/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    // Sanitize filename to prevent directory traversal
    const sanitizedFilename = path.basename(filename);

    // Check if it's a source image (not deletable)
    const srcPath = path.join(config.paths.srcImages, sanitizedFilename);
    try {
      await fs.access(srcPath);
      return res.status(403).json({
        success: false,
        error: 'Cannot delete source images. Only uploaded images can be deleted.',
      });
    } catch {
      // Not in source dir, continue
    }

    // Check in uploads directory
    const filePath = path.join(config.paths.images, sanitizedFilename);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({
        success: false,
        error: 'Image not found',
      });
    }

    // Verify it's actually in the images directory (extra security)
    const resolvedPath = path.resolve(filePath);
    const imagesDir = path.resolve(config.paths.images);

    if (!resolvedPath.startsWith(imagesDir)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    await fs.unlink(filePath);

    console.log(`Image deleted: ${sanitizedFilename}`);

    res.json({
      success: true,
      message: 'Image deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete image',
      message: error.message,
    });
  }
});

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Error handling middleware for multer errors
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
      });
    }
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }

  if (err) {
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }

  next();
});

export default router;
