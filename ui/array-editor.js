/**
 * Array Item Editor
 * Modal for editing one item of an array of objects (an array card, an inline
 * array item, a block's nested item).
 *
 * The fields inside an item are rendered, wired, and read back by form-generator
 * — the same code the main editor form uses. This modal owns nothing about how
 * an individual field looks or behaves.
 */

import { pushModal, removeModal } from './modal-stack.js';

import {
  generateFields,
  setupFieldHandlers,
  extractItem,
  bindOriginalValues,
} from './form-generator.js';

// Fields inside the modal get their ids prefixed so they can't collide with the
// same-named fields on the form behind it — two elements sharing an id would send
// a <label for> to whichever came first, which is never the one you clicked.
const ITEM_ID_PREFIX = 'item_';

// Item editors occupy the z-index band 60-69 (see the modal stacking scale in
// input.css). Nesting deeper than this is not a real content shape, and letting the
// band grow without limit would put an item editor above the pickers it opens.
const MAX_STACK_DEPTH = 9;

/**
 * Open an editor for a single item.
 * @param {Object} item - The item to edit
 * @param {Object} schema - Schema for the item
 * @param {Function} onSave - Called with the updated item
 * @param {object} [options]
 * @param {boolean} [options.isNew] - The item is new (the schema's empty
 *   placeholders, not stored values), so it is not bound: its fields are read
 *   from the DOM and its empty optionals cleaned away, as a new entry's are.
 */
export function openSingleItemEditor(item, schema, onSave, { isNew = false } = {}) {
  // A fresh overlay per call, never a shared one. An item can itself contain an
  // array of objects, and editing one of those opens a second item editor on top of
  // this one — reusing a single element would overwrite the parent mid-edit and
  // throw its unsaved changes away.
  // Clamped: the item-editor band is 60-69, and beyond that a deeper editor would
  // climb over the gallery (70) and image library (80) that it can itself open.
  // Past depth 9 the modals share a z-index and DOM order keeps the newest on top.
  const depth = Math.min(document.querySelectorAll('.array-item-edit-overlay').length, MAX_STACK_DEPTH);
  const editModal = document.createElement('div');
  document.body.appendChild(editModal);

  const fields = generateFields(schema?.properties, item, {
    // Each nesting level needs its own id namespace, or the inner modal's labels
    // point at the outer modal's inputs.
    idPrefix: `${ITEM_ID_PREFIX}${depth}_`,
    // The modal is narrow and its body scrolls, so a full-height image preview would
    // push the picker's own buttons — and every field under it — below the fold.
    pickerVariant: 'compact',
  });

  editModal.className = 'array-item-edit-overlay';
  // The CSS turns this into z-index 60 + depth, keeping every item editor above the
  // primary modals (50) and below the gallery/textarea (70) and image library (80).
  editModal.style.setProperty('--stack-depth', String(depth));
  editModal.innerHTML = `
    <div class="array-item-edit-modal">
      <div class="array-item-edit-header">
        <h3>Edit Item</h3>
        <button type="button" class="array-item-edit-close" data-close>&times;</button>
      </div>
      <div class="array-item-edit-body">
        <form class="array-item-edit-form">
          ${fields}
        </form>
      </div>
      <div class="array-item-edit-footer">
        <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" data-save>Done</button>
      </div>
    </div>
  `;

  // A class, not an id: item editors stack, and duplicate ids in one document would
  // make every id-based lookup ambiguous.
  const form = editModal.querySelector('.array-item-edit-form');

  // An item's fields get exactly what the main form's fields get: image pickers,
  // galleries, colour pickers, expanding textareas, nested arrays.
  setupFieldHandlers(form);
  // The item it was opened with is what an untouched field saves: Done after
  // editing one field must leave every other value of the item as it was.
  if (!isNew) bindOriginalValues(form, item);

  const closeEditModal = () => {
    removeModal(editModal);
    editModal.remove();
  };
  // Escape closes this editor only while it is the topmost modal: not when a
  // picker or a nested item editor it opened is on top of it.
  pushModal(editModal, closeEditModal);

  const saveAndClose = () => {
    // Final, by the main form's rule: untouched fields as stored, emptied
    // optionals dropped, unrendered properties kept (extractItem).
    if (onSave) onSave(extractItem(form, item, schema));
    closeEditModal();
  };

  editModal.querySelectorAll('[data-close], [data-cancel]').forEach(btn => {
    btn.addEventListener('click', closeEditModal);
  });
  editModal.querySelector('[data-save]').addEventListener('click', saveAndClose);
  editModal.addEventListener('click', (e) => {
    if (e.target === editModal) closeEditModal();
  });

  // Handle keyboard (Escape is the modal stack's)
  editModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveAndClose();
    }
  });

  // Focus first input
  setTimeout(() => {
    const firstInput = editModal.querySelector('input:not([type="hidden"]), textarea, select');
    if (firstInput) firstInput.focus();
  }, 100);
}
