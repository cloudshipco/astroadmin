/**
 * AstroAdmin content-layer loader (Astro 6)
 *
 * Lets an Astro site read content straight from AstroAdmin's SQLite content
 * store at build/dev time, with no file materialisation. The site keeps
 * defining its Zod schema in src/content.config.ts; this loader ships none and
 * relies on Astro's `parseData` so the same schema validates both AstroAdmin's
 * forms (server side) and the site's read-time data.
 *
 * Usage (src/content.config.ts):
 *   import { defineCollection, z } from 'astro:content';
 *   import { astroadminLoader } from 'astroadmin/loader';
 *
 *   const pages = defineCollection({
 *     loader: astroadminLoader({ collection: 'pages' }),
 *     schema: z.object({ title: z.string() }),
 *   });
 *
 * IMPORTANT: this module imports `bun:sqlite`, so the site's dev server and
 * production build must run under Bun (e.g. `bunx --bun astro build`). If a site
 * must build under Node, swap the import for `better-sqlite3` (see the plan).
 *
 * Database path resolution (first match wins):
 *   1. explicit `{ dbPath }` option
 *   2. ASTROADMIN_DB env var (AstroAdmin exports this for co-located builds)
 *   3. `.astroadmin/content.db` relative to the Astro project root
 */

import { Database } from 'bun:sqlite';

/**
 * @param {object} options
 * @param {string} options.collection - Collection name to load from the store.
 * @param {string} [options.type='content'] - Hint for AstroAdmin's form UI
 *   ('content' shows a body editor, 'data' does not). The loader itself uses
 *   each row's stored type, so this only affects empty/new collections.
 * @param {string} [options.dbPath] - Explicit path to content.db.
 */
export function astroadminLoader({ collection, type = 'content', dbPath } = {}) {
  if (!collection) {
    throw new Error('astroadminLoader: `collection` is required');
  }

  return {
    name: 'astroadmin-loader',
    async load({ store, parseData, generateDigest, renderMarkdown, watcher, logger, config }) {
      const resolvedPath =
        dbPath ||
        process.env.ASTROADMIN_DB ||
        new URL('.astroadmin/content.db', config.root).pathname;

      async function sync() {
        let db;
        try {
          db = await openWithRetry(resolvedPath);
        } catch (error) {
          logger.warn(
            `astroadmin: cannot open content store at ${resolvedPath}: ${error.message}`
          );
          return;
        }

        try {
          const rows = db
            .query(
              `SELECT slug, locale, type, data, body, digest
                 FROM entries WHERE collection = ? ORDER BY position, slug`
            )
            .all(collection);

          store.clear();

          for (const row of rows) {
            // One Astro entry id per slug+locale so i18n variants stay distinct.
            const id = row.locale ? `${row.slug}/${row.locale}` : row.slug;
            const data = await parseData({ id, data: JSON.parse(row.data) });

            const entry = {
              id,
              data,
              digest: row.digest || generateDigest(data),
            };

            const hasBody = row.type === 'content' && row.body !== null && row.body !== undefined;
            if (hasBody) {
              entry.body = row.body;
              entry.rendered = await renderMarkdown(row.body); // enables entry.render()
            }

            store.set(entry);
          }

          logger.info(`astroadmin: loaded ${rows.length} "${collection}" entries`);
        } finally {
          db.close();
        }
      }

      await sync();

      // Dev live-reload: AstroAdmin touches .astroadmin/.touch on every write,
      // because WAL writes don't reliably fire a `change` event on the .db file.
      if (watcher) {
        const sentinel = new URL('.astroadmin/.touch', config.root).pathname;
        for (const watched of [sentinel, resolvedPath]) {
          try {
            watcher.add(watched);
          } catch {
            // Path may not exist yet; the watcher picks it up on creation.
          }
        }
        watcher.on('change', (changed) => {
          if (changed === sentinel || changed === resolvedPath) {
            sync().catch((error) =>
              logger.error(`astroadmin: reload failed: ${error.message}`)
            );
          }
        });
      }
    },
  };
}

/**
 * Open the database read-only, retrying briefly on SQLITE_BUSY (a concurrent
 * AstroAdmin write under WAL). Readers rarely block under WAL, so this is a
 * thin safety net.
 */
async function openWithRetry(path, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return new Database(path, { readonly: true });
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const isBusy =
        error?.code === 'SQLITE_BUSY' ||
        message.includes('SQLITE_BUSY') ||
        message.includes('database is locked');
      if (!isBusy) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}
