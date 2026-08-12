/**
 * Formatting toolbar for a Markdown body <textarea>.
 *
 * Attaches a bar of buttons above the textarea that insert Markdown at the
 * cursor (bold, italic, headings, quote, lists, link) and insert an image via
 * the existing image library. The editing logic is in markdown-transforms.js
 * (pure, unit-tested); this file is only the DOM glue.
 *
 * Invariants (see CLAUDE.md "admin UI invariants"):
 *  - After every programmatic edit, dispatch a bubbling `input` event so the
 *    form's debounced autosave and the changes panel see it.
 *  - The image-library modal already outranks the editor; reusing it inherits
 *    the correct z-index.
 *  - This edits the textarea's own value; the body is saved by reading that same
 *    element by id, so nothing else needs to change.
 */
import {
  wrapInline,
  toggleLinePrefix,
  setHeading,
  toggleOrderedList,
  insertLink,
  insertImage,
  codeBlock,
} from './markdown-transforms.js';
import { openImageLibrary } from './image-library.js';

const ICONS = {
  bold: '<strong>B</strong>',
  italic: '<em>I</em>',
  code: '&lt;/&gt;',
  h2: 'H2',
  h3: 'H3',
  quote: '&ldquo;',
  ul: '&bull;',
  ol: '1.',
  link: '&#128279;', // link glyph
  image: '&#128247;', // camera glyph
  codeblock: '{ }',
};

/** Apply a transform result to the textarea and fire the events autosave needs. */
function apply(textarea, result) {
  textarea.value = result.value;
  textarea.focus();
  textarea.setSelectionRange(result.selStart, result.selEnd);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function sel(textarea) {
  return [textarea.value, textarea.selectionStart, textarea.selectionEnd];
}

const ACTIONS = {
  bold: (t) => apply(t, wrapInline(...sel(t), '**')),
  italic: (t) => apply(t, wrapInline(...sel(t), '*')),
  code: (t) => apply(t, wrapInline(...sel(t), '`')),
  codeblock: (t) => apply(t, codeBlock(...sel(t))),
  h2: (t) => apply(t, setHeading(...sel(t), 2)),
  h3: (t) => apply(t, setHeading(...sel(t), 3)),
  quote: (t) => apply(t, toggleLinePrefix(...sel(t), '> ')),
  ul: (t) => apply(t, toggleLinePrefix(...sel(t), '- ')),
  ol: (t) => apply(t, toggleOrderedList(...sel(t))),
  link: (t) => {
    const url = window.prompt('Link URL', 'https://');
    if (url === null) return; // cancelled
    apply(t, insertLink(...sel(t), url.trim()));
  },
  image: (t) => {
    const [, start] = sel(t);
    openImageLibrary((url) => {
      // Re-read selection: opening the modal can move focus.
      apply(t, insertImage(t.value, start, start, url));
    });
  },
};

const BUTTONS = [
  ['bold', 'Bold (Ctrl/Cmd+B)'],
  ['italic', 'Italic (Ctrl/Cmd+I)'],
  ['code', 'Inline code'],
  ['h2', 'Heading 2'],
  ['h3', 'Heading 3'],
  ['quote', 'Quote'],
  ['ul', 'Bulleted list'],
  ['ol', 'Numbered list'],
  ['link', 'Link (Ctrl/Cmd+K)'],
  ['image', 'Insert image'],
  ['codeblock', 'Code block'],
];

const SHORTCUTS = { b: 'bold', i: 'italic', k: 'link' };

/**
 * Enhance a Markdown textarea with a toolbar. Idempotent — a second call on the
 * same textarea is a no-op (guards against double-enhancement on re-render).
 */
export function enhanceMarkdownEditor(textarea) {
  if (!textarea || textarea.dataset.mdEnhanced === 'true') return;
  textarea.dataset.mdEnhanced = 'true';

  const bar = document.createElement('div');
  bar.className = 'md-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');
  bar.innerHTML = BUTTONS.map(
    ([key, title]) =>
      `<button type="button" class="md-toolbar-btn" data-md-action="${key}" title="${title}" aria-label="${title}">${ICONS[key]}</button>`,
  ).join('');

  // mousedown preventDefault keeps the textarea's selection while the button is
  // clicked (a button click would otherwise blur the textarea and collapse it).
  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.md-toolbar-btn')) e.preventDefault();
  });
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.md-toolbar-btn');
    if (!btn) return;
    const action = ACTIONS[btn.dataset.mdAction];
    if (action) action(textarea);
  });

  textarea.parentNode.insertBefore(bar, textarea);

  textarea.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = SHORTCUTS[e.key.toLowerCase()];
    if (!key) return;
    e.preventDefault();
    ACTIONS[key](textarea);
  });
}
