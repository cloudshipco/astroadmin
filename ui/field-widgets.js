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
 * Wire up every widget inside a container.
 * @param {HTMLElement} container - Form or modal root
 * @param {Function} [onChange] - Called after any widget changes a value
 */
export function setupFieldWidgets(container, onChange) {
  setupImagePickers(container, onChange);
  setupColorPickers(container, onChange);
  setupTextareas(container, onChange);
  setupReferenceFields?.(container, onChange);
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

      openImageLibrary((url) => {
        updateImagePicker(picker, url);
        if (onChange) onChange();
      }, hiddenInput.value);
      return;
    }

    // Upload new
    if (e.target.closest('[data-upload]')) {
      const picker = e.target.closest('.image-picker');

      uploadNewImage((url) => {
        updateImagePicker(picker, url);
        if (onChange) onChange();
      });
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

  // Relative paths like ../assets/posts/... or ./assets/... — AstroAdmin serves these from /assets/
  if (imagePath.startsWith('../assets/') || imagePath.startsWith('./assets/')) {
    const assetsIndex = imagePath.indexOf('assets/');
    if (assetsIndex !== -1) {
      return '/' + imagePath.slice(assetsIndex);
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
 * Update an image picker's hidden input and preview.
 * The stored value stays exactly as chosen; only the preview src is resolved —
 * the same rule generateImageField uses on first render, so a relative path
 * previews identically whether it was loaded or just picked.
 */
export function updateImagePicker(picker, url) {
  const hiddenInput = picker.querySelector('.image-picker-input');
  const altInput = picker.querySelector('[data-alt-input]');
  const preview = picker.querySelector('[data-preview]');
  const previewImg = picker.querySelector('[data-preview-img]');
  const placeholder = picker.querySelector('[data-placeholder]');

  hiddenInput.value = url;

  if (url && url.trim()) {
    previewImg.src = resolveImageUrl(url);
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

    if (textInput) textInput.value = '';
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

  const markdownToolbar = isMarkdown ? `
    <div class="markdown-toolbar">
      <button type="button" class="markdown-btn" data-md="bold" title="Bold (Ctrl+B)"><strong>B</strong></button>
      <button type="button" class="markdown-btn" data-md="italic" title="Italic (Ctrl+I)"><em>I</em></button>
      <button type="button" class="markdown-btn" data-md="code" title="Inline Code">&lt;/&gt;</button>
      <span class="markdown-separator"></span>
      <button type="button" class="markdown-btn" data-md="h2" title="Heading 2">H2</button>
      <button type="button" class="markdown-btn" data-md="h3" title="Heading 3">H3</button>
      <span class="markdown-separator"></span>
      <button type="button" class="markdown-btn" data-md="ul" title="Bullet List">• List</button>
      <button type="button" class="markdown-btn" data-md="ol" title="Numbered List">1. List</button>
      <button type="button" class="markdown-btn" data-md="quote" title="Blockquote">" Quote</button>
      <span class="markdown-separator"></span>
      <button type="button" class="markdown-btn" data-md="link" title="Link">[Link]</button>
      <button type="button" class="markdown-btn" data-md="image" title="Image">🖼️</button>
      <button type="button" class="markdown-btn" data-md="codeblock" title="Code Block">{ }</button>
    </div>
  ` : '';

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
      ${markdownToolbar}
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
    if (isMarkdown && (e.metaKey || e.ctrlKey)) {
      if (e.key === 'b') {
        e.preventDefault();
        insertMarkdown(modalInput, 'bold');
      } else if (e.key === 'i') {
        e.preventDefault();
        insertMarkdown(modalInput, 'italic');
      } else if (e.key === 'k') {
        e.preventDefault();
        insertMarkdown(modalInput, 'link');
      }
    }
  });

  if (isMarkdown) {
    modal.querySelectorAll('[data-md]').forEach(btn => {
      btn.addEventListener('click', () => {
        insertMarkdown(modalInput, btn.dataset.md);
        modalInput.focus();
      });
    });
  }

  setTimeout(() => {
    modalInput.focus();
    modalInput.setSelectionRange(modalInput.value.length, modalInput.value.length);
  }, 100);
}

/**
 * Insert markdown formatting at the cursor
 */
function insertMarkdown(textarea, action) {
  const text = textarea.value;
  const start = textarea.selectionStart;

  let before = '';
  let after = '';
  let placeholder = '';
  let cursorOffset = 0;

  switch (action) {
    case 'bold':
      before = '**'; after = '**'; placeholder = 'bold text'; cursorOffset = 2;
      break;
    case 'italic':
      before = '_'; after = '_'; placeholder = 'italic text'; cursorOffset = 1;
      break;
    case 'code':
      before = '`'; after = '`'; placeholder = 'code'; cursorOffset = 1;
      break;
    case 'h2': {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      textarea.setSelectionRange(lineStart, lineStart);
      before = '## '; cursorOffset = 3;
      break;
    }
    case 'h3': {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      textarea.setSelectionRange(lineStart, lineStart);
      before = '### '; cursorOffset = 4;
      break;
    }
    case 'ul':
      before = '- '; placeholder = 'list item'; cursorOffset = 2;
      break;
    case 'ol':
      before = '1. '; placeholder = 'list item'; cursorOffset = 3;
      break;
    case 'quote':
      before = '> '; placeholder = 'quote'; cursorOffset = 2;
      break;
    case 'link':
      before = '['; after = '](url)'; placeholder = 'link text'; cursorOffset = 1;
      break;
    case 'image':
      before = '!['; after = '](image-url)'; placeholder = 'alt text'; cursorOffset = 2;
      break;
    case 'codeblock':
      before = '\n```\n'; after = '\n```\n'; placeholder = 'code'; cursorOffset = 5;
      break;
  }

  const actualStart = textarea.selectionStart;
  const actualEnd = textarea.selectionEnd;
  const selected = textarea.value.substring(actualStart, actualEnd);
  const insert = selected || placeholder;

  textarea.value =
    textarea.value.substring(0, actualStart) + before + insert + after + textarea.value.substring(actualEnd);

  if (selected) {
    textarea.setSelectionRange(actualStart + before.length, actualStart + before.length + insert.length);
  } else {
    textarea.setSelectionRange(actualStart + cursorOffset, actualStart + cursorOffset + placeholder.length);
  }

  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

