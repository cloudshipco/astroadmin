/**
 * Click-to-edit coverage: how much of each entry's text can be reached by
 * clicking it in the preview. Pure functions over entries and page scans, so
 * they can be tested without a site or a build.
 *
 * A data-aa-field value is an editor control's form name: `title`, `hero.title`,
 * `blocks[2].heading`, or an array such as `blocks[3].items` (whose items are
 * edited through the array control). `body` is a Markdown entry's body.
 *
 * Which names are controls is not re-derived here: the editor's own renderer
 * (ui/form-generator.js generateForm) renders the entry, and its `name`
 * attributes are the controls, exactly the ones a click can focus. So a nested
 * object (`hero`) is not a control but `hero.title` is; a list of strings has
 * one control per item (`credentials[2]`); a list of objects with one property
 * has one per item field (`points[0].text`); a list of objects with two or more
 * properties has ONE control (`blocks[1].items`); an image has its own control.
 *
 * An annotation means a field of the entry its page is for. Annotations inside
 * a card for another entry (an element marked as one, which this version does
 * not support; see findEntryCards) are left out of coverage and names.
 */

import { generateForm, isImageField } from '../../ui/form-generator.js';
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
 * @property {string} pagePath - e.g. '/about'
 * @property {Object} data
 * @property {string|null} [body] - Markdown body, if any
 * @property {Object|null} [schema] - the collection's JSON Schema, with
 *   `blockTypes` on each block list as the editor's form receives it (see
 *   server/utils/block-types.js)
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
function isTextField(key, schemaNode, value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (schemaNode && (schemaNode.enum || schemaNode.const !== undefined)) return false;
  if (schemaNode && NON_TEXT_FORMATS.has(schemaNode.format)) return false;
  if (NON_TEXT_EXACT.has(key.toLowerCase()) || NON_TEXT_SUFFIX.test(key) || METADATA_NAME.test(key)) return false;
  if (isImageField(key, schemaNode || {})) return false;
  if (LINK_LIKE_VALUE.test(value.trim())) return false;
  return true;
}

/**
 * The names of the entry's editor controls: the `name` attributes the editor's
 * form renders for it (plus `body`, the Markdown editor, which the dashboard
 * adds beside the form for an entry with a body and no blocks). Fixed values
 * (a block's `type`, a z.literal) and schema-hidden fields are hidden inputs
 * with nothing to show, so they are left out.
 * @param {DoctorEntry} entry
 * @param {Set<string>} inertPaths - paths of fixed and hidden values
 * @returns {Set<string>|null} null when the entry has no object schema to render
 */
function editorControls(entry, inertPaths) {
  const schema = entry.schema;
  if (!schema || schema.type !== 'object') return null;
  const html = generateForm(schema, entry.data || {});
  const controls = new Set();
  for (const match of html.matchAll(/\sname="([^"]*)"/g)) {
    if (!inertPaths.has(match[1])) controls.add(match[1]);
  }
  if (typeof entry.body === 'string' && !schema.properties?.blocks) controls.add('body');
  return controls;
}

/**
 * Walk an entry's data with its schema.
 * @returns {{textFields: string[], values: Map<string, string>, controls: Set<string>}}
 *   controls: every editor control name (see editorControls). An entry with no
 *   schema falls back to the paths in its data.
 */
export function describeEntryFields(entry) {
  const textFields = [];
  const values = new Map();
  const dataPaths = new Set();
  const inertPaths = new Set();

  const walk = (value, schemaNode, fieldPath, key) => {
    const resolved = resolveSchema(schemaNode, value);
    if (fieldPath) dataPaths.add(fieldPath);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, resolved?.items || null, `${fieldPath}[${index}]`, key));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [declaredKey, declared] of Object.entries(resolved?.properties || {})) {
        if (declared?.const !== undefined || declared?.hidden) inertPaths.add(fieldPath ? `${fieldPath}.${declaredKey}` : declaredKey);
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
  const controls = editorControls(entry, inertPaths) || dataPaths;
  return { textFields, values, controls };
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
 * The control a field is edited through: the field's own control, else the
 * nearest enclosing one (`blocks[2].items[0].title` is edited through
 * `blocks[2].items`). Null when no control holds it (a gallery's items, which
 * are edited in a modal opened from a group with no name).
 * @param {string} fieldPath
 * @param {Set<string>} controls
 */
function owningControl(fieldPath, controls) {
  let current = fieldPath;
  for (;;) {
    if (controls.has(current)) return current;
    const parent = current.replace(/(\.[^.[\]]+|\[\d+\])$/, '');
    if (parent === current || parent === '') return null;
    current = parent;
  }
}

/**
 * Per-entry coverage: of the text fields that render as clickable text on the
 * entry's page (or are annotated anyway), the share whose control (or the
 * array control holding them) is named by an annotation there. An annotation
 * on or inside a link is left out (a click never reaches it), and so is one in
 * a card for another entry (see findEntryCards).
 * @param {DoctorEntry[]} entries
 * @param {Map<string, import('./html-scan.js').PageScan>} pages
 */
export function computeFieldCoverage(entries, pages) {
  const report = { totalFields: 0, coveredFields: 0, notRendered: 0, noControl: 0, entries: [], unchecked: [] };
  for (const entry of entries) {
    const page = pages.get(entry.pagePath);
    if (!page) {
      // The entry's page was not built (the build or the route is wrong).
      report.unchecked.push({ collection: entry.collection, slug: entry.slug, pagePath: entry.pagePath });
      continue;
    }
    const names = new Set(page.fields.filter((field) => !field.link && !field.card).map((field) => field.name));
    const { textFields: allTextFields, values, controls } = describeEntryFields(entry);
    // A field no control holds cannot be reached by any annotation.
    const textFields = allTextFields.filter((fieldPath) => owningControl(fieldPath, controls) !== null);
    report.noControl += allTextFields.length - textFields.length;
    const isCovered = (fieldPath) => names.has(owningControl(fieldPath, controls));
    const counted = textFields.filter((fieldPath) => isCovered(fieldPath) || isRenderedAsText(values.get(fieldPath), page));
    const missing = counted.filter((fieldPath) => !isCovered(fieldPath));
    const covered = counted.length - missing.length;
    report.totalFields += counted.length;
    report.coveredFields += covered;
    report.notRendered += textFields.length - counted.length;
    report.entries.push({
      collection: entry.collection,
      slug: entry.slug,
      pagePath: entry.pagePath,
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
 * data-aa-field values that name nothing in any entry on their page. A click
 * on one does nothing, which is the failure this exists to catch (a typo, or
 * `heading` where the control is `blocks[2].heading`). Annotations in a card
 * for another entry are reported by findEntryCards instead.
 * @param {DoctorEntry[]} entries
 * @param {Map<string, import('./html-scan.js').PageScan>} pages
 * @returns {Array<{pagePath: string, name: string}>}
 */
export function findUnknownFieldNames(entries, pages) {
  const validByPage = new Map();
  for (const entry of entries) {
    if (!validByPage.has(entry.pagePath)) validByPage.set(entry.pagePath, new Set());
    for (const control of describeEntryFields(entry).controls) validByPage.get(entry.pagePath).add(control);
  }
  const unknown = [];
  for (const [pagePath, valid] of validByPage) {
    const page = pages.get(pagePath);
    if (!page) continue;
    const seen = new Set();
    for (const field of page.fields) {
      if (field.card || valid.has(field.name) || seen.has(field.name)) continue;
      seen.add(field.name);
      unknown.push({ pagePath, name: field.name });
    }
  }
  return unknown;
}

/**
 * Pages marking a card as another entry's with data-aa-entry, which this
 * version does not support: the attribute is ignored, so a click on an
 * annotation inside the card focuses the OPEN entry's field of that name, and
 * those annotations count toward no entry's coverage.
 * @param {Map<string, import('./html-scan.js').PageScan>} pages
 * @returns {Array<{pagePath: string, cards: number}>}
 */
export function findEntryCards(pages) {
  const found = [];
  for (const [pagePath, page] of pages) {
    if (page.entryCards > 0) found.push({ pagePath, cards: page.entryCards });
  }
  return found;
}

/**
 * Block roots that the integration would match to the wrong block. It picks
 * the root for block i by POSITION among the page's [data-block-index]
 * elements, not by the attribute's value, so the roots must carry 0..n-1 in
 * document order: one per block, none missing, none extra, none nested inside
 * another. Without any, it guesses by counting top-level <section> elements,
 * which misaligns as soon as one block renders something else.
 *
 * A page whose entry has two block lists cannot be checked by position (the
 * roots of both share one sequence), so only the indexes' presence is checked
 * there.
 * @param {DoctorEntry[]} entries
 * @param {Map<string, import('./html-scan.js').PageScan>} pages
 */
export function findUnindexedBlocks(entries, pages) {
  const report = { totalBlocks: 0, indexedBlocks: 0, pages: [], unchecked: [] };
  for (const entry of entries) {
    const lists = (entry.blockArrays || [])
      .map((key) => ({ key, blocks: entry.data?.[key] }))
      .filter(({ blocks }) => Array.isArray(blocks) && blocks.length > 0);
    if (lists.length === 0 || !entry.pagePath) continue;
    const page = pages.get(entry.pagePath);
    if (!page) {
      report.unchecked.push({ collection: entry.collection, slug: entry.slug, pagePath: entry.pagePath });
      continue;
    }
    const indexes = page.blockIndexes || [];
    const nested = page.blockNested || [];
    for (const { key, blocks } of lists) {
      const count = blocks.length;
      const expected = blocks.map((block, index) => index);
      const missing = expected.filter((index) => !indexes.includes(index));
      const problems = [];
      let correct;
      if (lists.length > 1) {
        correct = count - missing.length;
      } else {
        correct = expected.filter((index) => indexes[index] === index && !nested[index]).length;
        const seen = new Set();
        const duplicates = new Set(indexes.filter((value) => (seen.has(value) ? true : (seen.add(value), false))));
        const extra = indexes.filter((value) => value === null || value < 0 || value >= count);
        if (duplicates.size > 0) problems.push(`duplicated ${[...duplicates].join(', ')}`);
        if (extra.length > 0) problems.push(`${extra.length} root(s) with no matching block (${extra.map((value) => (value === null ? 'not a number' : value)).join(', ')})`);
        if (nested.some(Boolean)) problems.push(`nested roots at position(s) ${nested.flatMap((isNested, position) => (isNested ? [position] : [])).join(', ')}`);
        if (problems.length === 0 && missing.length === 0 && correct < count) problems.push(`out of order (${indexes.join(', ')} in page order)`);
      }
      if (missing.length > 0) problems.unshift(`missing ${missing.join(', ')}`);
      report.totalBlocks += count;
      report.indexedBlocks += correct;
      if (problems.length > 0) {
        report.pages.push({ collection: entry.collection, slug: entry.slug, pagePath: entry.pagePath, field: key, blocks: count, missing, problems });
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
