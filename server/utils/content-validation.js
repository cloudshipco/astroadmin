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
import { IMAGE_MARKER } from './schema-parser.js';

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
 * The one member of a nullable union (`{anyOf: [X, {type: 'null'}]}`), or the
 * node itself.
 * @param {Object} node - a JSON Schema node
 * @returns {Object}
 */
function nonNullMember(node) {
  const union = node?.anyOf || node?.oneOf;
  if (!Array.isArray(union)) return node;
  const nonNull = union.filter((member) => member?.type !== 'null');
  return nonNull.length === 1 ? nonNull[0] : node;
}

/**
 * The schema of one item of an array, resolving a block union by the item's
 * `type` discriminator (a block array's items are `oneOf` the block schemas).
 */
function itemSchemaFor(itemsNode, item) {
  const union = itemsNode?.anyOf || itemsNode?.oneOf;
  if (!Array.isArray(union)) return itemsNode;
  if (item && typeof item === 'object' && typeof item.type === 'string') {
    const match = union.find((option) => option?.properties?.type?.const === item.type);
    if (match) return match;
  }
  return nonNullMember(itemsNode);
}

/**
 * Find REQUIRED image() fields whose stored value is the empty string.
 *
 * The bundled schema stands image() in as `z.string()`, so '' passes it, while
 * the site's own build refuses an empty image path. An empty OPTIONAL image is
 * not reported: the editor drops empty optionals before saving.
 *
 * @param {Object} node - JSON Schema for `value`
 * @param {*} value - the stored data at this level
 * @param {Array<string|number>} issuePath - path of `value`
 * @param {Array<{path: Array<string|number>, message: string}>} found - collects issues
 */
function findEmptyRequiredImages(node, value, issuePath, found) {
  const schema = nonNullMember(node);
  if (!schema || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    if (!schema.items) return;
    value.forEach((item, index) => {
      findEmptyRequiredImages(itemSchemaFor(schema.items, item), item, [...issuePath, index], found);
    });
    return;
  }

  if (typeof value !== 'object' || !schema.properties) return;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [key, propertyNode] of Object.entries(schema.properties)) {
    const property = nonNullMember(propertyNode);
    const fieldValue = value[key];
    if (property?.[IMAGE_MARKER] === true) {
      if (required.has(key) && fieldValue === '') {
        found.push({ path: [...issuePath, key], message: 'An image is required' });
      }
      continue;
    }
    findEmptyRequiredImages(property, fieldValue, [...issuePath, key], found);
  }
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
  const issues = result.success
    ? []
    : result.error.issues.map((issue) => ({
      path: formatIssuePath(issue.path),
      message: issue.message,
    }));

  const emptyImages = [];
  findEmptyRequiredImages(collectionSchema.schema, data, [], emptyImages);
  for (const emptyImage of emptyImages) {
    const issuePath = formatIssuePath(emptyImage.path);
    if (!issues.some((issue) => issue.path === issuePath)) {
      issues.push({ path: issuePath, message: emptyImage.message });
    }
  }

  return issues.length === 0 ? { status: 'valid', issues: [] } : { status: 'invalid', issues };
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
