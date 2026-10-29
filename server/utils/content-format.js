/**
 * Keep a saved file looking like the file it replaces.
 *
 * A save rewrites the whole entry from the editor's data, and the editor sends
 * keys in its own order (form order, `id` last) with dates as strings. Written
 * naively that reorders keys, re-expands inline JSON arrays, rewrites every
 * entry of a file() collection, and turns an unquoted YAML date (a Date to
 * Astro) into a quoted string. These helpers make a save change only what the
 * editor changed:
 *
 * - keys that already existed keep their position; new keys are appended
 *   (`orderLike`);
 * - an unchanged file() entry, or an unchanged frontmatter key, keeps its
 *   original text byte for byte;
 * - a value that was a YAML timestamp stays one (`restoreDates`): a date-only
 *   one is written back unquoted and date-only;
 * - new JSON text uses the file's indentation, and writes arrays of plain
 *   values on one line when the file already does.
 *
 * Every rendering, preserved or plain, is parsed back and compared with the
 * data (and markdown body) it must hold; the first that holds it exactly is
 * written, so formatting can never change what is saved. A markdown entry
 * that no rendering can hold is refused with an error rather than written.
 */

import matter from 'gray-matter';
import { DATE_MARKER } from '../../ui/schema-markers.js';

const DEFAULT_INDENT = '  ';
// A YAML 1.1 timestamp as js-yaml reads it: date-only, or date and time. Seconds
// are optional here because a datetime-local input sends none (2026-01-16T09:30).
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^(\d{4}-\d{1,2}-\d{1,2})(?:[Tt]|[ \t]+)(\d{1,2}:\d{2}(?::\d{2}(?:\.\d*)?)?)[ \t]*(Z|[-+]\d{1,2}(?::?\d{2})?)?$/;

/**
 * A Date from a TIMESTAMP string, read as YAML reads it: no zone means UTC.
 * (new Date() would read '2026-01-16T09:30' as local time.)
 * @returns {Date|null}
 */
function parseTimestamp(text) {
  const match = text.match(TIMESTAMP);
  if (!match) return null;
  const [, day, time, zone] = match;
  const [year, month, dayOfMonth] = day.split('-').map((part) => part.padStart(2, '0'));
  const [hours, ...rest] = time.split(':');
  let offset = 'Z';
  if (zone && zone !== 'Z') {
    const sign = zone[0];
    const digits = zone.slice(1).replace(':', '');
    offset = `${sign}${digits.slice(0, 2).padStart(2, '0')}:${(digits.slice(2) || '00').padEnd(2, '0')}`;
  }
  const iso = `${year.padStart(4, '0')}-${month}-${dayOfMonth}T${hours.padStart(2, '0')}:${rest.join(':')}${rest.length === 1 ? ':00' : ''}${offset}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse a markdown file's frontmatter. Always pass an options object: called
 * without one, gray-matter caches by input text, so after a parse of invalid
 * frontmatter throws, the next parse of the same text returns data {} and the
 * whole file as the body, which a save would then write back.
 * @param {string} raw
 */
export function parseFrontmatter(raw) {
  return matter(raw, {});
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * `target[key] = value` as an OWN property, whatever the key. Content data is
 * parsed JSON or YAML, where `__proto__` is an ordinary key; assigning it
 * would call the prototype setter instead, and the key would vanish from the
 * save. The result is still a plain object for JSON.stringify and js-yaml.
 */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * `next`, with the keys `previous` already had in `previous`'s order and new
 * keys after them, recursively through objects and arrays (array items are
 * matched by position). Values always come from `next`.
 */
export function orderLike(previous, next) {
  if (Array.isArray(previous) && Array.isArray(next)) {
    return next.map((item, index) => orderLike(previous[index], item));
  }
  if (!isPlainObject(previous) || !isPlainObject(next)) return next;
  const ordered = {};
  for (const key of Object.keys(previous)) {
    if (hasOwn(next, key)) setOwn(ordered, key, orderLike(previous[key], next[key]));
  }
  for (const key of Object.keys(next)) {
    if (!hasOwn(ordered, key)) setOwn(ordered, key, next[key]);
  }
  return ordered;
}

// Dates written back as date-only text (`2026-01-15`, not the ISO string).
const dateOnlyDates = new WeakSet();

/**
 * Where `previous` held a Date (an unquoted YAML timestamp) and `next` holds a
 * string the editor made from it, put a Date back, so the value keeps its type
 * (z.date() accepts a Date and refuses a string). The same instant, or the same
 * day sent from a date input, is the original Date itself, so it compares equal
 * and keeps its original text.
 */
export function restoreDates(previous, next) {
  if (Array.isArray(previous) && Array.isArray(next)) {
    return next.map((item, index) => restoreDates(previous[index], item));
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const restored = {};
    for (const [key, value] of Object.entries(next)) {
      setOwn(restored, key, restoreDates(hasOwn(previous, key) ? previous[key] : undefined, value));
    }
    return restored;
  }
  if (!(previous instanceof Date) || typeof next !== 'string' || Number.isNaN(previous.getTime())) return next;
  const iso = previous.toISOString();
  if (next === iso || (DATE_ONLY.test(next) && next === iso.slice(0, 10))) return previous;
  if (DATE_ONLY.test(next)) {
    const date = new Date(`${next}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return next;
    dateOnlyDates.add(date);
    return date;
  }
  return parseTimestamp(next) ?? next;
}

/**
 * Top-level fields a collection's parsed JSON schema marks as dates: the
 * schema parser's `'x-astroadmin-date': true` on z.date() / z.coerce.date(),
 * directly or in an anyOf/oneOf branch, as optional and nullable fields come
 * out. `format: 'date'` alone is not enough: z.iso.date() and zod 3's
 * z.string().date() emit it too, and those are strings.
 * @param {Object|null} jsonSchema
 * @returns {Set<string>}
 */
export function dateFieldsFromSchema(jsonSchema) {
  const fields = new Set();
  const isDate = (node) => Boolean(node) && (node[DATE_MARKER] === true
    || [...(node.anyOf || []), ...(node.oneOf || []), ...(node.allOf || [])].some(isDate));
  for (const [name, property] of Object.entries(jsonSchema?.properties || {})) {
    if (isDate(property)) fields.add(name);
  }
  return fields;
}

/**
 * A NEW top-level value (no original value at that key) in a schema date field
 * becomes a Date, written unquoted: z.date() refuses the quoted string. An
 * existing value keeps its type (restoreDates and the original text decide),
 * and nothing is guessed from a string without the schema saying so.
 */
function datesForNewValues(originalData, data, dateFields) {
  if (!dateFields || dateFields.size === 0) return data;
  const converted = { ...data };
  for (const key of dateFields) {
    if (hasOwn(originalData, key) || !hasOwn(converted, key)) continue;
    const value = converted[key];
    if (typeof value !== 'string') continue;
    if (DATE_ONLY.test(value)) {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime())) continue;
      dateOnlyDates.add(date);
      setOwn(converted, key, date);
    } else {
      const date = parseTimestamp(value);
      if (date) setOwn(converted, key, date);
    }
  }
  return converted;
}

/** Deep equality for parsed content: plain objects, arrays, Dates and primitives. */
export function sameValue(left, right) {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
  }
  return Object.is(left, right) || left === right;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * The file's indentation unit and whether it writes arrays of plain values on
 * one line (`"skills": ["a", "b"]`) rather than one item per line.
 * @returns {{indent: string, inlineArrays: boolean}}
 */
export function detectJsonStyle(text) {
  const indentMatch = typeof text === 'string' ? text.match(/\n([ \t]+)\S/) : null;
  const indent = indentMatch ? indentMatch[1] : DEFAULT_INDENT;
  const plainItem = String.raw`(?:"(?:[^"\\\n]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)`;
  const inline = new RegExp(String.raw`\[[ \t]*${plainItem}(?:[ \t]*,[ \t]*${plainItem})*[ \t]*\]`);
  const multiline = new RegExp(String.raw`\[[ \t]*\n\s*${plainItem}\s*(?:,\s*${plainItem}\s*)*\]`);
  const inlineArrays = typeof text === 'string' && inline.test(text) && !multiline.test(text);
  return { indent, inlineArrays };
}

function isPlainJsonValue(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * JSON.stringify(value, null, indent), except that with `inlineArrays` an array
 * of plain values is written on one line. `prefix` is the current line's
 * indentation.
 */
export function formatJson(value, style, prefix = '') {
  if (value && typeof value.toJSON === 'function') value = value.toJSON();
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => (item === undefined || typeof item === 'function' ? null : item));
    if (style.inlineArrays && items.every(isPlainJsonValue)) {
      return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
    }
    const inner = prefix + style.indent;
    return `[\n${items.map((item) => inner + formatJson(item, style, inner)).join(',\n')}\n${prefix}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== 'function');
    if (entries.length === 0) return '{}';
    const inner = prefix + style.indent;
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${formatJson(item, style, inner)}`).join(',\n')}\n${prefix}}`;
  }
  return JSON.stringify(value);
}

/**
 * The text span of each top-level element of a JSON array, or null when the
 * text is not one.
 * @returns {{open: number, close: number, spans: Array<[number, number]>}|null}
 */
function topLevelElementSpans(text) {
  const open = text.indexOf('[');
  if (open < 0 || text.slice(0, open).trim().replace(/^﻿/, '') !== '') return null;
  const spans = [];
  let position = open + 1;
  const skipSpace = () => {
    while (position < text.length && /\s/.test(text[position])) position++;
  };
  skipSpace();
  if (text[position] === ']') return { open, close: position, spans };
  while (position < text.length) {
    skipSpace();
    const start = position;
    let depth = 0;
    let inString = false;
    for (; position < text.length; position++) {
      const character = text[position];
      if (inString) {
        if (character === '\\') position++;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '[' || character === '{') depth++;
      else if (character === ']' || character === '}') {
        if (depth === 0) break;
        depth--;
      } else if (character === ',' && depth === 0) break;
    }
    let end = position;
    while (end > start && /\s/.test(text[end - 1])) end--;
    spans.push([start, end]);
    if (text[position] === ']') return { open, close: position, spans };
    if (text[position] !== ',') return null;
    position++;
  }
  return null;
}

function jsonMatches(text, value) {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

/**
 * Serialise `value` as the replacement for the JSON file `originalText`.
 * For a top-level array (a file() collection) an element that is unchanged
 * keeps its original text; a changed or new one is formatted in the file's
 * style. Falls back to plain `JSON.stringify(value, null, 2)` when the
 * original cannot be followed.
 */
export function serializeJson(value, originalText = null) {
  const plain = `${JSON.stringify(value, null, 2)}\n`;
  if (typeof originalText !== 'string' || originalText.includes('\r')) return plain;
  let original;
  try {
    original = JSON.parse(originalText);
  } catch {
    return plain;
  }
  const style = detectJsonStyle(originalText);
  const trailingNewline = /\n$/.test(originalText) ? '\n' : '';

  let candidate;
  if (Array.isArray(value) && Array.isArray(original)) {
    const layout = topLevelElementSpans(originalText);
    if (!layout || layout.spans.length === 0 || layout.spans.length !== original.length) {
      candidate = `${formatJson(value, style)}${trailingNewline}`;
    } else {
      const { open, close, spans } = layout;
      const lead = originalText.slice(open + 1, spans[0][0]);
      const separator = spans.length > 1 ? originalText.slice(spans[0][1], spans[1][0]) : `,${lead}`;
      const trail = originalText.slice(spans[spans.length - 1][1], close);
      const itemPrefix = lead.includes('\n') ? lead.slice(lead.lastIndexOf('\n') + 1) : '';
      // Unchanged elements are found by content, so a delete or a reorder keeps
      // every other element's text.
      const unused = new Map();
      original.forEach((item, index) => {
        const key = JSON.stringify(item);
        if (!unused.has(key)) unused.set(key, []);
        unused.get(key).push(originalText.slice(spans[index][0], spans[index][1]));
      });
      const pieces = value.map((item) => {
        const kept = unused.get(JSON.stringify(item));
        if (kept && kept.length > 0) return kept.shift();
        return formatJson(item, style, itemPrefix);
      });
      candidate = pieces.length === 0
        ? `${originalText.slice(0, open)}[]${originalText.slice(close + 1)}`
        : `${originalText.slice(0, open + 1)}${lead}${pieces.join(separator)}${trail}${originalText.slice(close)}`;
    }
  } else {
    candidate = `${formatJson(value, style)}${trailingNewline}`;
  }
  return jsonMatches(candidate, value) ? candidate : plain;
}

// ---------------------------------------------------------------------------
// Markdown frontmatter
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-?:,[\]{}&*!|>%@`][^:#]*?))[ \t]*:(?:[ \t]|$)/;

/**
 * Split frontmatter YAML into its top-level keys' text. Each key owns its line
 * and every indented (or `- ` sequence) line after it; blank and comment lines
 * after a key are kept apart as the gap before the next one. Returns null for
 * anything this does not follow (flow mappings, anchors at the top level,
 * complex keys, duplicate keys).
 */
function splitTopLevelKeys(yamlText) {
  const lines = yamlText.split('\n');
  const preamble = [];
  /** @type {Array<{key: string, body: string[], gap: string[]}>} */
  const segments = [];
  for (const line of lines) {
    const current = segments[segments.length - 1];
    if (line.trim() === '' || /^\s*#/.test(line)) {
      (current ? current.gap : preamble).push(line);
      continue;
    }
    if (/^[ \t]/.test(line) || /^- /.test(line) || line === '-') {
      if (!current) return null;
      // An indented line after a comment gap belongs to the value: fold the gap in.
      current.body.push(...current.gap, line);
      current.gap = [];
      continue;
    }
    const match = line.match(TOP_LEVEL_KEY);
    if (!match) return null;
    const key = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2] !== undefined ? match[2].replace(/''/g, "'") : match[3].trim();
    if (segments.some((segment) => segment.key === key)) return null;
    segments.push({ key, body: [line], gap: [] });
  }
  return { preamble, segments };
}

// gray-matter's own YAML engine (js-yaml's safeDump / safeLoad). The
// serialiser calls it directly rather than through matter.stringify(body,
// data), which PARSES `body` as a file first: a body that itself began with a
// `---` block had its keys merged into the data (or threw on invalid YAML),
// and the dumped YAML was trim()med, losing a keep-chomp scalar's final
// newlines.
const yamlEngine = matter.engines.yaml;

/** One top-level key as gray-matter would write it, without the delimiters. */
function dumpKey(key, value) {
  const single = {};
  setOwn(single, key, value);
  let yamlText = yamlEngine.stringify(single);
  if (value instanceof Date && dateOnlyDates.has(value)) {
    const iso = value.toISOString();
    yamlText = yamlText.replace(iso, iso.slice(0, 10));
  }
  return yamlText.replace(/\n$/, '');
}

function withNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function frontmatterMatches(text, data, body) {
  try {
    // A fresh options object skips gray-matter's cache, which is keyed by the
    // input text and shares the parsed data object between callers.
    const parsed = matter(text, {});
    return sameValue(parsed.data, data) && withNewline(parsed.content) === withNewline(body);
  } catch {
    return false;
  }
}

/**
 * Serialise a markdown entry as the replacement for `originalRaw`: keys in
 * their original order, unchanged keys in their original text, dates kept as
 * dates. Without an original (a new entry) it is gray-matter's own output.
 * @param {string} body
 * @param {Object} data
 * @param {string|null} originalRaw
 * @param {{dateFields?: Set<string>|null}} [options] - top-level fields the
 *   collection's schema says are dates (dateFieldsFromSchema)
 */
export function serializeMarkdown(body, data, originalRaw = null, { dateFields = null } = {}) {
  const text = body || '';
  if (typeof originalRaw !== 'string') {
    const intended = datesForNewValues({}, data, dateFields);
    // Key by key, so a date-only Date is written date-only; the same text as
    // gray-matter's otherwise.
    const keyByKey = Object.keys(intended).length === 0
      ? null
      : frontmatterDocument(Object.entries(intended).map(([key, value]) => dumpKey(key, value)).join('\n'), text);
    return firstFaithful([keyByKey, ...plainDocuments(intended, text)], intended, text);
  }

  let original;
  try {
    original = matter(originalRaw, {});
  } catch {
    return firstFaithful(plainDocuments(data, text), data, text);
  }
  const originalData = original.data || {};
  const intended = orderLike(originalData, datesForNewValues(originalData, restoreDates(originalData, data), dateFields));
  return firstFaithful([...preservingDocuments(original, originalRaw, intended, text), ...plainDocuments(intended, text)], intended, text);
}

/**
 * `---`, the YAML, `---`, then the body verbatim. An empty body is nothing
 * after the closing fence: a frontmatter-only file reads back as body '', and
 * writing that as a newline added a blank line on every save (#71).
 */
function frontmatterDocument(yamlText, body) {
  return `---\n${yamlText}\n---\n${body === '' ? '' : withNewline(body)}`;
}

/**
 * The whole data dumped afresh. First gray-matter's own layout (the dumped
 * YAML trimmed; no block at all for empty data); then the layout that keeps
 * the dump's trailing newlines, which a final keep-chomp (`|+`) scalar needs,
 * and an explicit empty block, which a body that starts with `---` needs.
 */
function plainDocuments(data, body) {
  if (Object.keys(data).length === 0) return [withNewline(body), `---\n---\n${withNewline(body)}`];
  const dumped = yamlEngine.stringify(data);
  return [frontmatterDocument(dumped.trim(), body), frontmatterDocument(dumped, body)];
}

/**
 * The original frontmatter with only the changed keys rewritten: tidied of
 * trailing blank lines, then exactly as the original ended (a final keep-chomp
 * scalar owns those blank lines).
 */
function preservingDocuments(original, originalRaw, intended, body) {
  if (originalRaw.includes('\r') || !originalRaw.startsWith('---\n') || Object.keys(intended).length === 0) return [];
  const originalData = original.data || {};
  const split = splitTopLevelKeys(String(original.matter || '').replace(/^\n/, ''));
  if (!split || split.segments.length !== Object.keys(originalData).length) return [];
  const byKey = new Map(split.segments.map((segment) => [segment.key, segment]));

  const lines = [...split.preamble];
  for (const [key, value] of Object.entries(intended)) {
    const segment = byKey.get(key);
    if (segment && hasOwn(originalData, key) && sameValue(originalData[key], value)) {
      lines.push(...segment.body);
    } else {
      lines.push(dumpKey(key, value));
    }
    if (segment) lines.push(...segment.gap);
  }
  const untidied = frontmatterDocument(lines.join('\n'), body);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return [frontmatterDocument(lines.join('\n'), body), untidied];
}

/**
 * The first document that parses back to exactly `data` and `body`. None of
 * them is written unchecked: when none holds the data, the save fails loudly
 * rather than writing something else.
 */
function firstFaithful(documents, data, body) {
  for (const document of documents) {
    if (document !== null && frontmatterMatches(document, data, body)) return document;
  }
  throw new Error('This entry cannot be written as markdown frontmatter without changing its data or body');
}
