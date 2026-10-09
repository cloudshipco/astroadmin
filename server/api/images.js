/**
 * Images API
 * Handles image upload, listing, and deletion
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config.js';
import { loadSchemas } from '../utils/collections.js';
import {
  assertDeclaredCollection,
  assertSafeSlug,
  getGlobBaseDirectory,
  isContentPathError,
  resolveProjectPath,
  sanitizePath,
  toPosixPath,
} from '../utils/glob-files.js';

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
 * Get metadata for a specific image (own keys only, so a filename such as
 * `constructor` never reads an inherited value).
 */
function getImageMetadata(metadata, filename) {
  return Object.hasOwn(metadata, filename) ? metadata[filename] : {};
}

/**
 * Where images for Astro image() fields live: src/content/assets/images.
 *
 * An image() field needs a file Astro can IMPORT, by a path relative to the
 * entry (`../assets/images/x.jpg`); a public `/images/x.jpg` fails the build
 * with ImageNotFound. This folder is importable, is staged by the default
 * git.paths (`src/content/`), and is served to the editor at /assets/images
 * (server/index.js serves src/content/assets at /assets).
 */
function assetImagesDirectory() {
  return path.join(config.paths.projectRoot, 'src/content/assets/images');
}

/** The image folders by library `source`, in listing (and lookup) order. */
function imageDirectories() {
  return [
    { source: 'source', directory: config.paths.srcImages, urlBase: '/images' }, // src/assets/images
    { source: 'uploads', directory: config.paths.images, urlBase: '/images' }, // public/images
    { source: 'assets', directory: assetImagesDirectory(), urlBase: '/assets/images' },
  ];
}

// Allowed image extensions
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * The :filename route parameter as an image filename, or null. It must be a
 * bare name (no separators, nothing a basename() would strip), not a dotfile
 * (the metadata file is one), and carry an image extension — which also rules
 * out `__proto__`, `constructor` and the like as metadata keys.
 * @param {unknown} filename
 * @returns {string|null}
 */
function imageFilenameFromParam(filename) {
  if (typeof filename !== 'string' || filename === '' || filename.length > 255) return null;
  if (/[\u0000-\u001f\u007f\\/]/.test(filename)) return null;
  if (filename !== path.basename(filename) || filename.startsWith('.')) return null;
  if (!ALLOWED_EXTENSIONS.includes(path.extname(filename).toLowerCase())) return null;
  return filename;
}

function invalidFilename(res) {
  return res.status(400).json({ success: false, error: 'Invalid image filename' });
}

/**
 * Whether this name is an image the library lists (a file, by stat as the
 * listing does) in either image directory.
 */
async function imageExists(filename) {
  for (const { directory } of imageDirectories()) {
    try {
      if ((await fs.stat(path.join(directory, filename))).isFile()) return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    // ?for=image-field: an image for an Astro image() field goes where Astro
    // can import it; anything else is a public upload, as before.
    const directory = isImageFieldUpload(req) ? assetImagesDirectory() : config.paths.images;
    try {
      await fs.mkdir(directory, { recursive: true });
    } catch (err) {
      // Directory already exists, ignore
    }
    cb(null, directory);
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

function isImageFieldUpload(req) {
  return req.query?.for === 'image-field';
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

/**
 * GET /api/images
 * List all images: src/assets/images, public/images and the image() folder
 */
router.get('/', async (req, res) => {
  try {
    const allImages = [];
    const seenFilenames = new Set();
    const metadata = await loadMetadata();

    // Helper to get images from a directory
    async function getImagesFromDir(dirPath, source, urlBase) {
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
              url: `${urlBase}/${file}`,
              size: stats.size,
              sizeFormatted: formatFileSize(stats.size),
              modified: stats.mtime.toISOString(),
              extension: ext.slice(1),
              source, // 'source': src/assets/images, 'uploads': public/images, 'assets': image() files
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

    for (const { directory, source, urlBase } of imageDirectories()) {
      await getImagesFromDir(directory, source, urlBase);
    }

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

    const imageField = isImageFieldUpload(req);
    const imageUrl = `${imageField ? '/assets/images' : '/images'}/${req.file.filename}`;

    console.log(`Image uploaded: ${req.file.filename}`);

    res.json({
      success: true,
      image: {
        filename: req.file.filename,
        url: imageUrl,
        source: imageField ? 'assets' : 'uploads',
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
 * The directory an entry's file lives in: image() paths are relative to it.
 * Mirrors the files store (content-files.js): a file() collection is one file,
 * a glob entry is `<base>/<slug>.<ext>` (a locale variant sits beside it).
 * @returns {Promise<string>}
 */
async function entryDirectory(collection, slug) {
  const schemas = await loadSchemas();
  assertDeclaredCollection(collection, schemas);
  const schema = schemas[collection] || {};
  if (schema.loaderType === 'file' && schema.loaderFilePath) {
    return path.dirname(resolveProjectPath(schema.loaderFilePath));
  }
  if (schema.loaderType === 'db') {
    const error = new Error('This collection is not stored as files, so an image() path has nothing to be relative to');
    error.status = 400;
    throw error;
  }
  assertSafeSlug(slug);
  return path.dirname(path.join(getGlobBaseDirectory(collection, schema), sanitizePath(slug)));
}

/** Whether two files hold the same bytes. */
async function sameFileContent(firstPath, secondPath) {
  const [first, second] = await Promise.all([fs.readFile(firstPath), fs.readFile(secondPath)]);
  return first.equals(second);
}

/**
 * The library image as a file an image() field can import: an image already
 * in src/content/assets/images or src/assets/images is used where it is; a
 * public upload is copied into src/content/assets/images (under a new name if
 * a different file already has its name).
 * @returns {Promise<{filePath: string, previewUrl: string}|null>}
 */
async function importableImage(filename, preferredSource) {
  const directories = imageDirectories();
  const ordered = [
    ...directories.filter((entry) => entry.source === preferredSource),
    ...directories.filter((entry) => entry.source !== preferredSource),
  ];
  for (const { source, directory, urlBase } of ordered) {
    const candidate = path.join(directory, filename);
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
    } catch {
      continue;
    }
    if (source !== 'uploads') return { filePath: candidate, previewUrl: `${urlBase}/${filename}` };

    const targetDirectory = assetImagesDirectory();
    await fs.mkdir(targetDirectory, { recursive: true });
    let targetName = filename;
    let targetPath = path.join(targetDirectory, targetName);
    try {
      await fs.copyFile(candidate, targetPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await sameFileContent(candidate, targetPath))) {
        const extension = path.extname(filename);
        targetName = `${path.basename(filename, extension)}-${Date.now()}${extension}`;
        targetPath = path.join(targetDirectory, targetName);
        await fs.copyFile(candidate, targetPath, fs.constants.COPYFILE_EXCL);
      }
    }
    return { filePath: targetPath, previewUrl: `/assets/images/${targetName}` };
  }
  return null;
}

/**
 * POST /api/images/:filename/entry-value
 * Body: { collection, slug, source? }
 *
 * The value to store in an Astro image() field of that entry for this library
 * image: a path relative to the entry's file (`../assets/images/x.jpg`), which
 * `astro build` resolves, plus a URL the editor can preview it at. Nothing in
 * the response names a server path.
 */
router.post('/:filename/entry-value', express.json(), async (req, res) => {
  try {
    const filename = imageFilenameFromParam(req.params.filename);
    if (!filename) return invalidFilename(res);
    const { collection, slug, source } = req.body || {};
    if (typeof collection !== 'string' || typeof slug !== 'string') {
      return res.status(400).json({ success: false, error: 'collection and slug are required' });
    }

    const directory = await entryDirectory(collection, slug);
    const image = await importableImage(filename, source);
    if (!image) return res.status(404).json({ success: false, error: 'Image not found' });

    let value = toPosixPath(path.relative(directory, image.filePath));
    if (!value.startsWith('.')) value = `./${value}`;
    res.json({ success: true, value, previewUrl: image.previewUrl });
  } catch (error) {
    if (isContentPathError(error)) {
      return res.status(400).json({ success: false, error: 'Invalid entry', message: error.message });
    }
    if (error.status === 400) return res.status(400).json({ success: false, error: error.message });
    console.error('Error resolving image() value:', error.message);
    res.status(500).json({ success: false, error: 'Failed to resolve the image path' });
  }
});

/**
 * GET /api/images/:filename/metadata
 * Get metadata for a specific image
 */
router.get('/:filename/metadata', async (req, res) => {
  try {
    const sanitizedFilename = imageFilenameFromParam(req.params.filename);
    if (!sanitizedFilename) return invalidFilename(res);
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
    const sanitizedFilename = imageFilenameFromParam(req.params.filename);
    if (!sanitizedFilename) return invalidFilename(res);
    if (!(await imageExists(sanitizedFilename))) {
      return res.status(404).json({ success: false, error: 'Image not found' });
    }
    const { alt, focalPoint } = req.body;

    const metadata = await loadMetadata();

    // Initialize metadata for this file if it doesn't exist
    if (!Object.hasOwn(metadata, sanitizedFilename) || !metadata[sanitizedFilename]) {
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
    // A bare image filename only: no traversal, and never the metadata file.
    const sanitizedFilename = imageFilenameFromParam(req.params.filename);
    if (!sanitizedFilename) return invalidFilename(res);

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
