/**
 * Images API
 * Handles image upload, listing, and deletion
 */

import express from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config.js';
import { loadSchemas } from '../utils/collections.js';
import { withCheckoutWrite } from '../utils/checkout-lock.js';
import {
  assertContainedPath,
  assertDeclaredCollection,
  assertSafeSlug,
  getGlobBaseDirectory,
  isContentPathError,
  resolveProjectPath,
  sanitizePath,
  toPosixPath,
} from '../utils/glob-files.js';
import {
  IMAGE_EXTENSIONS,
  IMAGE_TOO_LARGE,
  MAX_IMAGE_SIZE,
  MAX_VIDEO_SIZE,
  VIDEO_EXTENSIONS,
  VIDEO_TOO_LARGE,
  WRONG_KIND,
  mediaKindOf,
  mediaRefusal,
} from '../../ui/media-kinds.js';

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

let metadataQueue = Promise.resolve();

/**
 * Read, change and write the metadata file as one step: one update at a time,
 * inside a checkout hold, so neither another update nor a publish's rebase
 * can land between the read and the write and be overwritten by a stale copy.
 * @param {(metadata: object) => void} change mutates the metadata in place
 * @returns {Promise<object>} the metadata as written
 */
function updateMetadata(change) {
  const run = metadataQueue.then(() => withCheckoutWrite(async () => {
    const metadata = await loadMetadata();
    change(metadata);
    await saveMetadata(metadata);
    return metadata;
  }));
  metadataQueue = run.catch(() => {});
  return run;
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

/**
 * An image file the image() picker reads or writes must lie inside its image
 * folder AND inside the project, both with symlinks resolved
 * (assertContainedPath). A link in a folder, or a folder that is itself a link
 * (a symlinked ancestor), pointing out of the project would otherwise be
 * followed: the outside file copied into the tracked, published
 * src/content/assets/images, or handed to the build as an import, or an
 * upload written outside the repo. Throws a 400 that names no server path.
 * @param {string} directory - the image folder
 * @param {string} filePath - a file in it (it may not exist yet)
 */
async function assertImageInside(directory, filePath) {
  try {
    await assertContainedPath(directory, filePath);
    await assertContainedPath(config.paths.projectRoot, filePath);
  } catch {
    const error = new Error('That image is outside the project\'s image folders');
    error.status = 400;
    throw error;
  }
}

// The library holds images and short videos, both in the same folders, with
// the extensions, caps and refusals shared with the editor (ui/media-kinds.js).
// Videos are public files only (never an Astro image() value).
const ALLOWED_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

// ISO base media brands (`ftyp` major or compatible) of an MP4 that browsers
// play. Many other files are ISO base media too: HEIC and AVIF stills, M4A
// audio, QuickTime. Those are told apart by their MAJOR brand, which says what
// the file is: an M4A lists `isom` and `mp42` among its compatible brands, and
// an Apple M4V video lists `M4A `, so only the major brand can refuse a file.
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ']);
const NOT_MP4_VIDEO_BRANDS = new Set(['qt  ', 'mif1', 'msf1', 'heic', 'heix', 'hevc', 'avif', 'avis', 'M4A ', 'M4B ', 'M4P ', 'F4A ']);

/** The brands of an `ftyp` box at the start of `header`, or null. */
function ftypBrands(header, bytesRead) {
  if (bytesRead < 16 || header.toString('latin1', 4, 8) !== 'ftyp') return null;
  const boxEnd = Math.min(header.readUInt32BE(0), bytesRead);
  const brands = [header.toString('latin1', 8, 12)];
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) brands.push(header.toString('latin1', offset, offset + 4));
  return brands;
}

/**
 * The EBML header's DocType ('webm', 'matroska'), or null. The header is the
 * EBML magic, then its own elements; DocType is element 0x4282 with a one-byte
 * size (ample for the names in use).
 */
function ebmlDocType(header, bytesRead) {
  if (bytesRead < 4 || !header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return null;
  for (let offset = 4; offset + 3 <= bytesRead; offset++) {
    if (header[offset] !== 0x42 || header[offset + 1] !== 0x82 || !(header[offset + 2] & 0x80)) continue;
    const length = header[offset + 2] & 0x7f;
    return header.toString('latin1', offset + 3, Math.min(offset + 3 + length, bytesRead));
  }
  return null;
}

/**
 * Whether a file's first bytes are the container its video extension claims:
 * an `ftyp` box with an MP4 brand (and no still-image, audio or QuickTime
 * brand) for .mp4, an EBML header whose DocType is `webm` for .webm. A renamed
 * file of anything else is refused, a Matroska .mkv renamed .webm included.
 * @param {string} filePath
 * @param {string} extension - '.mp4' or '.webm'
 */
async function isVideoContainer(filePath, extension) {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(128);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (extension === '.webm') return ebmlDocType(header, bytesRead) === 'webm';
    const brands = ftypBrands(header, bytesRead);
    return Boolean(brands)
      && !NOT_MP4_VIDEO_BRANDS.has(brands[0])
      && brands.some((brand) => MP4_BRANDS.has(brand));
  } finally {
    await handle.close();
  }
}

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

/**
 * Where an upload goes: ?for=image-field puts an image for an Astro image()
 * field where Astro can import it; anything else is a public upload. Refuses
 * a folder that resolves out of the project BEFORE creating anything in it
 * (mkdir would follow a linked ancestor).
 */
async function uploadDirectory(req) {
  const directory = isImageFieldUpload(req) ? assetImagesDirectory() : config.paths.images;
  await assertImageInside(path.dirname(directory), path.join(directory, 'upload'));
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

// Multer writes each upload into its own temporary folder OUTSIDE the site, as
// the body streams in. Only a complete file is installed into the checkout
// (installUpload, under a checkout hold), so a publish can never commit half
// an image, and a client that disconnects leaves nothing in the site. The
// folder is removed when the response closes, however the request ended
// (multer removes a partial file on abort, but not the folder).
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'astroadmin-upload-'));
      const removeStaging = () => {
        fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
      };
      req.res.once('close', removeStaging);
      // Bun's node:http does not always emit the response's 'close' when the
      // client abandons the body. The request's 'close' also fires once a
      // complete body has been read, before the file is installed, so it only
      // removes the folder for a body that never completed.
      req.once('close', () => {
        if (!req.complete) removeStaging();
      });
      cb(null, stagingDirectory);
    } catch (error) {
      cb(error);
    }
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

// Only images and videos; a video never goes into an image() field, and a
// picker's upload (`?kind=image|video`) takes only its own kind. The kind is
// kept on the request so a size refusal can name the right limit.
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const refusal = new Error(`File type not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`);
    refusal.status = 400;
    return cb(refusal, false);
  }
  req.uploadKind = mediaKindOf(file.originalname);
  const expectedKind = expectedUploadKind(req);
  if (expectedKind && req.uploadKind !== expectedKind) {
    const refusal = new Error(WRONG_KIND[expectedKind]);
    refusal.status = 400;
    return cb(refusal, false);
  }
  cb(null, true);
};

function isImageFieldUpload(req) {
  return req.query?.for === 'image-field';
}

/**
 * The kind a picker's upload must be (an image() field's, or `?kind=`), or
 * null when the caller did not say.
 * @returns {'image'|'video'|null}
 */
function expectedUploadKind(req) {
  if (isImageFieldUpload(req)) return 'image';
  const kind = req.query?.kind;
  return kind === 'image' || kind === 'video' ? kind : null;
}

// multer has one size limit per instance, so an upload that must be an image
// is streamed under the image cap and stopped there; one that may be either
// gets the video cap, and an image in it is held to its own cap afterwards
// (refuseUpload).
const imageUpload = multer({ storage, fileFilter, limits: { fileSize: MAX_IMAGE_SIZE } }).single('image');
const mediaUpload = multer({ storage, fileFilter, limits: { fileSize: MAX_VIDEO_SIZE } }).single('image');
function upload(req, res, next) {
  return (expectedUploadKind(req) === 'image' ? imageUpload : mediaUpload)(req, res, next);
}

/**
 * Why a complete upload is refused, or null: an image over the image cap, or
 * a "video" whose bytes are not the container its extension names.
 * @returns {Promise<string|null>}
 */
async function refuseUpload(file) {
  const refusal = mediaRefusal(file.filename, file.size);
  if (refusal || mediaKindOf(file.filename) !== 'video') return refusal;
  const isVideo = await isVideoContainer(file.path, path.extname(file.filename).toLowerCase());
  return isVideo ? null : 'That file is not an MP4 or WebM video';
}

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
              kind: mediaKindOf(file),
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
      message: 'The images could not be listed; see the server log.',
    });
  }
});

/**
 * POST /api/images
 * Upload a new image
 */
/**
 * Move a complete upload from its temporary folder into the site: copied to a
 * hidden name beside its destination, then renamed (the temporary folder can
 * be on another filesystem, where a rename fails), all inside a checkout hold.
 */
async function installUpload(uploadedPath, directory, filename) {
  const targetPath = path.join(directory, filename);
  await assertImageInside(directory, targetPath);
  const partialPath = path.join(directory, `.${filename}.uploading`);
  await withCheckoutWrite(async () => {
    try {
      await fs.copyFile(uploadedPath, partialPath, fs.constants.COPYFILE_EXCL);
      await fs.rename(partialPath, targetPath);
    } catch (error) {
      await fs.rm(partialPath, { force: true });
      throw error;
    }
  });
}

router.post('/', upload, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided',
      });
    }

    const refusal = await refuseUpload(req.file);
    if (refusal) return res.status(400).json({ success: false, error: refusal });

    try {
      await installUpload(req.file.path, await uploadDirectory(req), req.file.filename);
    } catch (error) {
      // As when multer wrote into the site: the error middleware words a
      // refusal (a folder outside the project) and a storage failure.
      return next(error);
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
        kind: mediaKindOf(req.file.filename),
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
      message: 'The image could not be saved; see the server log.',
    });
  } finally {
    if (req.file) await fs.rm(path.dirname(req.file.path), { recursive: true, force: true });
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
    // The file the build would import, or the one copied from, must really be
    // in this folder and the project, not wherever a symlink points.
    await assertImageInside(directory, candidate);
    if (source !== 'uploads') return { filePath: candidate, previewUrl: `${urlBase}/${filename}` };

    const targetDirectory = assetImagesDirectory();
    // Checked before mkdir, which would create folders through a linked ancestor.
    await assertImageInside(path.dirname(targetDirectory), path.join(targetDirectory, filename));
    await fs.mkdir(targetDirectory, { recursive: true });
    let targetName = filename;
    let targetPath = path.join(targetDirectory, targetName);
    await assertImageInside(targetDirectory, targetPath);
    await withCheckoutWrite(async () => {
      try {
        await fs.copyFile(candidate, targetPath, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await sameFileContent(candidate, targetPath))) {
          const extension = path.extname(filename);
          targetName = `${path.basename(filename, extension)}-${Date.now()}${extension}`;
          targetPath = path.join(targetDirectory, targetName);
          await assertImageInside(targetDirectory, targetPath);
          await fs.copyFile(candidate, targetPath, fs.constants.COPYFILE_EXCL);
        }
      }
    });
    return { filePath: targetPath, previewUrl: `/assets/images/${targetName}` };
  }
  return null;
}

/** The headers /images and /assets carry (server/index.js): an SVG opened as a document runs nothing. */
function setSandboxHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/**
 * GET /api/images/entry-file?collection=&slug=&path=
 *
 * The image an image() value (a path relative to the entry's file) names,
 * for the editor's preview. Resolved against THIS entry's directory, so two
 * files with one name in src/assets/images and src/content/assets/images each
 * preview as themselves. Only a relative path to an image file inside the
 * project's src/ (symlinks resolved) is served; anything else is a 400 that
 * names no server path.
 */
router.get('/entry-file', async (req, res) => {
  try {
    const { collection, slug, path: value } = req.query;
    if (typeof collection !== 'string' || typeof slug !== 'string' || typeof value !== 'string') {
      return res.status(400).json({ success: false, error: 'collection, slug and path are required' });
    }
    if (!/^\.\.?\//.test(value) || /[\u0000-\u001f\\]/.test(value)
      || !IMAGE_EXTENSIONS.includes(path.extname(value).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Not an entry-relative image path' });
    }
    const directory = await entryDirectory(collection, slug);
    const filePath = path.resolve(directory, value);
    await assertImageInside(path.join(config.paths.projectRoot, 'src'), filePath);
    let realFile;
    try {
      realFile = await fs.realpath(filePath);
      if (!(await fs.stat(realFile)).isFile()) throw new Error('not a file');
    } catch {
      return res.status(404).json({ success: false, error: 'Image not found' });
    }
    setSandboxHeaders(res);
    res.setHeader('Cache-Control', 'private, no-cache');
    // sendFile reports a failure (the file gone or unreadable after the stat
    // above) through this callback, not the try/catch: without one it went to
    // next() and the error middleware, absolute filename and all.
    res.sendFile(realFile, { dotfiles: 'allow' }, (sendError) => {
      if (!sendError) return;
      console.error('Error sending an image() preview:', sendError.message);
      if (res.headersSent) return;
      const missing = sendError.code === 'ENOENT' || sendError.status === 404 || sendError.statusCode === 404;
      res.removeHeader('Cache-Control');
      res.status(missing ? 404 : 500).json({ success: false, error: missing ? 'Image not found' : 'Failed to read the image' });
    });
  } catch (error) {
    if (isContentPathError(error)) {
      return res.status(400).json({ success: false, error: 'Invalid entry', message: error.message });
    }
    if (error.status === 400) return res.status(400).json({ success: false, error: error.message });
    console.error('Error serving an image() preview:', error.message);
    res.status(500).json({ success: false, error: 'Failed to read the image' });
  }
});

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
    if (mediaKindOf(filename) === 'video') {
      return res.status(400).json({ success: false, error: WRONG_KIND.image });
    }
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
      message: 'The image details could not be read; see the server log.',
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

    const metadata = await updateMetadata((current) => {
      // Initialize metadata for this file if it doesn't exist
      if (!Object.hasOwn(current, sanitizedFilename) || !current[sanitizedFilename]) {
        current[sanitizedFilename] = {};
      }
      // Update fields that were provided
      if (alt !== undefined) {
        current[sanitizedFilename].alt = alt;
      }
      if (focalPoint !== undefined) {
        current[sanitizedFilename].focalPoint = focalPoint;
      }
    });

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
      message: 'The image details could not be saved; see the server log.',
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

    await withCheckoutWrite(() => fs.unlink(filePath));

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
      message: 'The image could not be deleted; see the server log.',
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
        error: req.uploadKind === 'video' ? VIDEO_TOO_LARGE : IMAGE_TOO_LARGE,
      });
    }
    // multer's own fixed text ("Unexpected field"), naming no path.
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }

  if (err) {
    // A refusal of ours (the file filter, an image folder outside the
    // project: status 400, fixed text) is the editor's to fix and says why.
    // Anything else gets a fixed message: a filesystem failure (EACCES
    // writing the upload) is ours, and a malformed upload is the request's.
    console.error('Image request failed:', err);
    if (err.status === 400 && !err.syscall) {
      return res.status(400).json({ success: false, error: err.message });
    }
    return res.status(err.syscall ? 500 : 400).json({
      success: false,
      error: err.syscall ? 'Failed to store the image' : 'The upload could not be read',
    });
  }

  next();
});

export default router;
