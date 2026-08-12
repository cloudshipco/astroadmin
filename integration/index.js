/**
 * AstroAdmin Astro Integration
 *
 * Provides:
 * 1. Component preview route for non-page collections (testimonials, team, etc.)
 * 2. Block focus script for scrolling to blocks when clicked in admin panel
 *
 * Usage:
 *   import astroadmin from 'astroadmin/integration';
 *
 *   export default defineConfig({
 *     integrations: [astroadmin()],
 *   });
 */

import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Script injected into pages during dev mode to handle AstroAdmin postMessages.
 * Enables clicking a block in the admin panel to scroll to it in the preview.
 * Works automatically without requiring site modifications.
 */
const adminPreviewScript = `
// AstroAdmin preview integration - handles block focus from admin panel
(function() {
  // Only run in iframe (preview context)
  if (window.parent === window) return;

  let currentHighlight = null;

  /**
   * Find block elements using multiple strategies (no site modifications required)
   */
  function findBlocks() {
    // Strategy 1: Explicit data-block-index attributes (best, if site adds them)
    let blocks = document.querySelectorAll('[data-block-index]');
    if (blocks.length > 0) return Array.from(blocks);

    // Strategy 2: Top-level sections (common Astro pattern)
    // Find sections that are direct content blocks, not nav/header/footer
    blocks = Array.from(document.querySelectorAll('section')).filter(section => {
      // Skip if inside nav, header, or footer
      if (section.closest('nav, header, footer')) return false;
      // Skip if nested inside another section (only keep top-level)
      if (section.parentElement.closest('section')) return false;
      return true;
    });
    if (blocks.length > 0) return blocks;

    // Strategy 3: Direct children of main element
    const main = document.querySelector('main');
    if (main) {
      blocks = Array.from(main.children).filter(el =>
        !['NAV', 'HEADER', 'FOOTER', 'SCRIPT', 'STYLE'].includes(el.tagName)
      );
      if (blocks.length > 0) return blocks;
    }

    return [];
  }

  // Map field names to CSS selectors for field-level focus
  const fieldSelectors = {
    heading: 'h1, h2, h3, h4, h5, h6, [class*="heading"]',
    subheading: 'p:first-of-type, [class*="subheading"], [class*="subtitle"]',
    content: '[class*="prose"], [class*="content"]',
    description: '[class*="description"]',
    image: 'img',
    primaryCTA: 'a:first-of-type, button:first-of-type',
    secondaryCTA: 'a:nth-of-type(2), button:nth-of-type(2)',
  };

  // Report current URL on page load (for AstroAdmin entry sync)
  window.parent.postMessage({
    type: 'pageNavigation',
    pathname: window.location.pathname
  }, '*');

  // Click-to-edit: a site marks an editable element with data-aa-field="<name>".
  // Clicking it tells the editor to focus that control. A subtle hover
  // affordance shows those elements are clickable in the preview.
  // Style via a stylesheet + a toggle class (not inline styles), so we never
  // clobber or fail to restore a consumer's own inline outline/transition. No
  // transition shorthand either — that would override the tagged element's own.
  const affordance = document.createElement('style');
  affordance.textContent =
    '[data-aa-field]{cursor:pointer}' +
    '[data-aa-field]:hover{outline:2px dashed rgba(59,130,246,.7);outline-offset:3px}' +
    '.aa-highlight{outline:2px solid #3b82f6;outline-offset:3px}';
  document.head.appendChild(affordance);

  document.addEventListener('click', (event) => {
    const el = event.target.closest && event.target.closest('[data-aa-field]');
    if (!el) return;
    // Let genuine links still navigate; otherwise there's no default to block.
    window.parent.postMessage({ type: 'fieldFocus', field: el.dataset.aaField }, '*');
  });

  // Briefly outline an element when its control is focused/clicked in the editor.
  // One shared timer, cleared on every call, so re-highlighting (even a different
  // element) can't let a stale timeout strip the newer highlight early.
  let highlightTimer = null;
  function highlightEl(el) {
    if (currentHighlight) currentHighlight.classList.remove('aa-highlight');
    if (highlightTimer) clearTimeout(highlightTimer);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('aa-highlight');
    currentHighlight = el;
    highlightTimer = setTimeout(() => {
      el.classList.remove('aa-highlight');
      if (currentHighlight === el) currentHighlight = null;
      highlightTimer = null;
    }, 1500);
  }

  // Listen for messages from AstroAdmin
  window.addEventListener('message', (event) => {
    // Handle scroll restoration
    if (event.data?.type === 'restoreScroll') {
      window.scrollTo(0, event.data.scrollY);
      return;
    }

    // Highlight an editable element when its control is focused in the editor.
    // Compare the attribute value directly rather than interpolating it into a
    // selector — the field name is untrusted (it comes from the editor) and a
    // value with quotes/brackets/newlines would inject or crash querySelector.
    if (event.data?.type === 'highlightField') {
      const field = event.data.field;
      if (typeof field !== 'string') return;
      const el = Array.prototype.find.call(
        document.querySelectorAll('[data-aa-field]'),
        (e) => e.getAttribute('data-aa-field') === field
      );
      if (el) highlightEl(el);
      return;
    }

    // Handle block focus — reuse the SAME class-based highlight as field focus
    // so the two share one cleanup path (previously block focus used inline
    // styles while field focus used a class, leaving stale highlights when they
    // interleaved).
    if (event.data?.type === 'focusBlock') {
      const { index, fieldName } = event.data;
      const blocks = findBlocks();
      const block = blocks[index];
      if (block) {
        let targetElement = block;
        if (fieldName && fieldSelectors[fieldName]) {
          const specificEl = block.querySelector(fieldSelectors[fieldName]);
          if (specificEl) targetElement = specificEl;
        }
        highlightEl(targetElement);
      }
    }
  });

  // Report scroll position to parent for restoration after refresh
  let scrollTimeout;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      window.parent.postMessage({ type: 'scrollPosition', scrollY: window.scrollY }, '*');
    }, 100);
  });
})();
`;

/**
 * AstroAdmin integration for component preview.
 *
 * @param {Object} options - Integration options
 * @param {boolean} [options.enabled=true] - Enable the component preview route
 * @returns {import('astro').AstroIntegration}
 */
export default function astroadminIntegration(options = {}) {
  const { enabled = true } = options;

  return {
    name: 'astroadmin',
    hooks: {
      'astro:config:setup': ({ injectRoute, injectScript, command, logger }) => {
        // Only inject in dev mode
        if (command !== 'dev') {
          return;
        }

        if (!enabled) {
          logger.info('AstroAdmin integration disabled');
          return;
        }

        // Inject block focus script into all pages
        injectScript('page', adminPreviewScript);

        // Get the path to our preview route template
        const previewRoutePath = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          'preview-route.astro'
        );

        // Inject the component preview route
        injectRoute({
          pattern: '/component-preview/[block]/[...slug]',
          entrypoint: previewRoutePath,
        });
      },
    },
  };
}
