/**
 * The two kinds of file the media library holds, shared by the upload route
 * (server/api/images.js) and the library modal (ui/image-library.js), so the
 * caps and the refusals the editor reads cannot drift apart.
 */

/** @typedef {'image'|'video'} MediaKind */

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif'];
// Not .mov: browsers other than Safari do not reliably play QuickTime files.
export const VIDEO_EXTENSIONS = ['.mp4', '.webm'];

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
// Under the hosted nginx's client_max_body_size (25m) with room for the
// multipart envelope, so the editor gets our refusal, not nginx's 413 page.
export const MAX_VIDEO_SIZE = 20 * 1024 * 1024; // 20MB

/** A cap in whole megabytes, for the sentences an editor reads. */
export const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))}MB`;

export const IMAGE_TOO_LARGE = `File too large. Maximum size is ${megabytes(MAX_IMAGE_SIZE)}`;
export const VIDEO_TOO_LARGE = `Videos must be under ${megabytes(MAX_VIDEO_SIZE)}; export at 720p, about 20 seconds`;
/** For an upload whose kind is not the picker's. */
export const WRONG_KIND = { image: 'This field takes an image, not a video', video: 'This field takes a video (MP4 or WebM)' };

/** The lower-cased extension of a file name, with its dot ('' for none). */
function extensionOf(filename) {
  const match = /\.[^./\\]+$/.exec(String(filename));
  return match ? match[0].toLowerCase() : '';
}

/**
 * What a file is by its name, or null for neither.
 * @param {string} filename
 * @returns {MediaKind|null}
 */
export function mediaKindOf(filename) {
  const extension = extensionOf(filename);
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
  return null;
}

/**
 * Why a file of this kind and size is refused, or null. Content (a video's
 * container) is the server's to check.
 * @param {string} filename
 * @param {number} size - bytes
 * @param {MediaKind} [expectedKind] - the picker's kind, when there is one
 * @returns {string|null}
 */
export function mediaRefusal(filename, size, expectedKind) {
  const kind = mediaKindOf(filename);
  if (!kind) return null; // the server words an unknown type
  if (expectedKind && kind !== expectedKind) return WRONG_KIND[expectedKind];
  if (kind === 'video') return size > MAX_VIDEO_SIZE ? VIDEO_TOO_LARGE : null;
  return size > MAX_IMAGE_SIZE ? IMAGE_TOO_LARGE : null;
}
