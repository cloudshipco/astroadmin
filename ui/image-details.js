/**
 * An image's stored details (alt, focalPoint, crop) for the editor's
 * previews, read ONCE per file per page load: `GET
 * /api/images/<filename>/metadata?source=<folder>` (`uploads` is
 * public/images), shared by every field holding the file, like
 * ui/admin-config.js shares the config. A refusal (a 404: the name is not in
 * that folder) is remembered as no details; a failure to reach the server is
 * not, so the next reader asks again. When the library saves details, it
 * records the entry as written (`rememberImageDetails`) and the page is told
 * (`IMAGE_DETAILS_EVENT` on the document), so an open field's preview follows
 * without another request.
 */

import { readJson } from './api-response.js';

/** Dispatched on `document` with `{filename, source, metadata}` when details change. */
export const IMAGE_DETAILS_EVENT = 'astroadmin:image-details';

/** @type {Map<string, Promise<object|null>>} the fetch in flight or its result, by folder and name */
const details = new Map();

const keyOf = (filename, source) => `${source}:${filename}`;

/**
 * @param {string} filename - the file's name in its folder
 * @param {string} [source] - the folder, as the listing names it
 * @returns {Promise<object|null>} `{alt?, focalPoint?, crop?}`, or null for none
 */
export function loadImageDetails(filename, source = 'uploads') {
  const key = keyOf(filename, source);
  if (!details.has(key)) {
    const request = fetch(`/api/images/${encodeURIComponent(filename)}/metadata?source=${encodeURIComponent(source)}`)
      .then(readJson)
      .then((data) => (data?.success && data.metadata && typeof data.metadata === 'object' ? data.metadata : null))
      .catch((error) => {
        console.error('Failed to load image details:', error);
        details.delete(key);
        return null;
      });
    details.set(key, request);
  }
  return details.get(key);
}

/**
 * Record an image's details as the server has just written them, and tell
 * the page. `metadata` null means the image has none.
 * @param {string} filename
 * @param {string} source
 * @param {object|null} metadata
 */
export function rememberImageDetails(filename, source, metadata) {
  const known = metadata && typeof metadata === 'object' ? { ...metadata } : null;
  details.set(keyOf(filename, source), Promise.resolve(known));
  if (typeof document !== 'undefined') {
    // The document's own window's event class: in a test DOM the global one
    // is the runtime's, which the document refuses to dispatch
    const EventClass = document.defaultView?.CustomEvent ?? CustomEvent;
    document.dispatchEvent(new EventClass(IMAGE_DETAILS_EVENT, { detail: { filename, source, metadata: known } }));
  }
}

/** For tests: forget everything read so far. */
export function resetImageDetails() {
  details.clear();
}
