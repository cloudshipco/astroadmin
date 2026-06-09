/**
 * Content store dispatcher
 *
 * Selects the active content store at runtime from `config.content.store`
 * (env `ASTROADMIN_CONTENT_STORE` wins): 'files' (default) → content-files.js,
 * 'db' → content-db.js (the shelved SQLite path kept for the SaaS direction).
 *
 * The selected module is imported dynamically and cached, so file-based
 * deployments never load the SQLite driver (and vice versa), and there is no
 * static import cycle with collections.js.
 *
 * Exposes the full storage interface; every function is async so both stores
 * (the file store is async, db.js is sync) present the same shape.
 */

import { config } from '../config.js';

let storePromise = null;

function store() {
  if (!storePromise) {
    const mode = process.env.ASTROADMIN_CONTENT_STORE || config.content?.store || 'files';
    storePromise = mode === 'db' ? import('./content-db.js') : import('./content-files.js');
  }
  return storePromise;
}

/** Test/diagnostic helper: which store is active without forcing a load. */
export function activeStoreMode() {
  return process.env.ASTROADMIN_CONTENT_STORE || config.content?.store || 'files';
}

export async function readContent(...args) {
  return (await store()).readContent(...args);
}
export async function writeContent(...args) {
  return (await store()).writeContent(...args);
}
export async function deleteContent(...args) {
  return (await store()).deleteContent(...args);
}
export async function contentExists(...args) {
  return (await store()).contentExists(...args);
}
export async function getAvailableLocales(...args) {
  return (await store()).getAvailableLocales(...args);
}
export async function listSlugs(...args) {
  return (await store()).listSlugs(...args);
}
export async function distinctCollections(...args) {
  return (await store()).distinctCollections(...args);
}
export async function getCollectionType(...args) {
  return (await store()).getCollectionType(...args);
}
