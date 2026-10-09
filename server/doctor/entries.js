/**
 * Every content entry with the page it renders to, for the built-HTML checks.
 *
 * Uses the editor's own configuration, store and schemas, so it must be loaded
 * after ASTROADMIN_PROJECT_ROOT is set (the CLI imports it dynamically).
 * Page paths follow the editor's preview: a `pages` entry is `/<slug>` (`home`
 * is `/`), any other collection uses its preview route (configured, else
 * detected from src/pages). Default locale only.
 *
 * Entries with no page of their own are included too (pagePath null): a page
 * can still show them as cards, named by data-aa-entry. The coverage check
 * reports the ones shown nowhere.
 *
 * Everything is read from the editor's ASTROADMIN_PROJECT_ROOT. In the editor,
 * the doctor's scan runs in a child process whose root is the publish check's
 * worktree (./editor-scan.js), so entries, schemas and routes are the commit's.
 */

import { getConfig } from '../config.js';
import { loadSchemas } from '../utils/collections.js';
import { enrichSchemaWithBlockTypes } from '../utils/block-types.js';
import { listSlugs, readContent } from '../utils/content-store.js';
import { getPreviewRoute } from '../utils/routes.js';

/**
 * Top-level keys whose value is a block list (an array of a discriminated union).
 * @param {Array<{path: string[]}>} discriminatedUnions
 */
function blockArrayKeys(discriminatedUnions = []) {
  return discriminatedUnions
    .filter((union) => union.path.length === 2 && union.path[1] === '[]')
    .map((union) => union.path[0]);
}

function pagePathFor(collection, slug, route) {
  if (collection === 'pages') return slug === 'home' ? '/' : `/${slug}`;
  if (!route) return null;
  return route.replace('{slug}', slug);
}

/**
 * @returns {Promise<{entries: import('./coverage.js').DoctorEntry[]}>}
 */
export async function collectEntries() {
  const fullConfig = await getConfig();
  const schemas = await loadSchemas();
  const entries = [];
  for (const [collection, info] of Object.entries(schemas)) {
    const route = collection === 'pages' ? null : await getPreviewRoute(collection, fullConfig);
    let slugs = [];
    try {
      slugs = await listSlugs(collection);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const pagePath = pagePathFor(collection, slug, route);
      let content;
      try {
        content = await readContent(collection, slug);
      } catch {
        continue;
      }
      entries.push({
        collection,
        slug,
        pagePath,
        data: content.data || {},
        body: typeof content.body === 'string' ? content.body : null,
        // As the editor's form receives it, so its control names are the editor's.
        schema: info.schema ? enrichSchemaWithBlockTypes(info.schema, info.discriminatedUnions) : null,
        blockArrays: blockArrayKeys(info.discriminatedUnions),
      });
    }
  }
  return { entries };
}
