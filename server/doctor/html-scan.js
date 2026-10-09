/**
 * Read the click-to-edit facts out of BUILT HTML.
 *
 * Measured on the build rather than the templates, because the build is what
 * the preview renders: it includes attributes a wrapper component dropped (or
 * never forwarded), and leaves out blocks a condition never rendered.
 *
 * Uses Bun's HTMLRewriter (a real HTML tokenizer), so attributes inside
 * <script> or comments are never mistaken for elements.
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
 * @property {number[]} blockIndexes - every data-block-index value, in document order
 * @property {string} clickableText - the body's visible text outside links,
 *   reduced by comparableText(): what a click-to-edit annotation could cover
 * @property {string} clickableWords - the same text as comparableWords(), with
 *   a space at each end, for matching a short value as whole words
 * @property {string} linkText - visible text inside links, as comparableText()
 * @property {string} bodyText - all visible body text, as comparableText()
 */

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
  const entryRefs = [];
  // Open elements carrying data-aa-entry, innermost last.
  const openEntries = [];
  // Text is collected only inside <body>, outside links and non-rendered elements.
  const textChunks = [];
  const linkChunks = [];
  const bodyChunks = [];
  let bodyDepth = 0;
  let linkDepth = 0;
  let hiddenDepth = 0;
  const isNavigatingLink = (element) => {
    const tag = element.tagName.toLowerCase();
    return (tag === 'a' || tag === 'area') && element.hasAttribute('href');
  };
  const trackDepth = (element, change) => {
    if (!element.canHaveContent || element.selfClosing) return;
    change(1);
    element.onEndTag(() => change(-1));
  };

  const rewriter = new HTMLRewriter()
    .on('body', { element(element) { trackDepth(element, (delta) => { bodyDepth += delta; }); } })
    .on('script, style, template, noscript, svg', { element(element) { trackDepth(element, (delta) => { hiddenDepth += delta; }); } })
    // Registered before the link handler, so an annotated <a href> has not yet
    // counted itself when it is recorded: linkDepth > 0 here means an
    // enclosing link.
    // Registered before the data-aa-field handler, so an element carrying both
    // is already the innermost entry when its field is recorded.
    .on('[data-aa-entry]', {
      element(element) {
        const value = element.getAttribute('data-aa-entry') || '';
        if (!entryRefs.includes(value)) entryRefs.push(value);
        if (!element.canHaveContent || element.selfClosing) return;
        openEntries.push(value);
        element.onEndTag(() => { openEntries.pop(); });
      },
    })
    .on('[data-aa-field]', {
      element(element) {
        const link = isNavigatingLink(element) ? 'is' : linkDepth > 0 ? 'inside' : null;
        const entry = element.hasAttribute('data-aa-entry') ? element.getAttribute('data-aa-entry') || '' : openEntries.at(-1) ?? null;
        fields.push({ name: element.getAttribute('data-aa-field') || '', tag: element.tagName.toLowerCase(), link, entry });
      },
    })
    .on('a[href]', { element(element) { trackDepth(element, (delta) => { linkDepth += delta; }); } })
    .on('[data-block-index]', {
      element(element) {
        const value = Number.parseInt(element.getAttribute('data-block-index'), 10);
        if (Number.isInteger(value)) blockIndexes.push(value);
      },
    })
    .onDocument({
      text(chunk) {
        if (bodyDepth === 0 || hiddenDepth > 0) return;
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
