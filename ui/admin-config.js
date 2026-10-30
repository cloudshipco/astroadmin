/**
 * The admin's settings for the editor (`GET /api/config`: previewUrl,
 * publicUrl, gitEnabled, collectionOrder, i18n, imageCrop), read ONCE per
 * page load and shared: the dashboard reads it at startup and the image
 * library when it opens. A failure (an older server, a stubbed fetch)
 * resolves to `{}` and is not remembered, so the next call asks again.
 */

import { readJson } from './api-response.js';

/** @type {Promise<object>|null} the fetch in flight or its result */
let configPromise = null;

/**
 * @returns {Promise<object>} the config, or `{}` when it cannot be read
 */
export function loadAdminConfig() {
  if (configPromise === null) {
    configPromise = fetch('/api/config')
      .then(readJson)
      .then((data) => (data !== null && typeof data === 'object' ? data : {}))
      .catch((error) => {
        console.error('Failed to load config:', error);
        configPromise = null;
        return {};
      });
  }
  return configPromise;
}
