/**
 * Content validation against the site's own collection schemas — for the
 * editor's WARNINGS only.
 *
 * After a save (and when an entry is opened) the stored entry is checked
 * against its collection's Zod schema, and the editor shows what the site's
 * build would reject. The save itself always writes: an autosave of a
 * half-finished edit must reach disk.
 *
 * This is an approximation of Astro's loading and is never used to refuse
 * anything. Publishing is gated by the site's own Astro instead
 * (utils/astro-check.js), which is exact by construction.
 *
 * It validates what is STORED, read back through the content store, not the
 * JSON the editor sent: the build reads the file, and a markdown file's
 * frontmatter goes through YAML on the way (a date string comes back a Date).
 */

import { loadSchemas } from './collections.js';
import { readContent } from './content.js';

/**
 * Validation outcome for one entry.
 * @typedef {Object} EntryValidation
 * @property {'valid'|'invalid'|'unchecked'} status - 'unchecked' means no
 *   schema could be applied (unknown collection, or the schemas failed to load)
 * @property {Array<{path: string, message: string}>} issues - empty unless invalid
 * @property {string} [reason] - why an entry is 'unchecked'
 */

/**
 * Turn a Zod issue path into the form-field name the editor uses
 * (['blocks', 0, 'title'] -> 'blocks[0].title').
 * @param {Array<string|number>} issuePath
 * @returns {string}
 */
export function formatIssuePath(issuePath) {
  let formatted = '';
  for (const segment of issuePath) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
    } else {
      formatted += formatted ? `.${String(segment)}` : String(segment);
    }
  }
  return formatted;
}

/**
 * Validate entry data against an already-loaded collection schema entry.
 * @param {Object|undefined} collectionSchema - one value of loadSchemas()
 * @param {Object} data - entry data as the build would read it
 * @returns {Promise<EntryValidation>}
 */
export async function validateAgainstSchema(collectionSchema, data) {
  if (!collectionSchema) {
    return { status: 'unchecked', issues: [], reason: 'Collection is not defined in the content config' };
  }

  // A collection declared without a schema accepts anything, as in the build.
  const zodSchema = collectionSchema._zodSchema;
  if (!zodSchema) {
    return { status: 'valid', issues: [] };
  }

  const result = await zodSchema.safeParseAsync(data);
  if (result.success) {
    return { status: 'valid', issues: [] };
  }

  return {
    status: 'invalid',
    issues: result.error.issues.map((issue) => ({
      path: formatIssuePath(issue.path),
      message: issue.message,
    })),
  };
}

/**
 * Read a stored entry back and validate it. Never throws for a schema problem:
 * a failure to load the schemas comes back as 'unchecked' so a save can still
 * report success for the write itself.
 * @returns {Promise<EntryValidation>}
 */
export async function validateStoredEntry(collection, slug, locale = null) {
  let schemas;
  try {
    schemas = await loadSchemas();
  } catch (error) {
    return { status: 'unchecked', issues: [], reason: `Could not load content schemas: ${error.message}` };
  }

  const entry = await readContent(collection, slug, locale);
  return validateAgainstSchema(schemas[collection], entry.data);
}
