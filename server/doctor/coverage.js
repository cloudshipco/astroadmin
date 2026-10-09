/**
 * Click-to-edit coverage: how much of each entry's text can be reached by
 * clicking it in the preview. Pure functions over entries and page scans, so
 * they can be tested without a site or a build.
 *
 * A data-aa-field value is an editor control's form name: `title`, `hero.title`,
 * `blocks[2].heading`, or an array such as `blocks[3].items` (whose items are
 * edited through the array control). `body` is a Markdown entry's body.
 *
 * An annotation means a field of the entry its page is for, unless it or an
 * ancestor carries data-aa-entry="<collection>/<slug>": then it is a field of
 * that entry (a card listing another collection's entry).
 */

import { isImageField } from '../../ui/form-generator.js';
import { comparableText, comparableWords } from './html-scan.js';

// How much of a value's start is looked for in the page (in comparable
// characters): enough to be specific, short enough to survive a template
// that truncates or splits a long value.
const RENDERED_SNIPPET_LENGTH = 40;
// A snippet shorter than this ("About") would be found inside other words of
// any page, so it must match as whole words instead.
const WHOLE_WORD_BELOW = 16;

/**
 * An entry, located on the page it renders to.
 * @typedef {Object} DoctorEntry
 * @property {string} collection
 * @property {string} slug
 * @property {string|null} pagePath - e.g. '/about'; null when the entry has no
 *   page of its own (it can still appear as a card on other pages)
 * @property {Object} data
 * @property {string|null} [body] - Markdown body, if any
 * @property {Object|null} [schema] - the collection's JSON Schema
 * @property {string[]} [blockArrays] - top-level keys holding a block list
 */

// Values that are links, paths or fragments, never visible text.
const LINK_LIKE_VALUE = /^(\/|#|\.{1,2}\/|https?:\/\/|mailto:|tel:)/i;
// Names of string fields that are identifiers or attributes rather than text a
// visitor reads: exactly one of these words, or a camelCase name ending in one.
const NON_TEXT_WORDS = ['id', 'ids', 'slug', 'url', 'href', 'link', 'src', 'path', 'alt', 'email', 'tel', 'phone'];
const NON_TEXT_EXACT = new Set(NON_TEXT_WORDS);
const NON_TEXT_SUFFIX = new RegExp(`[a-z0-9](${NON_TEXT_WORDS.map((word) => word[0].toUpperCase() + word.slice(1)).join('|')})$`);
// Page metadata, rendered into <head> where nothing can be clicked.
const METADATA_NAME = /^(meta|seo|og)([A-Z_]|$)/;
const NON_TEXT_FORMATS = new Set(['date', 'date-time', 'time', 'uri', 'url', 'email']);

/**
 * The JSON Schema option that describes `value`: for a union, the object
 * option whose literal (const) properties all match, else the first option of
 * the value's type.
 */
function resolveSchema(schemaNode, value) {
  if (!schemaNode || typeof schemaNode !== 'object') return null;
  const options = schemaNode.anyOf || schemaNode.oneOf;
  if (!Array.isArray(options)) return schemaNode;
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (isObject) {
    const matching = options.find((option) => option?.properties && Object.entries(option.properties)
      .every(([key, property]) => property?.const === undefined || property.const === value[key]));
    if (matching) return resolveSchema(matching, value);
  }
  const valueType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const sameType = options.find((option) => option?.type === valueType
    || (valueType === 'number' && option?.type === 'integer'));
  return resolveSchema(sameType || options.find((option) => option?.type !== 'null') || null, value);
}

/**
 * Is this string field text a visitor reads (and so worth annotating)?
 * @param {string} key - the field's own name (for an array of strings, the array's)
 * @param {Object|null} schemaNode
 * @param {string} value
 */
export function isTextField(key, schemaNode, value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (schemaNode && (schemaNode.enum || schemaNode.const !== undefined)) return false;
  if (schemaNode && NON_TEXT_FORMATS.has(schemaNode.format)) return false;
  if (NON_TEXT_EXACT.has(key.toLowerCase()) || NON_TEXT_SUFFIX.test(key) || METADATA_NAME.test(key)) return false;
  if (isImageField(key, schemaNode || {})) return false;
  if (LINK_LIKE_VALUE.test(value.trim())) return false;
  return true;
}

/**
 * Walk an entry's data with its schema.
 * @returns {{textFields: string[], values: Map<string, string>, dataPaths: Set<string>}}
 *   dataPaths: every control path, from the data and from the schema (a field
 *   the entry leaves empty still has a control the editor can focus)
 */
export function describeEntryFields(entry) {
  const textFields = [];
  const values = new Map();
  const dataPaths = new Set();

  const walk = (value, schemaNode, fieldPath, key) => {
    const resolved = resolveSchema(schemaNode, value);
    if (fieldPath) dataPaths.add(fieldPath);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, resolved?.items || null, `${fieldPath}[${index}]`, key));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const declaredKey of Object.keys(resolved?.properties || {})) {
        if (resolved.properties[declaredKey]?.const === undefined) dataPaths.add(fieldPath ? `${fieldPath}.${declaredKey}` : declaredKey);
      }
      for (const [childKey, childValue] of Object.entries(value)) {
        const childSchema = resolved?.properties?.[childKey] || null;
        // A literal (a block's discriminator, a fixed id) is not editable text.
        if (childSchema?.const !== undefined) continue;
        walk(childValue, childSchema, fieldPath ? `${fieldPath}.${childKey}` : childKey, childKey);
      }
      return;
    }
    if (isTextField(key, resolved, value)) {
      textFields.push(fieldPath);
      values.set(fieldPath, value);
    }
  };

  walk(entry.data || {}, entry.schema || null, '', '');
  if (typeof entry.body === 'string') {
    dataPaths.add('body');
    if (entry.body.trim() !== '') {
      textFields.push('body');
      values.set('body', entry.body);
    }
  }
  return { textFields, values, dataPaths };
}

/**
 * Is a field's value visible on the page outside a link? Compares the start of
 * its first paragraph, with Markdown link and emphasis syntax removed. A value
 * found only inside a link (a button label), in <head> (a page title, meta
 * description) or nowhere (a date rendered in another format) cannot be
 * annotated usefully, so it is not counted against coverage.
 * @param {string} value
 * @param {import('./html-scan.js').PageScan} page
 */
export function isRenderedAsText(value, page) {
  const firstParagraph = value.trim().split(/\n\s*\n/)[0]
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '');
  const snippet = comparableText(firstParagraph).slice(0, RENDERED_SNIPPET_LENGTH);
  if (snippet === '') return false;
  if (snippet.length >= WHOLE_WORD_BELOW) {
    if ((page.clickableText || '').includes(snippet)) return true;
    // Prose that contains a link spans both; text wholly inside a link does not count.
    return (page.bodyText || '').includes(snippet) && !(page.linkText || '').includes(snippet);
  }
  return (page.clickableWords || '').includes(` ${comparableWords(firstParagraph)} `);
}

/**
 * The paths a field path is reached through: itself, then each ancestor. A
 * block list (`blocks`) and a whole block (`blocks[2]`) are not controls, so a
 * click on an element annotated with one does not focus anything.
 */
function reachingPaths(fieldPath, blockArrays) {
  const paths = [fieldPath];
  let current = fieldPath;
  for (;;) {
    const parent = current.replace(/(\.[^.[\]]+|\[\d+\])$/, '');
    if (parent === current || parent === '') break;
    current = parent;
    paths.push(current);
  }
  return paths.filter((candidate) => !blockArrays.some((key) => candidate === key || new RegExp(`^${escapeRegExp(key)}\\[\\d+\\]$`).test(candidate)));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The data-aa-entry value that names an entry. */
export function entryRef(entry) {
  return `${entry.collection}/${entry.slug}`;
}

/**
 * Where an entry can be clicked: its own page, where unqualified annotations
 * (and ones qualified with its own reference) are its fields, and every other
 * page holding annotations qualified with its reference. An annotation on or
 * inside a link is left out: a click never reaches it.
 * @returns {Array<{pagePath: string, page: import('./html-scan.js').PageScan, names: Set<string>}>}
 */
function placesShowing(entry, pages) {
  const ref = entryRef(entry);
  const places = [];
  const ownPage = entry.pagePath ? pages.get(entry.pagePath) : undefined;
  if (ownPage) {
    const names = ownPage.fields.filter((field) => !field.link && (field.entry === null || field.entry === undefined || field.entry === ref));
    places.push({ pagePath: entry.pagePath, page: ownPage, names: new Set(names.map((field) => field.name)) });
  }
  for (const [pagePath, page] of pages) {
    if (pagePath === entry.pagePath) continue;
    const qualified = page.fields.filter((field) => !field.link && field.entry === ref);
    if (qualified.length > 0) places.push({ pagePath, page, names: new Set(qualified.map((field) => field.name)) });
  }
  return places;
}

/**
 * Per-entry coverage: of the text fields that render as clickable text where
 * the entry is shown (or are annotated anyway), the share whose control (or the
 * array control holding them) is named by an annotation there. An entry is
 * shown on its own page, and as a card wherever data-aa-entry names it; a field
 * reached in any of those places counts as covered.
 * @param {DoctorEntry[]} entries
 * @param {Map<string, import('./html-scan.js').PageScan>} pages
 */
export function computeFieldCoverage(entries, pages) {
  const report = { totalFields: 0, coveredFields: 0, notRendered: 0, entries: [], unchecked: [] };
  for (const entry of entries) {
    const places = placesShowing(entry, pages);
    if (places.length === 0) {
      // An entry with no page of its own and no card is not on any page we
      // can check; one whose page was not built is reported.
      if (entry.pagePath) report.unchecked.push({ collection: entry.collection, slug: entry.slug, pagePath: entry.pagePath });
      continue;
    }
    const { textFields, values } = describeEntryFields(entry);
    const blockArrays = entry.blockArrays || [];
    const isCovered = (fieldPath) => reachingPaths(fieldPath, blockArrays)
      .some((candidate) => places.some((place) => place.names.has(candidate)));
    const isRendered = (fieldPath) => places.some((place) => isRenderedAsText(values.get(fieldPath), place.page));
    const counted = textFields.filter((fieldPath) => isCovered(fieldPath) || isRendered(fieldPath));
    const missing = counted.filter((fieldPath) => !isCovered(fieldPath));
    const covered = counted.length - missing.length;
    report.totalFields += counted.length;
    report.coveredFields += covered;
    report.notRendered += textFields.length - counted.length;
    report.entries.push({
      collection: entry.collection,
      slug: entry.slug,
      pagePath: places[0].pagePath,
      pagePaths: places.map((place) => place.pagePath),
      fields: counted.length,
      covered,
      missing,
      notRendered: textFields.filter((fieldPath) => !counted.includes(fieldPath)),
    });
  }
  report.byCollection = summariseByCollection(report.entries);
  return report;
}

/**
 * Coverage per collection, in first-seen order. A collection's entries share a
 * template, so this is the unit a site owner fixes: one template annotated
 * well can sit beside another never annotated at all.
 */
function summariseByCollection(entryReports) {
  const byName = new Map();
  for (const entry of entryReports) {
    if (!byName.has(entry.collection)) byName.set(entry.collection, { collection: entry.collection, entries: 0, fields: 0, covered: 0 });
    const summary = byName.get(entry.collection);
    summary.entries += 1;
    summary.fields += entry.fields;
    summary.covered += entry.covered;
  }
  return [...byName.values()].filter((summary) => summary.fields > 0);
}

/**
 * data-aa-field values that name nothing. An unqualified one must name a field
 * of an entry whose page it is on; one qualified by data-aa-entry must name a
 * field of that entry. A click on one does nothing, which is the failure this
 * exists to catch (a typo, or `heading` where the control is
 * `blocks[2].heading`). Qualified names of an entry that does not exist are
 * left to findUnknownEntryRefs.
 * @param {DoctorEntry[]} entries
 * @param {Map<string, import('./html-scan.js').PageScan>} pages
 * @returns {Array<{pagePath: string, name: string, entry?: string}>}
 */
export function findUnknownFieldNames(entries, pages) {
  const validByPage = new Map();
  const validByRef = new Map();
  for (const entry of entries) {
    const { dataPaths } = describeEntryFields(entry);
    validByRef.set(entryRef(entry), dataPaths);
    if (!entry.pagePath) continue;
    if (!validByPage.has(entry.pagePath)) validByPage.set(entry.pagePath, new Set());
    for (const dataPath of dataPaths) validByPage.get(entry.pagePath).add(dataPath);
  }
  const unknown = [];
  for (const [pagePath, page] of pages) {
    const validHere = validByPage.get(pagePath);
    const seen = new Set();
    for (const field of page.fields) {
      const qualified = field.entry !== null && field.entry !== undefined;
      let valid;
      if (qualified) valid = validByRef.get(field.entry);
      else valid = validHere;
      // A page no entry owns, or a reference to a missing entry: nothing to check against.
      if (!valid || valid.has(field.name)) continue;
      const key = qualified ? `${field.entry}\u0000${field.name}` : field.name;
      if (seen.has(key)) continue;
      seen.add(key);
      unknown.push(qualified ? { pagePath, name: field.name, entry: field.entry } : { pagePath, name: field.name });
    }
  }
  return unknown;
}

/**
 * data-aa-entry values naming no existing entry (or not of the form
 * `<collection>/<slug>`). A click on a card carrying one does nothing.
 * @param {DoctorEntry[]} entries
 * @param {Map<string, import('./html-scan.js').PageScan>} pages
 * @returns {Array<{pagePath: string, entry: string}>}
 */
export function findUnknownEntryRefs(entries, pages) {
  const known = new Set(entries.map(entryRef));
  const unknown = [];
  for (const [pagePath, page] of pages) {
    for (const ref of page.entryRefs || []) {
      if (!known.has(ref)) unknown.push({ pagePath, entry: ref });
    }
  }
  return unknown;
}

/**
 * Blocks with no data-block-index on their page. Without it the integration
 * guesses block roots by counting top-level <section> elements, which
 * misaligns as soon as one block renders something else.
 * @param {DoctorEntry[]} entries
 * @param {Map<string, import('./html-scan.js').PageScan>} pages
 */
export function findUnindexedBlocks(entries, pages) {
  const report = { totalBlocks: 0, indexedBlocks: 0, pages: [] };
  for (const entry of entries) {
    const page = pages.get(entry.pagePath);
    if (!page) continue;
    const present = new Set(page.blockIndexes);
    for (const key of entry.blockArrays || []) {
      const blocks = entry.data?.[key];
      if (!Array.isArray(blocks) || blocks.length === 0) continue;
      const missing = blocks.map((block, index) => index).filter((index) => !present.has(index));
      report.totalBlocks += blocks.length;
      report.indexedBlocks += blocks.length - missing.length;
      if (missing.length > 0) {
        report.pages.push({ collection: entry.collection, slug: entry.slug, pagePath: entry.pagePath, field: key, blocks: blocks.length, missing });
      }
    }
  }
  return report;
}

/**
 * Annotations that can never fire: on a link that navigates, or inside one.
 * The integration lets a click inside a link navigate and focuses nothing, so
 * an annotated ANCESTOR of a link is fine (a click beside the link still
 * reaches it), but these are dead.
 * @param {Map<string, import('./html-scan.js').PageScan>} pages
 */
export function findAnnotatedLinks(pages) {
  const found = [];
  for (const [pagePath, page] of pages) {
    for (const field of page.fields) {
      if (field.link === 'is') found.push({ pagePath, name: field.name, problem: 'is a link' });
      else if (field.link === 'inside') found.push({ pagePath, name: field.name, problem: 'is inside a link' });
    }
  }
  return found;
}
