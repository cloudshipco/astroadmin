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
import { parseFrontmatter } from './content-format.js';
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
 * The values an enum or literal issue accepts (zod 4 `values`, zod 3
 * `options`), as text, or null.
 * @param {Object} issue - a zod issue
 * @returns {string[]|null}
 */
function acceptedValues(issue) {
  const values = Array.isArray(issue.values) ? issue.values : Array.isArray(issue.options) ? issue.options : null;
  if (!values || values.length === 0) return null;
  return values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value)));
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
    : result.error.issues.map((issue) => {
      const described = { path: formatIssuePath(issue.path), message: issue.message };
      const accepted = acceptedValues(issue);
      if (accepted) described.accepted = accepted;
      return described;
    });

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
    // The bundler's message names the config file by its server path.
    console.error('Could not load content schemas:', error);
    return { status: 'unchecked', issues: [], reason: 'The content schemas could not be loaded, so this entry was not checked; see the server log.' };
  }

  const entry = await readContent(collection, slug, locale);
  return validateAgainstSchema(schemas[collection], entry.data);
}

/**
 * Every image() field in stored data, with its value.
 * @returns {Array<{path: Array<string|number>, value: *}>}
 */
function findImageFields(node, value, issuePath, found) {
  const schema = nonNullMember(node);
  if (!schema || value === null || value === undefined) return found;
  if (schema[IMAGE_MARKER] === true) {
    found.push({ path: issuePath, value });
    return found;
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((item, index) => findImageFields(itemSchemaFor(schema.items, item), item, [...issuePath, index], found));
    return found;
  }
  if (typeof value === 'object' && schema.properties) {
    for (const [key, propertyNode] of Object.entries(schema.properties)) {
      findImageFields(propertyNode, value[key], [...issuePath, key], found);
    }
  }
  return found;
}

/**
 * Validate an entry from its file's text as committed. The publish check's
 * refusal reads the text at the checked commit, not from the live tree, which
 * an autosave may have changed since. Every message is ours or the site's
 * schema's: nothing from a build's output.
 *
 * @param {Object} options
 * @param {Object} options.schemas - loadSchemas() result
 * @param {string} options.collection
 * @param {string} options.file - the file's path, for its extension
 * @param {string} options.text - the file's committed text
 * @param {string|null} [options.itemId] - a file() collection's entry id
 * @param {string[]} [options.missingImages] - image paths the build could not find
 * @returns {Promise<EntryValidation>}
 */
export async function validateCommittedText({ schemas, collection, file, text, itemId = null, missingImages = [] }) {
  let data;
  let body = null;
  if (/\.json$/i.test(file)) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      const position = /line (\d+) column (\d+)/.exec(error.message);
      return {
        status: 'invalid',
        issues: [{ path: '', message: position ? `This entry's JSON is not valid (line ${position[1]}, column ${position[2]}).` : "This entry's JSON is not valid." }],
      };
    }
    if (itemId !== null) {
      const items = Array.isArray(data)
        ? data
        : (data && typeof data === 'object' ? Object.entries(data).map(([id, item]) => ({ id, ...item })) : []);
      data = items.find((item) => item?.id === itemId || item?.slug === itemId);
      if (!data) return { status: 'unchecked', issues: [], reason: 'The entry was not found in its file.' };
    }
  } else {
    try {
      const parsed = parseFrontmatter(text);
      data = parsed.data;
      body = parsed.content;
    } catch (error) {
      // js-yaml counts lines within the frontmatter, which starts on line 2.
      const line = Number.isInteger(error?.mark?.line) ? error.mark.line + 2 : null;
      return {
        status: 'invalid',
        issues: [{ path: '', message: line ? `The frontmatter is not valid YAML (near line ${line} of the file).` : 'The frontmatter is not valid YAML.' }],
      };
    }
  }

  const validation = await validateAgainstSchema(schemas[collection], data);
  const issues = [...validation.issues];
  if (missingImages.length > 0 && schemas[collection]?.schema) {
    for (const field of findImageFields(schemas[collection].schema, data, [], [])) {
      if (missingImages.includes(field.value)) {
        issues.push({ path: formatIssuePath(field.path), message: `The image file ${field.value} was not found.` });
      }
    }
  }
  for (const image of missingImages) {
    if (typeof body === 'string' && body.includes(image) && !issues.some((issue) => issue.message.includes(image))) {
      issues.push({ path: 'body', message: `The body uses the image file ${image}, which was not found.` });
    }
  }
  if (validation.status === 'unchecked' && issues.length === 0) return validation;
  return issues.length === 0 ? { status: 'valid', issues: [] } : { status: 'invalid', issues };
}
