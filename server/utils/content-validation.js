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
 * One accepted value as text. Never throws: a bigint (which JSON.stringify
 * refuses), a symbol or a cyclic object still reads as something.
 * @param {*} value
 * @returns {string}
 */
export function formatAcceptedValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (value === undefined || typeof value === 'symbol' || typeof value === 'function') return String(value);
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '(a value that cannot be shown)';
    }
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
  return values.map(formatAcceptedValue);
}

/**
 * A zod issue as the editor sees it. Formatting never aborts validation: an
 * issue whose accepted values cannot be read is reported without them.
 */
function describeIssue(issue) {
  const described = { path: formatIssuePath(issue.path || []), message: String(issue.message) };
  try {
    const accepted = acceptedValues(issue);
    if (accepted) described.accepted = accepted;
  } catch (error) {
    console.error('Could not format the accepted values of a schema issue:', error);
  }
  return described;
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
    : result.error.issues.map(describeIssue);

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

// Bounds on a save's candidate list: it is the client's, so it is untrusted.
const MAX_BLANK_CANDIDATES = 1000;
const MAX_BLANK_PATH_LENGTH = 1000;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * A form path (`blocks[1].meta.note`) as issue-path segments
 * (['blocks', 1, 'meta', 'note']), or null if it is not one.
 * @param {*} candidate
 * @returns {Array<string|number>|null}
 */
function parseFieldPath(candidate) {
  if (typeof candidate !== 'string' || candidate === '' || candidate.length > MAX_BLANK_PATH_LENGTH) return null;
  const segments = [];
  const pattern = /([^.[\]]+)|\[(\d+)\]|\./y;
  let expectName = true;
  while (pattern.lastIndex < candidate.length) {
    const match = pattern.exec(candidate);
    if (!match) return null;
    if (match[1] !== undefined) {
      if (!expectName || FORBIDDEN_SEGMENTS.has(match[1])) return null;
      segments.push(match[1]);
      expectName = false;
    } else if (match[2] !== undefined) {
      if (expectName) return null;
      segments.push(Number(match[2]));
    } else {
      if (expectName) return null;
      expectName = true;
    }
  }
  return expectName ? null : segments;
}

/**
 * The object holding the value at `segments`, if that value is an own "" of
 * a plain object inside `data`; else null.
 */
function blankParent(data, segments) {
  let node = data;
  for (const segment of segments.slice(0, -1)) {
    if (typeof segment === 'number') {
      if (!Array.isArray(node) || !Number.isSafeInteger(segment) || segment >= node.length) return null;
      node = node[segment];
    } else {
      if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, segment)) return null;
      node = node[segment];
    }
  }
  const last = segments[segments.length - 1];
  if (typeof last !== 'string' || !node || typeof node !== 'object' || Array.isArray(node)) return null;
  return Object.hasOwn(node, last) && node[last] === '' ? node : null;
}

/** A copy of `data` with the "" at each of these paths removed. */
function withoutBlanks(data, removals) {
  const copy = structuredClone(data);
  for (const segments of removals) {
    const parent = blankParent(copy, segments);
    if (parent) delete parent[segments[segments.length - 1]];
  }
  return copy;
}

/** The formatted paths of every issue the site's zod finds in `data`. */
async function issuePathsOf(zodSchema, data) {
  const result = await zodSchema.safeParseAsync(data);
  return new Set(result.success ? [] : result.error.issues.map((issue) => formatIssuePath(issue.path || [])));
}

/**
 * Remove the "" values the editor's form kept inside blocks at optional keys
 * (#70) where the site's REAL zod refuses them, and only there.
 *
 * The form keeps every "" inside a block, because the JSON Schema it is drawn
 * from cannot say which "" the site's zod accepts (z.coerce, .catch(),
 * z.preprocess and zod 4's .base64() serialise as stricter than they are).
 * It names them in the save (`blankOptionals`); this runs the collection's
 * zod on the entry and drops a candidate only when (1) an issue sits at
 * EXACTLY its path (a refinement at a parent path never drops anything), or
 * it is an image() field, whose bundled stand-in accepts "" though the build
 * refuses it, and (2) with it removed, no issue sits at that path (absent is
 * accepted: never a required key). Every other value stays as sent.
 *
 * The list is the client's and untrusted: a path that is not a form path,
 * names a prototype key, leaves the entry, or does not hold "" in a plain
 * object is ignored. Nothing but a "" is ever removed.
 *
 * @param {Object|undefined} collectionSchema - one value of loadSchemas()
 * @param {*} data - the entry data as the save sent it
 * @param {*} candidates - the save's `blankOptionals`
 * @returns {Promise<*>} `data` itself when nothing is removed, else a copy
 */
export async function dropRefusedBlanks(collectionSchema, data, candidates) {
  const zodSchema = collectionSchema?._zodSchema;
  if (!zodSchema || !Array.isArray(candidates) || candidates.length === 0) return data;
  if (!data || typeof data !== 'object') return data;

  const byPath = new Map();
  for (const candidate of candidates.slice(0, MAX_BLANK_CANDIDATES)) {
    const segments = parseFieldPath(candidate);
    if (!segments || !blankParent(data, segments)) continue;
    byPath.set(formatIssuePath(segments), segments);
  }
  if (byPath.size === 0) return data;

  const refusedPaths = await issuePathsOf(zodSchema, data);
  for (const image of findImageFields(collectionSchema.schema, data)) {
    if (image.value === '') refusedPaths.add(formatIssuePath(image.path));
  }
  const refused = [...byPath].filter(([formatted]) => refusedPaths.has(formatted));
  if (refused.length === 0) return data;

  const stillRefused = await issuePathsOf(zodSchema, withoutBlanks(data, refused.map(([, segments]) => segments)));
  const removals = refused.filter(([formatted]) => !stillRefused.has(formatted)).map(([, segments]) => segments);
  return removals.length === 0 ? data : withoutBlanks(data, removals);
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
 * @param {Object} node - JSON Schema for `value`
 * @param {*} value
 * @returns {Array<{path: Array<string|number>, value: *}>}
 */
export function findImageFields(node, value, issuePath = [], found = []) {
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
 * A file() collection's items as Astro's file loader reads them: an array's
 * items by `(id ?? slug)` as a string (an item without one is skipped), an
 * object's by key (except a string `$schema`), each with its data as written.
 * @param {*} parsed - the file's parsed content
 * @returns {Array<{id: string, data: *}>}
 */
export function fileLoaderItems(parsed) {
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => ({ id: (item?.id ?? item?.slug)?.toString(), data: item }))
      .filter((item) => typeof item.id === 'string' && item.id !== '');
  }
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed)
      .filter(([id, item]) => !(id === '$schema' && typeof item === 'string'))
      .map(([id, data]) => ({ id, data }));
  }
  return [];
}

/**
 * A committed file's text as its data (and a markdown body), or the problem
 * with reading it, in our words.
 * @param {string} file - the file's path, for its extension
 * @param {string} text
 * @returns {{data: *, body: string|null} | {issue: {path: string, message: string}}}
 */
export function parseCommittedText(file, text) {
  if (/\.json$/i.test(file)) {
    try {
      return { data: JSON.parse(text), body: null };
    } catch (error) {
      const position = /line (\d+) column (\d+)/.exec(error.message);
      return { issue: { path: '', message: position ? `This entry's JSON is not valid (line ${position[1]}, column ${position[2]}).` : "This entry's JSON is not valid." } };
    }
  }
  try {
    const parsed = parseFrontmatter(text);
    return { data: parsed.data, body: parsed.content };
  } catch (error) {
    // js-yaml counts from 0 within the text gray-matter hands it, which
    // starts with the newline after the opening `---`: its line 0 is the
    // file's line 1 (the fence), so the file's line is mark.line + 1.
    const line = Number.isInteger(error?.mark?.line) ? error.mark.line + 1 : null;
    return { issue: { path: '', message: line ? `The frontmatter is not valid YAML (near line ${line} of the file).` : 'The frontmatter is not valid YAML.' } };
  }
}

/**
 * Validate an entry from its file's text as committed. The publish check's
 * refusal reads the text at the checked commit, not from the live tree, which
 * an autosave may have changed since. Every message is ours or the site's
 * schema's: nothing from a build's output.
 *
 * @param {Object} options
 * @param {Object|null} options.schemas - the collection schemas AT THE CHECKED
 *   COMMIT, or null when they could not be loaded: then nothing is checked
 *   against a schema (the live one could give wrong advice), and only what is
 *   known without one is reported
 * @param {string} options.collection
 * @param {string} options.file - the file's path, for its extension
 * @param {string} options.text - the file's committed text
 * @param {string|null} [options.itemId] - a file() collection's entry id
 * @param {Array<{path: string, message: string}>} [options.extraIssues] -
 *   issues found elsewhere and already confirmed (a missing image file)
 * @returns {Promise<EntryValidation>}
 */
export async function validateCommittedText({ schemas, collection, file, text, itemId = null, extraIssues = [] }) {
  const parsed = parseCommittedText(file, text);
  if (parsed.issue) return { status: 'invalid', issues: [parsed.issue, ...extraIssues] };
  let data = parsed.data;
  if (itemId !== null) {
    data = fileLoaderItems(data).find((item) => item.id === itemId)?.data;
    if (data === undefined) return { status: 'unchecked', issues: [], reason: 'The entry was not found in its file.' };
  }

  const validation = schemas
    ? await validateAgainstSchema(schemas[collection], data)
    : { status: 'unchecked', issues: [], reason: 'The schemas at the checked commit could not be loaded.' };
  const issues = [...validation.issues];
  for (const extra of extraIssues) {
    if (!issues.some((issue) => issue.path === extra.path && issue.message === extra.message)) issues.push(extra);
  }
  if (validation.status === 'unchecked' && issues.length === 0) return validation;
  return issues.length === 0 ? { status: 'valid', issues: [] } : { status: 'invalid', issues };
}
