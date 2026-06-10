/**
 * Database → files exporter (the inverse of import-files.js)
 *
 * One-time migration off the SQLite content store back to on-disk files, so a
 * site can move from the DB content-layer loader to Astro's native glob()/file()
 * loaders (Option B). Reads every row from the content store and writes it
 * through the file store, preserving frontmatter/body, data JSON, locales, and
 * file()-collection array order.
 *
 * Run via `astroadmin export` BEFORE switching the site's content.config.ts from
 * astroadminLoader to glob()/file(): while the config still declares the db
 * loader, db collections have no glob base, so they export to the conventional
 * `src/content/<collection>` — exactly where the new glob() loader will read.
 *
 * Bridges stores directly: reads db.js, writes content-files.js (not the
 * dispatcher), so it works regardless of the active content.store setting.
 */

import fs from 'fs/promises';
import path from 'path';
import { loadSchemas } from './collections.js';
import { listAllEntries } from './db.js';
import { writeContent } from './content-files.js';
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

    if (isFileCollection) {
      // file() loader: rebuild the single JSON array, ordered by position.
      const ordered = [...collectionRows].sort(
        (a, b) => (a.position ?? 0) - (b.position ?? 0)
      );
      const array = ordered.map((row) => JSON.parse(row.data));
      const target = resolveProjectPath(schema.loaderFilePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(array, null, 2)}\n`, 'utf-8');
      summary.files += 1;
    } else {
      // glob (or db) loader: one file per entry, honouring loaderBase if set.
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
