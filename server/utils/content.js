/**
 * Content utility (public CRUD surface)
 *
 * Thin re-export of the active content store's CRUD functions so existing
 * importers (`server/api/content.js`, `server/utils/collections.js`) keep
 * working unchanged. The store (file-based by default, SQLite when
 * `config.content.store = 'db'`) is selected in content-store.js.
 */

export {
  readContent,
  writeContent,
  deleteContent,
  contentExists,
  getAvailableLocales,
} from './content-store.js';
