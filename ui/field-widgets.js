/**
 * Field Widgets
 * Interactive behaviour for the fields produced by form-generator.
 *
 * Shared by the main editor form and the array item modal so both surfaces get
 * identical widgets. Every lookup is scoped to the container passed in (never
 * document.getElementById) so a widget inside a modal can't reach into an
 * identically-named field on the form behind it.
 */

import { openImageLibrary, uploadNewImage } from './image-library.js';
import { openGalleryEditor } from './gallery-editor.js';
import { enhanceMarkdownEditor } from './markdown-toolbar.js';

import { escapeHtml } from './escape-html.js';

/**
 * Reference fields need to navigate the dashboard to open the entry they point at,
 * so their wiring lives in dashboard.js and registers itself here. Without this the
 * shared field layer couldn't reach it (dashboard → form-generator → array-editor
 * already runs one way, and importing back the other way would be a cycle), and a
 * reference field rendered into the item modal would show buttons that do nothing.
 * @type {?(container: HTMLElement, onChange?: Function) => void}
 */
let setupReferenceFields = null;

export function registerReferenceFieldHandlers(setup) {
  setupReferenceFields = setup;
}

/**
 * The entry being edited, for image() fields: their value is a path relative
 * to the entry's file. The dashboard registers it (it owns that state).
 * @type {() => ({collection: string, slug: string}|null)}
 */
let currentEntry = () => null;

export function registerEntryContext(getEntry) {
  currentEntry = getEntry;
}

/**
 * Store a picked library image in a picker.
 *
 * A plain image field stores the library URL (`/images/x.jpg`), as it always
 * has. An Astro image() field (data-astro-image) asks the server for the value
 * to store instead: a path relative to the entry's file that `astro build` can
 * import (`../assets/images/x.jpg`), copying a public upload somewhere
 * importable first. If that fails the field is left as it was and the editor
 * is told, rather than storing a value the build would refuse.
 *
 * @param {HTMLElement} picker - the .image-picker
 * @param {string} url - the library URL of the picked image
 * @param {{filename: string, source?: string}} [image] - the library entry
 * @returns {Promise<boolean>} whether the picker changed
 */
export async function applyPickedImage(picker, url, image = null) {
  if (!picker.hasAttribute('data-astro-image')) {
    updateImagePicker(picker, url);
    return true;
  }
  const entry = currentEntry();
  const filename = image?.filename || decodeURIComponent(String(url).split('/').pop() || '');
  try {
    if (!entry?.collection || !entry?.slug) throw new Error('No entry is open');
    const response = await fetch(`/api/images/${encodeURIComponent(filename)}/entry-value`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: entry.collection, slug: entry.slug, source: image?.source }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || `HTTP ${response.status}`);
    updateImagePicker(picker, result.value, result.previewUrl);
    return true;
  } catch (error) {
    console.error('Could not use the image for this field:', error);
    alert(`Could not use that image here: ${error.message}`);
    return false;
  }
}

/**
 * Wire up every widget inside a container.
 * @param {HTMLElement} container - Form or modal root
 * @param {Function} [onChange] - Called after any widget changes a value
 */
export function setupFieldWidgets(container, onChange) {
  setupImagePickers(container, onChange);
  setupColorPickers(container, onChange);
  setupTextareas(container, onChange);
  setupReferenceFields?.(container, onChange);
  // Markdown body fields get a formatting toolbar. enhanceMarkdownEditor is
  // idempotent, so a re-render or a second widget pass won't stack toolbars.
  container.querySelectorAll('textarea[data-markdown]').forEach(enhanceMarkdownEditor);
}

/**
 * Image picker + gallery buttons
 */
function setupImagePickers(container, onChange) {
  container.addEventListener('click', (e) => {
    // Browse library
    if (e.target.closest('[data-browse]')) {
      const picker = e.target.closest('.image-picker');
      const hiddenInput = picker.querySelector('.image-picker-input');

      const astroImage = picker.hasAttribute('data-astro-image');
      openImageLibrary(async (url, image) => {
        if ((await applyPickedImage(picker, url, image)) && onChange) onChange();
      }, hiddenInput.value, { astroImage });
      return;
    }

    // Upload new
    if (e.target.closest('[data-upload]')) {
      const picker = e.target.closest('.image-picker');

      const astroImage = picker.hasAttribute('data-astro-image');
      uploadNewImage(async (url, image) => {
        if ((await applyPickedImage(picker, url, image)) && onChange) onChange();
      }, { astroImage });
      return;
    }

    // Clear
    if (e.target.closest('[data-clear]')) {
      const picker = e.target.closest('.image-picker');
      updateImagePicker(picker, '');
      if (onChange) onChange();
      return;
    }

    // Gallery edit
    if (e.target.closest('[data-edit-gallery]')) {
      const galleryField = e.target.closest('.gallery-field');
      const currentValue = decodeGalleryValue(galleryField.dataset.galleryValue);

      openGalleryEditor(currentValue, (newImages) => {
        galleryField.dataset.galleryValue = encodeGalleryValue(newImages);
        updateGalleryFieldPreview(galleryField, newImages);
        if (onChange) onChange();
      });
      return;
    }
  });
}

/**
 * Resolve an image path to a URL that can be displayed in the admin.
 * Handles relative paths like ../assets/posts/... by converting to /assets/posts/...
 * @param {string} imagePath - The image path from content
 * @returns {string} - Resolved URL for display
 */
export function resolveImageUrl(imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return '';

  // Already an absolute URL or root-relative path
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('/')) {
    return imagePath;
  }

  // A path relative to the entry (what Astro's image() stores), such as
  // ../assets/x.jpg or ../../assets/images/x.jpg. With an entry open, the
  // server resolves it against that entry's own directory, so the preview is
  // the file the build will import: src/assets/images/x.png and
  // src/content/assets/images/x.png are different files, but both looked like
  // /assets/images/x.png, which serves the content one.
  if (imagePath.startsWith('./') || imagePath.startsWith('../')) {
    const entry = currentEntry();
    if (entry?.collection && entry?.slug) {
      return `/api/images/entry-file?${new URLSearchParams({ collection: entry.collection, slug: entry.slug, path: imagePath })}`;
    }
    // No entry to resolve against: AstroAdmin serves src/content/assets and
    // src/assets at /assets, so whatever follows the leading ./ and ../
    // segments (and a src/, content/ or src/content/ prefix, for an entry
    // outside src/content) is looked up there.
    const rest = imagePath.replace(/^(?:\.\.?\/)+/, '').replace(/^(?:src\/)?(?:content\/)?(?=assets\/)/, '');
    if (rest.startsWith('assets/')) {
      return '/' + rest;
    }
  }

  // A bare filename is a library image
  if (!imagePath.includes('/')) {
    return `/images/${imagePath}`;
  }

  // Return as-is for unrecognized patterns
  return imagePath;
}

/**
 * Whether a stored value should show a thumbnail rather than the "No image
 * selected" state. Anything non-empty is a real image EXCEPT a `placeholder:`
 * marker (which a site renders as an outline) — resolveImageUrl already turns a
 * bare filename, a relative path or a URL into something displayable, so gating
 * on path *shape* would wrongly hide a valid bare-filename library image. The
 * single source of truth for both first render and post-pick updates.
 */
export function isPreviewableImage(value) {
  const trimmed = (value || '').trim();
  // Case-insensitive: `PLACEHOLDER:banner` must not resolve to a broken <img>.
  return trimmed !== '' && !/^placeholder:/i.test(trimmed);
}

// A widget's clear button marks the control it empties. A control with no
// recorded baseline (one in a new entry, see form-generator's
// nullableControlValue) has nothing else to tell "cleared" from "never set":
// a hidden input's defaultValue follows its value, and a value chosen then
// cleared is back where it started. A nullable control so marked saves null.
export const CLEARED_ATTRIBUTE = 'data-cleared';

/**
 * Set a widget-held control's value (an image picker's hidden input, a
 * reference's, a colour's text box), recording a clear: '' marks it cleared,
 * anything else unmarks it.
 * @param {HTMLInputElement} input
 * @param {string} value
 */
export function setWidgetValue(input, value) {
  input.value = value;
  input.toggleAttribute(CLEARED_ATTRIBUTE, value === '');
}

/**
 * Update an image picker's hidden input and preview.
 * The stored value stays exactly as chosen; only the preview src is resolved —
 * the same rule generateImageField uses on first render, so a relative path
 * previews identically whether it was loaded or just picked. A previewUrl the
 * server gave for this exact file (applyPickedImage) wins over that guess.
 */
export function updateImagePicker(picker, url, previewUrl = '') {
  const hiddenInput = picker.querySelector('.image-picker-input');
  const altInput = picker.querySelector('[data-alt-input]');
  const preview = picker.querySelector('[data-preview]');
  const previewImg = picker.querySelector('[data-preview-img]');
  const placeholder = picker.querySelector('[data-placeholder]');

  setWidgetValue(hiddenInput, url);

  if (isPreviewableImage(url)) {
    previewImg.src = previewUrl || resolveImageUrl(url);
    preview.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    preview.classList.add('hidden');
    placeholder.classList.remove('hidden');
    // Alt text describes an image that is no longer there
    if (altInput) altInput.value = '';
  }
}

/**
 * Gallery values ride in a data attribute, so they're base64'd to survive
 * quotes in alt text.
 */
export function encodeGalleryValue(images) {
  return btoa(encodeURIComponent(JSON.stringify(images)));
}

export function decodeGalleryValue(encoded) {
  if (!encoded) return [];
  try {
    return JSON.parse(decodeURIComponent(atob(encoded)));
  } catch (e) {
    console.error('Failed to decode gallery value:', e);
    return [];
  }
}

function updateGalleryFieldPreview(galleryField, images) {
  const preview = galleryField.querySelector('.gallery-field-preview');
  const editBtn = galleryField.querySelector('.gallery-field-edit');
  const previewImages = images.slice(0, 6);
  const moreCount = images.length - 6;

  preview.innerHTML = previewImages.length > 0
    ? previewImages.map(img => `
        <div class="gallery-field-thumb">
          <img src="${escapeHtml(img.src || '')}" alt="">
        </div>
      `).join('') + (moreCount > 0 ? `<div class="gallery-field-more">+${moreCount}</div>` : '')
    : '<span class="gallery-field-empty">No images</span>';

  editBtn.textContent = images.length > 0 ? `Edit ${images.length} images` : 'Add images';
}

/**
 * Colour picker: swatch and text input mirror each other.
 * Both live in the same .color-picker-wrapper, so we never need an id lookup.
 */
function setupColorPickers(container, onChange) {
  container.addEventListener('input', (e) => {
    const wrapper = e.target.closest('.color-picker-wrapper');
    if (!wrapper) return;

    if (e.target.matches('.color-picker-input')) {
      const textInput = wrapper.querySelector('.color-picker-text');
      if (textInput) {
        textInput.value = e.target.value;
        if (onChange) onChange();
      }
      return;
    }

    if (e.target.matches('.color-picker-text')) {
      const swatch = wrapper.querySelector('.color-picker-input');
      if (swatch && /^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
        swatch.value = e.target.value;
      }
    }
  });

  container.addEventListener('click', (e) => {
    const clearBtn = e.target.closest('[data-clear-color]');
    if (!clearBtn) return;

    const wrapper = clearBtn.closest('.color-picker-wrapper');
    const textInput = wrapper?.querySelector('.color-picker-text');
    const swatch = wrapper?.querySelector('.color-picker-input');

    if (textInput) setWidgetValue(textInput, '');
    if (swatch) swatch.value = '#ffffff';

    clearBtn.remove();
    if (onChange) onChange();
  });
}

/**
 * Textareas: grow with content, and expand into a fullscreen editor
 */
function setupTextareas(container, onChange) {
  container.addEventListener('input', (e) => {
    if (e.target.classList.contains('textarea-autogrow')) {
      autoGrowTextarea(e.target);
    }
  });

  container.addEventListener('click', (e) => {
    const expandBtn = e.target.closest('[data-expand-textarea]');
    if (!expandBtn) return;

    // The textarea is the button's own sibling inside .textarea-wrapper. Resolving
    // it by position rather than by id is what stops a modal's expand button from
    // reaching a same-named textarea on the form behind it.
    const textarea = expandBtn.closest('.textarea-wrapper')?.querySelector('textarea');
    if (textarea) openTextareaModal(textarea, onChange);
  });
}

export function autoGrowTextarea(textarea) {
  textarea.style.height = 'auto';
  const minHeight = 100; // ~4 rows
  const maxHeight = 400; // ~16 rows
  textarea.style.height = Math.min(maxHeight, Math.max(minHeight, textarea.scrollHeight)) + 'px';
}

/**
 * Fullscreen textarea editor, with a markdown toolbar for prose fields
 */
function openTextareaModal(textarea, onChange) {
  const formGroup = textarea.closest('.form-group');
  const label = formGroup?.querySelector('.form-label')?.textContent?.replace('*', '').trim() || 'Edit Text';
  const isMarkdown = textarea.dataset.markdown === 'true' ||
                     label.toLowerCase().includes('markdown') ||
                     label.toLowerCase().includes('content');

  // The toolbar is injected by enhanceMarkdownEditor after mount, so the
  // fullscreen editor and the inline body editor share one toolbar (same
  // controls, same image-library picker).
  let modal = document.getElementById('textareaModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'textareaModal';
    document.body.appendChild(modal);
  }

  modal.className = 'textarea-modal-overlay';
  modal.innerHTML = `
    <div class="textarea-modal ${isMarkdown ? 'textarea-modal-markdown' : ''}">
      <div class="textarea-modal-header">
        <h3>${escapeHtml(label)}</h3>
        <button type="button" class="textarea-modal-close" data-close-textarea-modal>&times;</button>
      </div>
      <div class="textarea-modal-body">
        <textarea id="textareaModalInput" class="textarea-modal-input ${isMarkdown ? 'markdown-input' : ''}" placeholder="Enter your text...">${escapeHtml(textarea.value)}</textarea>
      </div>
      <div class="textarea-modal-footer">
        <span class="textarea-char-count">${textarea.value.length} characters</span>
        <div class="textarea-modal-actions">
          <button type="button" class="btn btn-sm btn-secondary" data-close-textarea-modal>Cancel</button>
          <button type="button" class="btn btn-sm btn-primary" data-save-textarea-modal>Done</button>
        </div>
      </div>
    </div>
  `;

  const modalInput = modal.querySelector('#textareaModalInput');
  const charCount = modal.querySelector('.textarea-char-count');

  modalInput.addEventListener('input', () => {
    charCount.textContent = `${modalInput.value.length} characters`;
  });

  const closeModal = () => modal.remove();

  const saveAndClose = () => {
    textarea.value = modalInput.value;
    // Let the host form's auto-save see the change
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    autoGrowTextarea(textarea);
    closeModal();
    if (onChange) onChange();
  };

  modal.querySelectorAll('[data-close-textarea-modal]').forEach(btn => {
    btn.addEventListener('click', closeModal);
  });
  modal.querySelector('[data-save-textarea-modal]').addEventListener('click', saveAndClose);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  modalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeModal();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      saveAndClose();
      return;
    }
    // Formatting shortcuts (Cmd/Ctrl+B/I/K) are handled by enhanceMarkdownEditor.
  });

  // Prose fields get the shared markdown toolbar (same controls + image-library
  // picker as the inline body editor).
  if (isMarkdown) enhanceMarkdownEditor(modalInput);

  setTimeout(() => {
    modalInput.focus();
    modalInput.setSelectionRange(modalInput.value.length, modalInput.value.length);
  }, 100);
}


