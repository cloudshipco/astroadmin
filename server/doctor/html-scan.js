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
 * @property {boolean} containsLink - an <a> sits inside it with no nearer
 *   annotated element in between, so a click on that link resolves here
 */

/**
 * @typedef {Object} PageScan
 * @property {AnnotatedElement[]} fields
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
  // Open annotated elements, innermost last. The integration resolves a click
  // with closest('[data-aa-field]'), so only the innermost one matters.
  const openAnnotated = [];
  // Text is collected only inside <body>, outside links and non-rendered elements.
  const textChunks = [];
  const linkChunks = [];
  const bodyChunks = [];
  let bodyDepth = 0;
  let linkDepth = 0;
  let hiddenDepth = 0;
  const trackDepth = (element, change) => {
    if (!element.canHaveContent || element.selfClosing) return;
    change(1);
    element.onEndTag(() => change(-1));
  };

  const rewriter = new HTMLRewriter()
    // Registered before the data-aa-field handler, so an annotated <a> is not
    // yet on the stack when its own 'a' handler runs.
    .on('body', { element(element) { trackDepth(element, (delta) => { bodyDepth += delta; }); } })
    .on('script, style, template, noscript, svg', { element(element) { trackDepth(element, (delta) => { hiddenDepth += delta; }); } })
    .on('a', {
      element(element) {
        const innermost = openAnnotated.at(-1);
        if (innermost) innermost.containsLink = true;
        trackDepth(element, (delta) => { linkDepth += delta; });
      },
    })
    .on('[data-aa-field]', {
      element(element) {
        const record = { name: element.getAttribute('data-aa-field') || '', tag: element.tagName.toLowerCase(), containsLink: false };
        fields.push(record);
        if (!element.canHaveContent || element.selfClosing) return;
        openAnnotated.push(record);
        element.onEndTag(() => {
          const position = openAnnotated.lastIndexOf(record);
          if (position !== -1) openAnnotated.splice(position, 1);
        });
      },
    })
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
