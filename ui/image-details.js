/**
 * An image's stored details (alt, focalPoint, crop) for the editor's
 * previews, read ONCE per file per page load: `GET
 * /api/images/<filename>/metadata?source=<folder>` (`uploads` is
 * public/images), shared by every field holding the file, like
 * ui/admin-config.js shares the config. A 404 (the name is not in that
 * folder) is remembered as no details; any other failure (a 500 while the
 * metadata file is mid-write, a 401 after the session expired, no server) is
 * not, so the next reader asks again.
 *
 * The page's record of a file is the NEWEST it has: when the library saves
 * details it records the entry as written (`rememberImageDetails`) and the
 * page is told (`IMAGE_DETAILS_EVENT` on the document), so an open field's
 * preview follows without another request; when the library or the gallery
 * editor reads the listing, every upload's details are recorded from it
 * (`rememberImageListing`), so a crop changed in another tab is on the field
 * after the library is opened; an entry equal to a known value is not
 * announced. A reader whose request is still in flight when the
 * record is replaced gets the replacement, never the stale answer, and a
 * request that fails never forgets a record that replaced it.
 */

import { readJson } from './api-response.js';

/** Dispatched on `document` with `{filename, source, metadata}` when details change. */
export const IMAGE_DETAILS_EVENT = 'astroadmin:image-details';

/** @type {Map<string, Promise<object|null>>} the record by folder and name: a fetch in flight, or a settled value */
const details = new Map();
/** @type {Map<string, object|null>} the settled value of each record, once it has one */
const known = new Map();

const keyOf = (filename, source) => `${source}:${filename}`;

/**
 * The file name of a public upload's value (`/images/<name>`), decoded, or
 * null for anything else: a src/assets path, an entry-relative image()
 * value, a URL, a malformed escape, a name that is not one segment. The
 * admin serves src/assets/images at /images too, so a name that is only
 * there is asked for and refused (a 404), which reads as no details.
 * @param {unknown} value
 * @returns {string|null}
 */
export function uploadFilename(value) {
  const match = typeof value === 'string' ? value.match(/^\/images\/([^/?#]+)$/) : null;
  if (!match) return null;
  let filename;
  try {
    filename = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return filename === '' || /[/\\]/.test(filename) ? null : filename;
}

/**
 * @param {string} filename - the file's name in its folder
 * @param {string} [source] - the folder, as the listing names it
 * @returns {Promise<object|null>} `{alt?, focalPoint?, crop?}`, or null for none
 */
export function loadImageDetails(filename, source = 'uploads') {
  const key = keyOf(filename, source);
  if (!details.has(key)) {
    const request = fetch(`/api/images/${encodeURIComponent(filename)}/metadata?source=${encodeURIComponent(source)}`)
      .then(async (response) => {
        if (response.status === 404) return null;
        const data = await readJson(response);
        if (!response.ok || !data?.success) throw new Error(`The server answered ${response.status}`);
        return data.metadata && typeof data.metadata === 'object' ? data.metadata : null;
      })
      .then((metadata) => {
        if (details.get(key) === request) known.set(key, metadata);
        return metadata;
      })
      .catch((error) => {
        console.error('Failed to load image details:', error);
        // Forget this request only: a record that replaced it stays
        if (details.get(key) === request) details.delete(key);
        return null;
      });
    details.set(key, request);
  }
  return currentWhenSettled(key, details.get(key));
}

/** `record`'s value, unless a newer record replaced it by the time it settled: then that one's. */
function currentWhenSettled(key, record) {
  return record.then((value) => {
    const current = details.get(key);
    return current === undefined || current === record ? value : currentWhenSettled(key, current);
  });
}

/**
 * Record an image's details as the server has just written them, and tell
 * the page. `metadata` null means the image has none.
 * @param {string} filename
 * @param {string} source
 * @param {object|null} metadata
 */
export function rememberImageDetails(filename, source, metadata) {
  const entry = record(filename, source, metadata);
  announce(filename, source, entry);
}

/**
 * Record every public upload's details from the listing (`GET /api/images`),
 * as the library and the gallery editor read it, and tell the page of each
 * entry that differs from a value it knew (a crop changed in another tab, a
 * file that has appeared) or that it has no settled record of (never asked,
 * or a request that failed and was forgotten: a preview that showed the
 * failure follows now). An entry whose request is still in flight is
 * recorded without a word: its readers get the record when the request
 * settles.
 * @param {Array<{filename?: string, source?: string, alt?: string, focalPoint?: object|null, crop?: object|null}>} images
 */
export function rememberImageListing(images) {
  if (!Array.isArray(images)) return;
  for (const image of images) {
    if (!image || image.source !== 'uploads' || typeof image.filename !== 'string') continue;
    const key = keyOf(image.filename, image.source);
    const entry = { alt: image.alt, focalPoint: image.focalPoint, crop: image.crop };
    if (known.has(key) && sameDetails(known.get(key), entry)) continue;
    const inFlight = details.has(key) && !known.has(key);
    record(image.filename, image.source, entry);
    if (!inFlight) announce(image.filename, image.source, known.get(key));
  }
}

/**
 * The page's settled record of an image, without a request: its details,
 * null for none, or undefined when nothing has settled (never asked, in
 * flight, or forgotten after a failure).
 * @param {string} filename
 * @param {string} [source]
 * @returns {object|null|undefined}
 */
export function knownImageDetails(filename, source = 'uploads') {
  return known.get(keyOf(filename, source));
}

function record(filename, source, metadata) {
  const entry = metadata && typeof metadata === 'object' ? { ...metadata } : null;
  const key = keyOf(filename, source);
  details.set(key, Promise.resolve(entry));
  known.set(key, entry);
  return entry;
}

function announce(filename, source, metadata) {
  if (typeof document === 'undefined') return;
  // The document's own window's event class: in a test DOM the global one
  // is the runtime's, which the document refuses to dispatch
  const EventClass = document.defaultView?.CustomEvent ?? CustomEvent;
  document.dispatchEvent(new EventClass(IMAGE_DETAILS_EVENT, { detail: { filename, source, metadata } }));
}

/** Whether two records say the same: the GET's entry leaves absent keys out, the listing sends them null or ''. */
function sameDetails(a, b) {
  return JSON.stringify(normalised(a)) === JSON.stringify(normalised(b));
}

function normalised(metadata) {
  const { alt, focalPoint, crop } = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    alt: typeof alt === 'string' ? alt : '',
    focalPoint: focalPoint && typeof focalPoint === 'object' ? [focalPoint.x, focalPoint.y] : null,
    crop: crop && typeof crop === 'object' ? [crop.x, crop.y, crop.width, crop.height] : null,
  };
}
