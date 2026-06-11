/**
 * Database → files exporter (the inverse of import-files.js)
 *
 * One-time migration off the SQLite content store back to on-disk files, so a
 * site can move from the DB content-layer loader to Astro's native glob()/file()
 * loaders (Option B). Reads every row from the content store and writes it
 * through the file store, preserving frontmatter/body, data JSON, locales, and
 * file()-collection array order.
 *
 * Run via `astroadmin export` AFTER switching the site's content.config.ts from
 * astroadminLoader to its target glob()/file() loaders: the parsed loaders tell
 * the exporter exactly where each collection lives on disk (glob base/pattern,
 * the file() array path) and which markdown extension the glob expects. A
 * collection still declaring astroadminLoader has none of that: if its rows
 * came from a file() loader the export fails (per-entry files would lose the
 * array order), otherwise it falls back to the conventional
 * `src/content/<collection>/` layout with a loud warning.
 *
 * Bridges stores directly: reads db.js, writes content-files.js (not the
 * dispatcher), so it works regardless of the active content.store setting.
 */

import { loadSchemas } from './collections.js';
import { listAllEntries } from './db.js';
import { writeContent, writeFileCollectionArray } from './content-files.js';
import { resolveProjectPath } from './glob-files.js';

/**
 * Export every content-store entry to files.
 * @returns {Promise<{total: number, files: number, collections: Record<string, number>}>}
 */
export async function exportFiles() {
  const schemas = await loadSchemas();
  const rows = listAllEntries();

  // Group rows by collection, preserving the listAllEntries order (position).
  const byCollection = new Map();
  for (const row of rows) {
    if (!byCollection.has(row.collection)) byCollection.set(row.collection, []);
    byCollection.get(row.collection).push(row);
  }

  const summary = { total: 0, files: 0, collections: {} };

  for (const [collection, collectionRows] of byCollection) {
    const schema = schemas[collection] || {};
    const isFileCollection = schema.loaderType === 'file' && schema.loaderFilePath;

    if (schema.loaderType === 'db') {
      // Rows imported from a file() loader carry array positions; exporting
      // them as per-entry files would silently lose the array order, so make
      // the user fix the config rather than warn-and-corrupt.
      const hasFilePositions = collectionRows.some(
        (row) => row.position !== null && row.position !== undefined
      );
      if (hasFilePositions) {
        throw new Error(
          `Collection "${collection}" was imported from a file() loader (its rows carry ` +
            `array positions) but content.config.ts still declares astroadminLoader for it. ` +
            `Switch the loader back to file() first, then re-run the export.`
        );
      }
      console.warn(
        `⚠️  Collection "${collection}" still uses astroadminLoader in content.config.ts, ` +
          `so the exporter doesn't know its target layout — falling back to ` +
          `src/content/${collection}/. Switch the loader to glob() first to control ` +
          `the base/pattern, then re-run the export.`
      );
    }

    if (isFileCollection) {
      // file() loader: rebuild the single JSON array, ordered by position,
      // through the file store's canonical array writer.
      const ordered = [...collectionRows].sort(
        (a, b) => (a.position ?? 0) - (b.position ?? 0)
      );
      const array = ordered.map((row) => JSON.parse(row.data));
      await writeFileCollectionArray(resolveProjectPath(schema.loaderFilePath), array);
      summary.files += 1;
    } else {
      // glob (or still-db) loader: one file per entry; writeContent honours
      // loaderBase and derives the extension from the loader pattern.
      for (const row of collectionRows) {
        await writeContent(
          collection,
          row.slug,
          { data: JSON.parse(row.data), body: row.body, type: row.type },
          row.locale
        );
        summary.files += 1;
      }
    }

    summary.collections[collection] = collectionRows.length;
    summary.total += collectionRows.length;
  }

  return summary;
}
