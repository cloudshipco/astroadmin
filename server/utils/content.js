/**
 * Content utility (public storage surface)
 *
 * Thin re-export of the active content store's full interface so every
 * consumer (`server/api/content.js`, `server/utils/collections.js`, tests)
 * imports from one place. The store (file-based by default, SQLite when
 * `config.content.store = 'db'`) is selected in content-store.js.
 */

export {
  readContent,
  writeContent,
  deleteContent,
  contentExists,
  getAvailableLocales,
  listSlugs,
  distinctCollections,
  getCollectionType,
} from './content-store.js';
