/**
 * Array Item Editor Component
 * Modal for editing complex arrays with drag-to-reorder
 */

let currentCallback = null;
let currentItems = [];
let currentSchema = null;
let currentFieldName = '';
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
  currentFieldName = fieldName;

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
      // Don't close if item editor is open
      if (!document.getElementById('arrayItemEditModal')) {
        closeArrayEditor();
      }
    }
  });

  modal.querySelector('[data-add]').addEventListener('click', () => {
    const newItem = createEmptyItem(currentSchema);
    currentItems.push(newItem);
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
      const index = parseInt(editBtn.dataset.edit, 10);
      openItemEditor(index);
      return;
    }

    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      const index = parseInt(removeBtn.dataset.remove, 10);
      currentItems.splice(index, 1);
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
    const preview = getItemPreview(item);

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
 * Parse labelField hint from schema description
 * Format: "labelField:fieldName" anywhere in the description
 */
function parseLabelFieldHint(schema) {
  if (!schema?.description) return null;
  const match = schema.description.match(/labelField:(\w+)/);
  return match ? match[1] : null;
}

/**
 * Get preview text for an item
 * Uses currentSchema module variable for intelligent field detection
 */
function getItemPreview(item) {
  const titleFields = ['title', 'name', 'heading', 'label', 'quote', 'author', 'summary', 'message', 'caption'];
  const subtitleFields = ['description', 'content', 'subtitle', 'text', 'author', 'source', 'quote'];

  let title = '';
  let subtitle = '';
  let titleField = '';

  // Check for explicit labelField hint in schema description
  const labelFieldHint = parseLabelFieldHint(currentSchema);
  if (labelFieldHint && item[labelFieldHint]) {
    title = String(item[labelFieldHint]);
    titleField = labelFieldHint;
  }

  // Try standard title fields if no hint or hint field was empty
  if (!title) {
    for (const field of titleFields) {
      if (item[field]) {
        title = String(item[field]);
        titleField = field;
        break;
      }
    }
  }

  // Fallback: use first string value from the item data
  if (!title) {
    for (const [field, value] of Object.entries(item)) {
      if (typeof value === 'string' && value.trim()) {
        title = value;
        titleField = field;
        break;
      }
    }
  }

  for (const field of subtitleFields) {
    // Don't use the same field for both title and subtitle
    if (field === titleField) continue;
    if (item[field]) {
      const text = String(item[field]);
      subtitle = text.length > 80 ? text.substring(0, 80) + '...' : text;
      break;
    }
  }

  return { title, subtitle };
}

/**
 * Create an empty item based on schema
 */
function createEmptyItem(schema) {
  if (!schema || schema.type !== 'object') return {};

  const item = {};
  const props = schema.properties || {};

  for (const [key, propSchema] of Object.entries(props)) {
    if (propSchema.default !== undefined) {
      item[key] = propSchema.default;
    } else if (propSchema.type === 'string') {
      item[key] = '';
    } else if (propSchema.type === 'number') {
      item[key] = 0;
    } else if (propSchema.type === 'boolean') {
      item[key] = false;
    } else if (propSchema.type === 'array') {
      item[key] = [];
    } else if (propSchema.type === 'object') {
      item[key] = {};
    }
  }

  return item;
}

/**
 * Open the item editor modal
 */
function openItemEditor(index) {
  const item = currentItems[index];
  if (!item) return;

  let editModal = document.getElementById('arrayItemEditModal');
  if (!editModal) {
    editModal = document.createElement('div');
    editModal.id = 'arrayItemEditModal';
    document.body.appendChild(editModal);
  }

  const fields = generateItemFields(item, currentSchema);

  editModal.className = 'array-item-edit-overlay';
  editModal.innerHTML = `
    <div class="array-item-edit-modal">
      <div class="array-item-edit-header">
        <h3>Edit Item</h3>
        <button type="button" class="array-item-edit-close" data-close>&times;</button>
      </div>
      <div class="array-item-edit-body">
        <form id="arrayItemEditForm">
          ${fields}
        </form>
      </div>
      <div class="array-item-edit-footer">
        <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" data-save>Done</button>
      </div>
    </div>
  `;

  const closeEditModal = () => {
    editModal.remove();
  };

  const saveAndClose = () => {
    const form = editModal.querySelector('#arrayItemEditForm');
    const formData = new FormData(form);
    const updatedItem = { ...item };

    for (const [key, value] of formData.entries()) {
      updatedItem[key] = value;
    }

    // Handle checkboxes (unchecked ones don't appear in FormData)
    form.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      updatedItem[cb.name] = cb.checked;
    });

    currentItems[index] = updatedItem;
    renderItems();
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
    const firstInput = editModal.querySelector('input, textarea, select');
    if (firstInput) firstInput.focus();
  }, 100);
}

/**
 * Generate form fields for item editing
 */
function generateItemFields(item, schema) {
  if (!schema || schema.type !== 'object') return '';

  const props = schema.properties || {};

  return Object.entries(props).map(([key, propSchema]) => {
    const value = item[key] ?? '';
    const label = formatLabel(key);
    const id = `edit_${key}`;

    if (propSchema.type === 'boolean') {
      return `
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" name="${key}" id="${id}" ${value ? 'checked' : ''}>
            <span>${label}</span>
          </label>
        </div>
      `;
    }

    if (propSchema.enum) {
      return `
        <div class="form-group">
          <label for="${id}" class="form-label">${label}</label>
          <select name="${key}" id="${id}" class="form-input">
            ${propSchema.enum.map(opt => `<option value="${opt}" ${value === opt ? 'selected' : ''}>${opt}</option>`).join('')}
          </select>
        </div>
      `;
    }

    // Check if it's a long text field
    const isLongText = key.includes('description') || key.includes('content') ||
                       (typeof value === 'string' && value.length > 100);

    if (isLongText) {
      return `
        <div class="form-group">
          <label for="${id}" class="form-label">${label}</label>
          <textarea name="${key}" id="${id}" class="form-input" rows="4">${escapeHtml(value)}</textarea>
        </div>
      `;
    }

    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${label}</label>
        <input type="text" name="${key}" id="${id}" class="form-input" value="${escapeHtml(value)}">
      </div>
    `;
  }).join('');
}

/**
 * Format field name as label
 */
function formatLabel(name) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\w/, c => c.toUpperCase())
    .trim();
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

/**
 * Escape HTML
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Open a single item editor directly (without the array list modal)
 * @param {Object} item - The item to edit
 * @param {Object} schema - Schema for the item
 * @param {Function} onSave - Callback when saved with updated item
 */
export function openSingleItemEditor(item, schema, onSave) {
  let editModal = document.getElementById('arrayItemEditModal');
  if (!editModal) {
    editModal = document.createElement('div');
    editModal.id = 'arrayItemEditModal';
    document.body.appendChild(editModal);
  }

  const fields = generateItemFields(item, schema);

  editModal.className = 'array-item-edit-overlay';
  editModal.innerHTML = `
    <div class="array-item-edit-modal">
      <div class="array-item-edit-header">
        <h3>Edit Item</h3>
        <button type="button" class="array-item-edit-close" data-close>&times;</button>
      </div>
      <div class="array-item-edit-body">
        <form id="arrayItemEditForm">
          ${fields}
        </form>
      </div>
      <div class="array-item-edit-footer">
        <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" data-save>Done</button>
      </div>
    </div>
  `;

  const closeEditModal = () => {
    editModal.remove();
  };

  const saveAndClose = () => {
    const form = editModal.querySelector('#arrayItemEditForm');
    const formData = new FormData(form);
    const updatedItem = { ...item };

    for (const [key, value] of formData.entries()) {
      updatedItem[key] = value;
    }

    // Handle checkboxes (unchecked ones don't appear in FormData)
    form.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      updatedItem[cb.name] = cb.checked;
    });

    if (onSave) onSave(updatedItem);
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
    const firstInput = editModal.querySelector('input, textarea, select');
    if (firstInput) firstInput.focus();
  }, 100);
}
