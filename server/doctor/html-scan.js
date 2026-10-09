/**
 * Read the click-to-edit facts out of BUILT HTML.
 *
 * Measured on the build rather than the templates, because the build is what
 * the preview renders: it includes attributes a wrapper component dropped (or
 * never forwarded), and leaves out blocks a condition never rendered.
 *
 * Uses Bun's HTMLRewriter (a real HTML tokenizer), so attributes inside
 * <script> or comments are never mistaken for elements.
 *
 * What a visitor never sees is left out, the same way for annotations, entry
 * references and text:
 * - <template>, <noscript>, <script> and <style> content is not in the page's
 *   DOM at all (a browser with scripting on parses <noscript> as text), so its
 *   annotations, block roots and text are all ignored.
 * - An element with the `hidden` attribute (and everything inside it) is in
 *   the DOM but not rendered: its annotations cannot be clicked and its text
 *   is not read, so neither counts. Its data-block-index DOES count, because
 *   the integration picks block roots by position among every
 *   [data-block-index] in the DOM, hidden or not.
 * - `aria-hidden="true"` hides an element from assistive technology only; it
 *   is still visible and clickable, so it is treated as rendered.
 * - Text inside <svg> (icon titles) and <title> is not body text.
 * - <head> is never rendered, so an annotation or data-aa-entry in it (a
 *   `<title data-aa-field="title">`) cannot be clicked and does not count.
 *   The same goes for the head-only elements (title, meta, link, base) where
 *   a page has no <head> tag. Its data-block-index DOES count, for the same
 *   reason as a hidden one: the integration's position count includes it.
 *   The head ends where a browser ends it: at </head>, at the first element
 *   that is not head content (a <div> after an unclosed <head> is body), or at
 *   the first text that is not whitespace.
 * CSS (`display: none`, a `hidden` class) is not evaluated.
 *
 * A page with no <body> tag (a fragment, or a template that leaves the tag
 * implicit) has an implicit body: everything outside <head> is body text.
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * One element carrying data-aa-field.
 * @typedef {Object} AnnotatedElement
 * @property {string} name - the attribute's value (an editor control's form name)
 * @property {string} tag - lower-case tag name
 * @property {'is'|'inside'|null} link - 'is' when the element is itself a
 *   link that navigates (<a href>, <area href>), 'inside' when it sits inside
 *   one. The integration lets such a click navigate and focuses nothing, so
 *   either way the annotation can never fire.
 * @property {string|null} entry - the nearest data-aa-entry on the element or
 *   an ancestor (`<collection>/<slug>`), or null for the page's own entry
 */

/**
 * @typedef {Object} PageScan
 * @property {AnnotatedElement[]} fields
 * @property {string[]} entryRefs - every distinct data-aa-entry value, in document order
 * @property {Array<number|null>} blockIndexes - every data-block-index value in
 *   the DOM, in document order (null for a value that is not an integer)
 * @property {boolean[]} blockNested - for each of blockIndexes, whether it sits
 *   inside another data-block-index element
 * @property {string} clickableText - the body's visible text outside links,
 *   reduced by comparableText(): what a click-to-edit annotation could cover
 * @property {string} clickableWords - the same text as comparableWords(), with
 *   a space at each end, for matching a short value as whole words
 * @property {string} linkText - visible text inside links, as comparableText()
 * @property {string} bodyText - all visible body text, as comparableText()
 */

// Elements the HTML parser only ever puts in (or treats as) head content,
// wherever they appear: never rendered, so never clickable.
const HEAD_ONLY_TAGS = new Set(['title', 'meta', 'link', 'base']);
// Elements that stay inside an open <head>; any other start tag ends it.
const HEAD_CONTENT_TAGS = new Set([...HEAD_ONLY_TAGS, 'style', 'script', 'noscript', 'template']);

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * Text reduced to lower-case letters and digits, so a field's value can be
 * found in the page however it was rendered (Markdown, smart quotes, entities,
 * line breaks).
 * @param {string} text
 */
export function comparableText(text) {
  return decodeEntities(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Text as lower-case words of letters and digits separated by single spaces.
 * @param {string} text
 */
export function comparableWords(text) {
  return decodeEntities(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Scan one page's HTML.
 * @param {string} html
 * @returns {Promise<PageScan>}
 */
export async function scanHtml(html) {
  /** @type {AnnotatedElement[]} */
  const fields = [];
  const blockIndexes = [];
  const blockNested = [];
  const entryRefs = [];
  // Open elements carrying data-aa-entry, innermost last.
  const openEntries = [];
  const textChunks = [];
  const linkChunks = [];
  const bodyChunks = [];
  let bodyDepth = 0;
  // Inside <head>: from its start tag to </head> or the first element that
  // is not head content.
  let inHead = false;
  let sawBody = false;
  let linkDepth = 0;
  // Content that is not in the DOM (template, noscript, script, style).
  let absentDepth = 0;
  // Inside an element carrying `hidden`: in the DOM, not rendered.
  let hiddenDepth = 0;
  // Text that is rendered but is not body text (svg, title).
  let nonTextDepth = 0;
  let blockDepth = 0;
  const isNavigatingLink = (element) => {
    const tag = element.tagName.toLowerCase();
    return (tag === 'a' || tag === 'area') && element.hasAttribute('href');
  };
  const trackDepth = (element, change) => {
    if (!element.canHaveContent || element.selfClosing) return;
    change(1);
    element.onEndTag(() => change(-1));
  };
  const isRendered = (element) => absentDepth === 0 && hiddenDepth === 0 && !inHead
    && !element.hasAttribute('hidden') && !HEAD_ONLY_TAGS.has(element.tagName.toLowerCase());

  // Handler order matters: for one element, handlers run in registration
  // order, so the depth trackers that describe an element's ANCESTORS must
  // not yet have counted the element itself when the recorders below look at
  // them (an annotated <a href> is "is a link", not "inside a link"; a block
  // root is nested only inside ANOTHER block root).
  const rewriter = new HTMLRewriter()
    .on('body', { element(element) { sawBody = true; trackDepth(element, (delta) => { bodyDepth += delta; }); } })
    .on('template, noscript, script, style', { element(element) { trackDepth(element, (delta) => { absentDepth += delta; }); } })
    // After the absent tracker, so elements inside a <template> in the head
    // (not in the DOM) do not end it.
    .on('*', {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (tag === 'head') {
          inHead = true;
          if (element.canHaveContent && !element.selfClosing) element.onEndTag(() => { inHead = false; });
        } else if (inHead && absentDepth === 0 && !HEAD_CONTENT_TAGS.has(tag)) {
          inHead = false;
        }
      },
    })
    .on('[data-block-index]', {
      element(element) {
        if (absentDepth > 0) return;
        const value = Number.parseInt(element.getAttribute('data-block-index'), 10);
        blockIndexes.push(Number.isInteger(value) ? value : null);
        blockNested.push(blockDepth > 0);
        trackDepth(element, (delta) => { blockDepth += delta; });
      },
    })
    // Registered before the data-aa-field handler, so an element carrying both
    // is already the innermost entry when its field is recorded.
    .on('[data-aa-entry]', {
      element(element) {
        if (!isRendered(element)) return;
        const value = element.getAttribute('data-aa-entry') || '';
        if (!entryRefs.includes(value)) entryRefs.push(value);
        if (!element.canHaveContent || element.selfClosing) return;
        openEntries.push(value);
        element.onEndTag(() => { openEntries.pop(); });
      },
    })
    // Registered before the link handler, so an annotated <a href> has not yet
    // counted itself when it is recorded: linkDepth > 0 here means an
    // enclosing link.
    .on('[data-aa-field]', {
      element(element) {
        if (!isRendered(element)) return;
        const link = isNavigatingLink(element) ? 'is' : linkDepth > 0 ? 'inside' : null;
        const entry = element.hasAttribute('data-aa-entry') ? element.getAttribute('data-aa-entry') || '' : openEntries.at(-1) ?? null;
        fields.push({ name: element.getAttribute('data-aa-field') || '', tag: element.tagName.toLowerCase(), link, entry });
      },
    })
    .on('[hidden]', { element(element) { trackDepth(element, (delta) => { hiddenDepth += delta; }); } })
    .on('svg, title', { element(element) { trackDepth(element, (delta) => { nonTextDepth += delta; }); } })
    .on('a[href]', { element(element) { trackDepth(element, (delta) => { linkDepth += delta; }); } })
    .onDocument({
      text(chunk) {
        // In the "in head" insertion mode a character that is not HTML
        // whitespace implies </head> and is reprocessed as body content, so
        // `<head><title>T</title>Welcome` puts "Welcome" in the body. Text
        // inside <title> (nonText) or script/style/noscript/template (absent)
        // belongs to that element and does not.
        if (inHead && absentDepth === 0 && nonTextDepth === 0 && /[^\t\n\f\r ]/.test(chunk.text)) {
          inHead = false;
        }
        const inBody = bodyDepth > 0 || (!sawBody && !inHead);
        if (!inBody || absentDepth > 0 || hiddenDepth > 0 || nonTextDepth > 0) return;
        const target = linkDepth > 0 ? linkChunks : textChunks;
        target.push(chunk.text);
        bodyChunks.push(chunk.text);
        // A text node can arrive in several chunks; separate whole nodes only.
        if (chunk.lastInTextNode) target.push(' ');
      },
    });

  await rewriter.transform(new Response(html)).text();
  const visibleText = textChunks.join('');
  return {
    fields,
    entryRefs,
    blockIndexes,
    blockNested,
    clickableText: comparableText(visibleText),
    clickableWords: ` ${comparableWords(visibleText)} `,
    linkText: comparableText(linkChunks.join('')),
    bodyText: comparableText(bodyChunks.join('')),
  };
}

/**
 * The files a page path can build to: `/about` is `about/index.html` with
 * Astro's default build.format, `about.html` with format 'file'.
 * @param {string} distDir
 * @param {string} pagePath - e.g. '/', '/about', '/articles/first-post'
 */
export function pageFileCandidates(distDir, pagePath) {
  const trimmed = pagePath.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return [path.join(distDir, 'index.html')];
  return [path.join(distDir, trimmed, 'index.html'), path.join(distDir, `${trimmed}.html`)];
}

/**
 * Every page in a build, as page paths: `index.html` is `/`, `about/index.html`
 * and `about.html` are `/about`. Pages no entry owns are included, since a page
 * can show cards for other entries (data-aa-entry).
 * @param {string} distDir
 * @returns {Promise<string[]>}
 */
export async function listBuiltPagePaths(distDir) {
  const pagePaths = [];
  const walk = async (directory, prefix) => {
    let items;
    try {
      items = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.isDirectory()) {
        await walk(path.join(directory, item.name), `${prefix}/${item.name}`);
      } else if (item.isFile() && item.name.endsWith('.html')) {
        pagePaths.push(item.name === 'index.html' ? (prefix || '/') : `${prefix}/${item.name.slice(0, -'.html'.length)}`);
      }
    }
  };
  await walk(distDir, '');
  return pagePaths;
}

/**
 * Scan the built page for each path. A path with no built file is left out of
 * the result (the caller reports it as not checked).
 * @param {string} distDir
 * @param {string[]} pagePaths
 * @returns {Promise<Map<string, PageScan>>}
 */
export async function scanBuiltPages(distDir, pagePaths) {
  const scans = new Map();
  for (const pagePath of new Set(pagePaths)) {
    for (const candidate of pageFileCandidates(distDir, pagePath)) {
      let html;
      try {
        html = await fs.readFile(candidate, 'utf-8');
      } catch {
        continue;
      }
      scans.set(pagePath, await scanHtml(html));
      break;
    }
  }
  return scans;
}
