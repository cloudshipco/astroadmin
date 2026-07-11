/**
 * Array Item Editor Component
 * Modal for editing complex arrays with drag-to-reorder
 *
 * The fields inside an item are rendered, wired, and read back by form-generator
 * — the same code the main editor form uses. This modal owns the list (add,
 * remove, reorder) and nothing about how an individual field looks or behaves.
 */

import { escapeHtml } from './escape-html.js';

import {
  generateFields,
  setupFieldHandlers,
  extractFields,
  getItemPreview,
  createEmptyArrayItem,
} from './form-generator.js';

// Fields inside the modal get their ids prefixed so they can't collide with the
// same-named fields on the form behind it — two elements sharing an id would send
// a <label for> to whichever came first, which is never the one you clicked.
const ITEM_ID_PREFIX = 'item_';

// Item editors occupy the z-index band 60-69 (see the modal stacking scale in
// input.css). Nesting deeper than this is not a real content shape, and letting the
// band grow without limit would put an item editor above the pickers it opens.
const MAX_STACK_DEPTH = 9;

let currentCallback = null;
let currentItems = [];
let currentSchema = null;
let draggedItem = null;
let draggedIndex = null;
let dropPosition = null;

/**
 * Open the array editor modal
 * @param {string} fieldName - Display name for the array
 * @param {Array} items - Current array items
 * @param {Object} schema - Schema for array items
 * @param {Function} onSave - Callback when saved
 */
export function openArrayEditor(fieldName, items, schema, onSave) {
  currentCallback = onSave;
  currentItems = JSON.parse(JSON.stringify(items || []));
  currentSchema = schema;

  let modal = document.getElementById('arrayEditorModal');
  if (!modal) {
    modal = createModal();
    document.body.appendChild(modal);
    setupModalEvents(modal);
  }

  // Update title
  modal.querySelector('[data-title]').textContent = `Edit ${fieldName}`;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  renderItems();
}

/**
 * Close the array editor modal
 */
export function closeArrayEditor() {
  const modal = document.getElementById('arrayEditorModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
  currentCallback = null;
  currentItems = [];
  currentSchema = null;
}

/**
 * Create the modal HTML structure
 */
function createModal() {
  const modal = document.createElement('div');
  modal.id = 'arrayEditorModal';
  modal.className = 'array-editor-overlay hidden';
  modal.innerHTML = `
    <div class="array-editor-modal">
      <div class="array-editor-header">
        <h2 class="array-editor-title" data-title>Edit Items</h2>
        <button type="button" class="array-editor-close" data-close>&times;</button>
      </div>
      <div class="array-editor-body">
        <div class="array-editor-list" data-list></div>
        <div class="array-editor-empty hidden" data-empty>
          <p>No items yet. Add one below.</p>
        </div>
      </div>
      <div class="array-editor-footer">
        <button type="button" class="btn btn-secondary" data-add>+ Add Item</button>
        <div class="array-editor-actions">
          <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
          <button type="button" class="btn btn-primary" data-save>Save Changes</button>
        </div>
      </div>
    </div>
  `;
  return modal;
}

/**
 * Setup modal event listeners
 */
function setupModalEvents(modal) {
  modal.querySelector('[data-close]').addEventListener('click', closeArrayEditor);
  modal.querySelector('[data-cancel]').addEventListener('click', closeArrayEditor);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeArrayEditor();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      // Don't close the list out from under an item editor stacked on top of it
      if (!document.querySelector('.array-item-edit-overlay')) {
        closeArrayEditor();
      }
    }
  });

  modal.querySelector('[data-add]').addEventListener('click', () => {
    currentItems.push(createEmptyArrayItem(currentSchema));
    renderItems();
    // Open editor for new item
    openItemEditor(currentItems.length - 1);
  });

  modal.querySelector('[data-save]').addEventListener('click', () => {
    if (currentCallback) {
      currentCallback(currentItems);
      closeArrayEditor();
    }
  });

  const list = modal.querySelector('[data-list]');

  list.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      openItemEditor(parseInt(editBtn.dataset.edit, 10));
      return;
    }

    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      currentItems.splice(parseInt(removeBtn.dataset.remove, 10), 1);
      renderItems();
    }
  });

  // Drag and drop
  list.addEventListener('dragstart', handleDragStart);
  list.addEventListener('dragend', handleDragEnd);
  list.addEventListener('dragover', handleDragOver);
  list.addEventListener('drop', handleDrop);
}

/**
 * Render items in the list
 */
function renderItems() {
  const modal = document.getElementById('arrayEditorModal');
  const list = modal.querySelector('[data-list]');
  const empty = modal.querySelector('[data-empty]');

  if (currentItems.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  list.innerHTML = currentItems.map((item, index) => {
    const preview = getItemPreview(item, currentSchema, 80);

    return `
      <div class="array-editor-item" draggable="true" data-index="${index}">
        <div class="array-editor-item-handle" title="Drag to reorder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/>
            <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
            <circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>
          </svg>
        </div>
        <div class="array-editor-item-content" data-edit="${index}">
          <div class="array-editor-item-title">${escapeHtml(preview.title) || '<span class="text-gray-400">Untitled</span>'}</div>
          ${preview.subtitle ? `<div class="array-editor-item-subtitle">${escapeHtml(preview.subtitle)}</div>` : ''}
        </div>
        <button type="button" class="array-editor-item-edit" data-edit="${index}" title="Edit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button type="button" class="array-editor-item-remove" data-remove="${index}" title="Remove">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;
  }).join('');
}

/**
 * Open the editor for one item of the array currently being edited
 */
function openItemEditor(index) {
  const item = currentItems[index];
  if (!item) return;

  openSingleItemEditor(item, currentSchema, (updatedItem) => {
    currentItems[index] = updatedItem;
    renderItems();
  });
}

/**
 * Open an editor for a single item, with or without the array list behind it.
 * @param {Object} item - The item to edit
 * @param {Object} schema - Schema for the item
 * @param {Function} onSave - Called with the updated item
 */
export function openSingleItemEditor(item, schema, onSave) {
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
  // array list (50) and below the gallery/textarea (70) and image library (80).
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

  const closeEditModal = () => editModal.remove();

  const saveAndClose = () => {
    // Spread over the original so a property the schema doesn't render survives
    if (onSave) onSave({ ...item, ...extractFields(form) });
    closeEditModal();
  };

  editModal.querySelectorAll('[data-close], [data-cancel]').forEach(btn => {
    btn.addEventListener('click', closeEditModal);
  });
  editModal.querySelector('[data-save]').addEventListener('click', saveAndClose);
  editModal.addEventListener('click', (e) => {
    if (e.target === editModal) closeEditModal();
  });

  // Handle keyboard
  editModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditModal();
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

/**
 * Drag handlers
 */
function handleDragStart(e) {
  const item = e.target.closest('.array-editor-item');
  if (!item) return;

  draggedItem = item;
  draggedIndex = parseInt(item.dataset.index, 10);
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  const item = e.target.closest('.array-editor-item');
  if (item) item.classList.remove('dragging');

  draggedItem = null;
  draggedIndex = null;
  dropPosition = null;

  document.querySelectorAll('.array-editor-item').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const item = e.target.closest('.array-editor-item');
  if (!item || item === draggedItem) return;

  const rect = item.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const position = e.clientY < midY ? 'before' : 'after';
  const itemIndex = parseInt(item.dataset.index, 10);

  document.querySelectorAll('.array-editor-item').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });

  item.classList.add(position === 'before' ? 'drop-before' : 'drop-after');
  dropPosition = { index: itemIndex, position };
}

function handleDrop(e) {
  e.preventDefault();

  if (!draggedItem || !dropPosition) return;

  const fromIndex = draggedIndex;
  let toIndex = dropPosition.index;

  if (dropPosition.position === 'after') toIndex += 1;
  if (fromIndex < toIndex) toIndex -= 1;

  if (fromIndex !== toIndex) {
    const [moved] = currentItems.splice(fromIndex, 1);
    currentItems.splice(toIndex, 0, moved);
    renderItems();
  }

  document.querySelectorAll('.array-editor-item').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
  dropPosition = null;
}

