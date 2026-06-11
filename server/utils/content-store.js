/**
 * Content store dispatcher
 *
 * Selects the active content store at runtime from the merged config's
 * `content.store` — astroadmin.config.js can set it, env
 * `ASTROADMIN_CONTENT_STORE` wins over both: 'files' (default) →
 * content-files.js, 'db' → content-db.js (the shelved SQLite path kept for
 * the SaaS direction).
 *
 * The selected module is imported dynamically and cached, so file-based
 * deployments never load the SQLite driver (and vice versa), and there is no
 * static import cycle with collections.js.
 *
 * Exposes the full storage interface; every function is async so both stores
 * (the file store is async, db.js is sync) present the same shape.
 */

import { getConfig } from '../config.js';

let storePromise = null;

/**
 * The active store mode. Single source of truth for env-vs-config precedence:
 * ASTROADMIN_CONTENT_STORE beats astroadmin.config.js beats the 'files'
 * default. Must read the merged config — the static `config` export never
 * includes astroadmin.config.js overrides.
 */
export async function activeStoreMode() {
  const fullConfig = await getConfig();
  return process.env.ASTROADMIN_CONTENT_STORE || fullConfig.content?.store || 'files';
}

function store() {
  if (!storePromise) {
    storePromise = activeStoreMode().then((mode) =>
      mode === 'db' ? import('./content-db.js') : import('./content-files.js')
    );
  }
  return storePromise;
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
