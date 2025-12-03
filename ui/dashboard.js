/**
 * Dashboard functionality - Shopify-style layout
 */

import { generateForm, extractFormData, setupFormHandlers } from './form-generator.js';
import { openImageLibrary, uploadNewImage } from './image-library.js';
import { openReferencePicker } from './reference-picker.js';
import { toggleChangesPanel, getChangesCount } from './changes-panel.js';

let currentCollection = null;
let currentSlug = null;
let currentData = null;
let previewUrl = '';
let allPages = []; // Store all pages for dropdown
let allCollections = []; // Store collection info for new entries
let isNewEntry = false; // Track if current entry is new (unsaved)

// Check authentication
async function checkAuth() {
  try {
    const response = await fetch('/api/session');
    const data = await response.json();

    if (!data.authenticated) {
      window.location.href = '/login';
    }
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = '/login';
  }
}

// Load config
async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    const data = await response.json();
    previewUrl = data.previewUrl;
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

// Load all pages for dropdown
async function loadPages() {
  try {
    const response = await fetch('/api/collections');
    const data = await response.json();

    if (data.success) {
      allCollections = data.collections; // Store for new entry creation
      populatePageSelector(data.collections);
    }
  } catch (error) {
    console.error('Failed to load collections:', error);
  }
}

// Populate page selector dropdown
function populatePageSelector(collections) {
  const selector = document.getElementById('pageSelector');
  const previousValue = selector.value; // Preserve selection if reloading
  selector.innerHTML = '<option value="">Select page...</option>';
  allPages = []; // Reset

  // Sort collections: pages first, then testimonials, then metadata last
  const collectionOrder = ['pages', 'testimonials', 'metadata'];
  const sortedCollections = [...collections].sort((a, b) => {
    const aIndex = collectionOrder.indexOf(a.name);
    const bIndex = collectionOrder.indexOf(b.name);
    // If not in order list, put at end
    const aOrder = aIndex === -1 ? 999 : aIndex;
    const bOrder = bIndex === -1 ? 999 : bIndex;
    return aOrder - bOrder;
  });

  sortedCollections.forEach(collection => {
    // Create optgroup for each collection
    const optgroup = document.createElement('optgroup');
    const collectionLabel = collection.name.charAt(0).toUpperCase() + collection.name.slice(1);
    optgroup.label = collectionLabel;

    // Add "+ New" option at top of each collection
    const newOption = document.createElement('option');
    newOption.value = `new:${collection.name}`;
    newOption.textContent = `+ New ${singularize(collectionLabel)}...`;
    newOption.className = 'new-item-option';
    optgroup.appendChild(newOption);

    collection.entries.forEach(slug => {
      const option = document.createElement('option');
      option.value = `${collection.name}/${slug}`;
      option.textContent = slug;
      optgroup.appendChild(option);

      // Store for reference
      allPages.push({ collection: collection.name, slug });
    });

    selector.appendChild(optgroup);
  });

  // Restore previous selection if it still exists
  if (previousValue && !previousValue.startsWith('new:')) {
    selector.value = previousValue;
  }
}

// Simple singularize function
function singularize(word) {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

// Handle page selector change
document.getElementById('pageSelector').addEventListener('change', (e) => {
  const value = e.target.value;
  if (!value) return;

  if (value.startsWith('new:')) {
    // Reset dropdown to previous value (don't keep "New..." selected)
    e.target.value = currentCollection && currentSlug ? `${currentCollection}/${currentSlug}` : '';
    // Open new item modal
    const collectionName = value.split(':')[1];
    openNewItemModal(collectionName);
  } else {
    const [collection, slug] = value.split('/');
    loadEntry(collection, slug);
  }
});

// ============================================
// New Item Modal
// ============================================

let pendingNewCollection = null;

function openNewItemModal(collectionName) {
  pendingNewCollection = collectionName;
  const modal = document.getElementById('newItemModal');
  const collectionNameSpan = document.getElementById('newItemCollectionName');
  const slugInput = document.getElementById('newItemSlug');
  const createBtn = document.getElementById('newItemCreateBtn');
  const errorEl = document.getElementById('newItemSlugError');
  const hintEl = document.getElementById('newItemSlugHint');

  // Set collection name in modal title
  collectionNameSpan.textContent = singularize(collectionName.charAt(0).toUpperCase() + collectionName.slice(1));

  // Reset form
  slugInput.value = '';
  createBtn.disabled = true;
  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  hintEl.classList.remove('hidden');

  // Show modal
  modal.classList.remove('hidden');
  slugInput.focus();
}

function closeNewItemModal() {
  const modal = document.getElementById('newItemModal');
  modal.classList.add('hidden');
  pendingNewCollection = null;
}

// Validate slug format and uniqueness
function validateSlug(slug, collectionName) {
  if (!slug) {
    return { valid: false, error: '' };
  }

  // Check format: lowercase, hyphens, underscores, numbers only
  const slugRegex = /^[a-z0-9]([a-z0-9-_]*[a-z0-9])?$/;
  if (!slugRegex.test(slug)) {
    return { valid: false, error: 'Use lowercase letters, numbers, hyphens, and underscores only' };
  }

  // Check for duplicates
  const exists = allPages.some(p => p.collection === collectionName && p.slug === slug);
  if (exists) {
    return { valid: false, error: `"${slug}" already exists in ${collectionName}` };
  }

  return { valid: true, error: '' };
}

// Modal event handlers
document.getElementById('newItemModal').addEventListener('click', (e) => {
  // Close on overlay click
  if (e.target.id === 'newItemModal') {
    closeNewItemModal();
  }
  // Close button
  if (e.target.matches('[data-close]')) {
    closeNewItemModal();
  }
  // Cancel button
  if (e.target.matches('[data-cancel]')) {
    closeNewItemModal();
  }
  // Create button
  if (e.target.matches('[data-create]') && !e.target.disabled) {
    const slug = document.getElementById('newItemSlug').value.trim();
    const collection = pendingNewCollection; // Capture before close clears it
    if (collection && slug) {
      closeNewItemModal();
      createNewEntry(collection, slug);
    }
  }
});

// Slug input validation
document.getElementById('newItemSlug').addEventListener('input', (e) => {
  const slug = e.target.value.trim().toLowerCase();
  const createBtn = document.getElementById('newItemCreateBtn');
  const errorEl = document.getElementById('newItemSlugError');
  const hintEl = document.getElementById('newItemSlugHint');

  const { valid, error } = validateSlug(slug, pendingNewCollection);

  if (error) {
    errorEl.textContent = error;
    errorEl.classList.remove('hidden');
    hintEl.classList.add('hidden');
  } else {
    errorEl.classList.add('hidden');
    hintEl.classList.remove('hidden');
  }

  createBtn.disabled = !valid;
});

// Enter key to create
document.getElementById('newItemSlug').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const createBtn = document.getElementById('newItemCreateBtn');
    if (!createBtn.disabled) {
      createBtn.click();
    }
  }
  if (e.key === 'Escape') {
    closeNewItemModal();
  }
});

// ============================================
// Create New Entry
// ============================================

async function createNewEntry(collection, slug) {
  currentCollection = collection;
  currentSlug = slug;
  isNewEntry = true;

  // Update URL
  const newUrl = `/dashboard/${collection}/${slug}`;
  history.pushState({ collection, slug }, '', newUrl);

  // Update dropdown (won't find the new item yet, that's OK)
  const selector = document.getElementById('pageSelector');
  selector.value = '';

  document.getElementById('editorTitle').textContent = `New: ${slug}`;
  document.getElementById('editorForm').innerHTML = '<p class="placeholder-text">Loading...</p>';
  document.getElementById('saveBtn').style.display = 'inline-block';
  document.getElementById('deleteEntryBtn').style.display = 'none'; // Can't delete unsaved entry
  updateSaveStatus('New - unsaved');

  try {
    // Get schema for this collection
    const schemaResponse = await fetch(`/api/collections/${collection}`);
    const schemaData = await schemaResponse.json();

    if (!schemaData.success) {
      throw new Error('Failed to load collection schema');
    }

    // Determine content type based on collection
    const contentType = schemaData.collection.type === 'data' ? 'data' : 'content';

    // Initialize currentData with empty content
    currentData = {
      data: {},
      body: '',
      type: contentType,
      schema: schemaData.collection.schema
    };

    // Render empty editor
    renderEditorForNewEntry(schemaData.collection.schema, contentType);

  } catch (error) {
    console.error('Failed to create new entry:', error);
    document.getElementById('editorForm').innerHTML = `
      <p class="text-red-500">Failed to initialize: ${error.message}</p>
    `;
  }
}

// Render editor for a new entry (with empty data)
function renderEditorForNewEntry(schema, contentType) {
  const editorForm = document.getElementById('editorForm');

  // Generate form from schema with empty data
  const formHtml = generateForm(schema, {});

  // Only show markdown body editor for content types that DON'T use blocks
  const hasBlocks = schema?.properties?.blocks;
  const bodyEditor = (contentType === 'content' && !hasBlocks) ? `
    <div class="form-group">
      <label for="markdown-body" class="form-label">Content (Markdown)</label>
      <textarea
        id="markdown-body"
        name="body"
        rows="6"
        class="form-input"
        placeholder="Enter markdown content..."
      ></textarea>
    </div>
  ` : '';

  editorForm.innerHTML = `
    <form id="contentForm">
      ${formHtml}
      ${bodyEditor}
    </form>
  `;

  // Setup form handlers
  const form = document.getElementById('contentForm');
  const debouncedSave = debounce(async () => {
    updateSaveStatus('Saving...');
    await saveContent(true);
  }, 1000);

  setupFormHandlers(form, debouncedSave);
  setupAutoSave(form, debouncedSave);
  collapseAllBlocks();
}

// Load an entry for editing
async function loadEntry(collection, slug, updateUrl = true) {
  currentCollection = collection;
  currentSlug = slug;
  isNewEntry = false; // Loading existing entry

  // Update URL without page reload
  if (updateUrl) {
    const newUrl = `/dashboard/${collection}/${slug}`;
    history.pushState({ collection, slug }, '', newUrl);
  }

  // Update dropdown to match
  const selector = document.getElementById('pageSelector');
  selector.value = `${collection}/${slug}`;

  document.getElementById('editorTitle').textContent = `Editing: ${slug}`;
  document.getElementById('editorForm').innerHTML = '<p class="placeholder-text">Loading...</p>';
  document.getElementById('saveBtn').style.display = 'inline-block';
  document.getElementById('deleteEntryBtn').style.display = 'inline-block';

  try {
    const response = await fetch(`/api/content/${collection}/${slug}`);
    const data = await response.json();

    if (data.success) {
      currentData = data;
      renderEditor(data);
      updatePreview();
    }
  } catch (error) {
    console.error('Failed to load entry:', error);
    document.getElementById('editorForm').innerHTML = `
      <p class="text-red-500">Failed to load entry: ${error.message}</p>
    `;
  }
}

// Parse URL to get collection/slug
function getEntryFromUrl() {
  const path = window.location.pathname;
  const match = path.match(/^\/dashboard\/([^/]+)\/(.+)$/);
  if (match) {
    return { collection: match[1], slug: match[2] };
  }
  return null;
}

// Handle browser back/forward
window.addEventListener('popstate', (e) => {
  if (e.state?.collection && e.state?.slug) {
    loadEntry(e.state.collection, e.state.slug, false);
  }
});

// Render editor for an entry
async function renderEditor(entryData) {
  const editorForm = document.getElementById('editorForm');

  // Get schema for this collection
  const schemaResponse = await fetch(`/api/collections/${currentCollection}`);
  const schemaData = await schemaResponse.json();

  // Generate form from schema (title/description will be in an SEO block)
  const formHtml = generateForm(schemaData.collection.schema, entryData.data);

  // Only show markdown body editor for content types that DON'T use blocks
  // Pages use blocks, so they don't need a body field
  const hasBlocks = schemaData.collection.schema?.properties?.blocks;
  const bodyEditor = (entryData.type === 'content' && !hasBlocks) ? `
    <div class="form-group">
      <label for="markdown-body" class="form-label">Content (Markdown)</label>
      <textarea
        id="markdown-body"
        name="body"
        rows="6"
        class="form-input"
        placeholder="Enter markdown content..."
      >${entryData.body || ''}</textarea>
    </div>
  ` : '';

  editorForm.innerHTML = `
    <form id="contentForm">
      ${formHtml}
      ${bodyEditor}
    </form>
  `;

  // Setup form handlers for dynamic fields (blocks, arrays)
  const form = document.getElementById('contentForm');
  const debouncedSave = debounce(async () => {
    updateSaveStatus('Saving...');
    await saveContent(true);
  }, 1000);

  setupFormHandlers(form, debouncedSave);

  // Add auto-save on input change
  setupAutoSave(form, debouncedSave);

  // Collapse all blocks by default
  collapseAllBlocks();

  // Setup block focus handler (click to scroll in preview)
  setupBlockFocus();

  // Setup image picker handlers
  setupImagePickers(form, debouncedSave);

  // Setup color picker handlers
  setupColorPickers(form, debouncedSave);

  // Setup reference picker handlers
  setupReferencePickers(form, debouncedSave);
}

/**
 * Setup image picker event handlers
 */
function setupImagePickers(form, onChangeCallback) {
  // Use event delegation on the form for better performance
  form.addEventListener('click', (e) => {
    // Browse library button
    if (e.target.matches('[data-browse]')) {
      const picker = e.target.closest('.image-picker');
      const hiddenInput = picker.querySelector('.image-picker-input');
      const currentValue = hiddenInput.value;

      openImageLibrary((url) => {
        updateImagePicker(picker, url);
        if (onChangeCallback) onChangeCallback();
      }, currentValue);
      return;
    }

    // Upload new button
    if (e.target.matches('[data-upload]')) {
      const picker = e.target.closest('.image-picker');

      uploadNewImage((url) => {
        updateImagePicker(picker, url);
        if (onChangeCallback) onChangeCallback();
      });
      return;
    }

    // Clear button
    if (e.target.matches('[data-clear]')) {
      const picker = e.target.closest('.image-picker');
      updateImagePicker(picker, '');
      if (onChangeCallback) onChangeCallback();
      return;
    }
  });

}

/**
 * Update image picker with new URL
 */
function updateImagePicker(picker, url) {
  const hiddenInput = picker.querySelector('.image-picker-input');
  const altInput = picker.querySelector('[data-alt-input]');
  const preview = picker.querySelector('[data-preview]');
  const previewImg = picker.querySelector('[data-preview-img]');
  const placeholder = picker.querySelector('[data-placeholder]');

  // Update hidden input value
  hiddenInput.value = url;

  // Update preview visibility
  if (url && url.trim()) {
    previewImg.src = url;
    preview.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    preview.classList.add('hidden');
    placeholder.classList.remove('hidden');
    // Clear alt text when image is cleared
    if (altInput) altInput.value = '';
  }
}

/**
 * Setup color picker event handlers
 */
function setupColorPickers(form, onChangeCallback) {
  // Color picker change -> update text input
  form.addEventListener('input', (e) => {
    if (e.target.matches('.color-picker-input')) {
      const targetId = e.target.dataset.target;
      const textInput = document.getElementById(targetId);
      if (textInput) {
        textInput.value = e.target.value;
        if (onChangeCallback) onChangeCallback();
      }
    }

    // Text input change -> update color picker
    if (e.target.matches('.color-picker-text')) {
      const pickerId = e.target.id + '_picker';
      const picker = document.getElementById(pickerId);
      if (picker && e.target.value.match(/^#[0-9a-fA-F]{6}$/)) {
        picker.value = e.target.value;
      }
    }
  });

  // Clear button
  form.addEventListener('click', (e) => {
    if (e.target.matches('[data-clear-color]')) {
      const targetId = e.target.dataset.clearColor;
      const textInput = document.getElementById(targetId);
      const picker = document.getElementById(targetId + '_picker');

      if (textInput) textInput.value = '';
      if (picker) picker.value = '#ffffff';

      // Remove the clear button
      e.target.remove();

      if (onChangeCallback) onChangeCallback();
    }
  });
}

/**
 * Setup reference picker event handlers
 */
function setupReferencePickers(form, onChangeCallback) {
  // Load preview data for all reference items on the page
  loadReferenceItemPreviews(form);

  form.addEventListener('click', (e) => {
    // Add reference item button
    if (e.target.matches('.add-reference-item')) {
      const referenceField = e.target.closest('.reference-field');
      const collectionName = e.target.dataset.collection;
      const fieldPath = e.target.dataset.field;

      // Get currently selected IDs to exclude from picker
      const existingItems = referenceField.querySelectorAll('.reference-item');
      const excludeIds = Array.from(existingItems).map(item => item.dataset.id);

      openReferencePicker(collectionName, (selectedId, selectedData) => {
        addReferenceItem(referenceField, fieldPath, selectedId, selectedData);
        if (onChangeCallback) onChangeCallback();
      }, excludeIds);
      return;
    }

    // Click on existing reference item to change it
    if (e.target.closest('.edit-reference-item')) {
      const item = e.target.closest('.reference-item');
      const referenceField = e.target.closest('.reference-field');
      const collectionName = referenceField.dataset.collection;
      const fieldPath = referenceField.dataset.field;
      const currentId = item.dataset.id;

      // Get all OTHER selected IDs to exclude (not the current one being edited)
      const existingItems = referenceField.querySelectorAll('.reference-item');
      const excludeIds = Array.from(existingItems)
        .map(i => i.dataset.id)
        .filter(id => id !== currentId);

      openReferencePicker(collectionName, (selectedId, selectedData) => {
        // Replace the current item
        replaceReferenceItem(item, fieldPath, selectedId, selectedData);
        if (onChangeCallback) onChangeCallback();
      }, excludeIds);
      return;
    }

    // Remove reference item button
    if (e.target.matches('.remove-reference-item')) {
      const item = e.target.closest('.reference-item');
      const referenceField = e.target.closest('.reference-field');
      item.remove();
      reindexReferenceItems(referenceField);

      // Show empty message if no items left
      const items = referenceField.querySelectorAll('.reference-item');
      if (items.length === 0) {
        const itemsContainer = referenceField.querySelector('.reference-items');
        itemsContainer.innerHTML = '<div class="reference-empty">No items selected. Click "Add" to select.</div>';
      }

      if (onChangeCallback) onChangeCallback();
      return;
    }
  });
}

/**
 * Load preview data for all reference items
 */
async function loadReferenceItemPreviews(form) {
  const referenceFields = form.querySelectorAll('.reference-field');

  for (const field of referenceFields) {
    const collectionName = field.dataset.collection;
    if (!collectionName) continue;

    try {
      const response = await fetch(`/api/collections/${collectionName}/entries?preview=true`);
      const data = await response.json();

      if (data.success && data.entries) {
        // Create a lookup map
        const entriesMap = {};
        for (const entry of data.entries) {
          entriesMap[entry.slug] = entry;
        }

        // Update all preview elements in this field
        const items = field.querySelectorAll('.reference-item');
        for (const item of items) {
          const itemId = item.dataset.id;
          const entry = entriesMap[itemId];

          const titleEl = item.querySelector('.reference-item-title');
          const previewEl = item.querySelector('.reference-item-preview');

          if (entry) {
            if (titleEl) titleEl.textContent = entry.title || itemId;
            if (previewEl) previewEl.textContent = entry.preview || '';
          } else {
            if (previewEl) previewEl.textContent = '';
          }
        }
      }
    } catch (error) {
      console.error(`Failed to load previews for ${collectionName}:`, error);
    }
  }
}

/**
 * Add a reference item to the field
 */
function addReferenceItem(referenceField, fieldPath, itemId, itemData = null) {
  const itemsContainer = referenceField.querySelector('.reference-items');

  // Remove empty message if present
  const emptyMsg = itemsContainer.querySelector('.reference-empty');
  if (emptyMsg) emptyMsg.remove();

  const index = itemsContainer.querySelectorAll('.reference-item').length;
  const title = itemData?.title || itemId;
  const preview = itemData?.preview || '';

  const newItem = document.createElement('div');
  newItem.className = 'reference-item';
  newItem.dataset.index = index;
  newItem.dataset.id = itemId;
  newItem.innerHTML = `
    <input type="hidden" name="${fieldPath}[${index}]" value="${escapeHtml(itemId)}">
    <div class="reference-item-content edit-reference-item" title="Click to change">
      <span class="reference-item-title">${escapeHtml(title)}</span>
      <span class="reference-item-preview">${escapeHtml(preview)}</span>
    </div>
    <button type="button" class="btn btn-sm btn-danger remove-reference-item" title="Remove">×</button>
  `;

  itemsContainer.appendChild(newItem);
}

/**
 * Replace a reference item with a new selection
 */
function replaceReferenceItem(item, fieldPath, newId, itemData = null) {
  const index = item.dataset.index;
  const title = itemData?.title || newId;
  const preview = itemData?.preview || '';

  // Update the item
  item.dataset.id = newId;

  const input = item.querySelector('input[type="hidden"]');
  if (input) input.value = newId;

  const titleEl = item.querySelector('.reference-item-title');
  if (titleEl) titleEl.textContent = title;

  const previewEl = item.querySelector('.reference-item-preview');
  if (previewEl) previewEl.textContent = preview;
}

/**
 * Reindex reference items after removal
 */
function reindexReferenceItems(referenceField) {
  const fieldPath = referenceField.dataset.field;
  const items = referenceField.querySelectorAll('.reference-item');

  items.forEach((item, newIndex) => {
    item.dataset.index = newIndex;

    const input = item.querySelector('input[type="hidden"]');
    if (input) {
      input.name = `${fieldPath}[${newIndex}]`;
    }
  });
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Collapse all blocks by default
function collapseAllBlocks() {
  const blocks = document.querySelectorAll('.block-item');
  blocks.forEach(block => {
    block.classList.add('collapsed');
    const toggleBtn = block.querySelector('.toggle-block');
    if (toggleBtn) {
      toggleBtn.textContent = '+';
    }
  });
}

// Setup block focus - clicking a block scrolls to it in the preview
function setupBlockFocus() {
  const blocksList = document.querySelector('.blocks-list');
  if (!blocksList) return;

  blocksList.addEventListener('click', (e) => {
    const blockItem = e.target.closest('.block-item');
    if (!blockItem) return;

    const index = blockItem.dataset.index;
    const blockType = blockItem.dataset.type;

    // Don't focus SEO blocks (they're not rendered)
    if (blockType === 'seo') return;

    // Try to detect which field was clicked
    let fieldName = null;
    const formGroup = e.target.closest('.form-group');
    if (formGroup) {
      const input = formGroup.querySelector('input, textarea, select');
      if (input?.name) {
        // Extract field name from path like "blocks[0].heading" -> "heading"
        const match = input.name.match(/\.([^.\[\]]+)$/);
        if (match) {
          fieldName = match[1];
        }
      }
    }

    // Send message to iframe to focus this block/element
    const iframe = document.getElementById('previewFrame');
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({
        type: 'focusBlock',
        index: parseInt(index),
        blockType: blockType,
        fieldName: fieldName
      }, '*');
    }
  });
}

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Setup auto-save on form changes
function setupAutoSave(form, debouncedSave) {
  form.addEventListener('input', () => {
    debouncedSave();
  });
}

// Update save status indicator
function updateSaveStatus(message) {
  const status = document.getElementById('saveStatus');
  status.textContent = message;

  if (message === 'Saved') {
    setTimeout(() => {
      status.textContent = '';
    }, 2000);
  }
}

// Save content
async function saveContent(silent = false) {
  const form = document.getElementById('contentForm');
  const saveBtn = document.getElementById('saveBtn');

  // Extract form data
  const formData = extractFormData(form);
  const body = document.getElementById('markdown-body')?.value || '';

  // Show saving state (unless silent)
  if (!silent && saveBtn) {
    const originalText = saveBtn.textContent;
    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;
  }

  try {
    const response = await fetch(`/api/content/${currentCollection}/${currentSlug}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: formData,
        body: body,
        type: currentData.type,
      }),
    });

    const result = await response.json();

    if (result.success) {
      updateSaveStatus('Saved');
      if (!silent) {
        showNotification('Changes saved!', 'success');
      }

      // Handle first save of new entry
      if (isNewEntry) {
        isNewEntry = false;
        document.getElementById('editorTitle').textContent = `Editing: ${currentSlug}`;
        // Refresh dropdown to include the new entry
        await loadPages();
        // Select the new entry in dropdown
        document.getElementById('pageSelector').value = `${currentCollection}/${currentSlug}`;
      }

      // Update changes badge
      updateChangesBadge();
      // Don't force preview reload - Astro's HMR handles it automatically
      // The file save triggers Vite's watcher which hot-reloads the iframe
    } else {
      updateSaveStatus('Error');
      if (!silent) {
        showNotification('Failed to save: ' + result.error, 'error');
      }
    }
  } catch (error) {
    console.error('Save failed:', error);
    updateSaveStatus('Error');
    if (!silent) {
      showNotification('Failed to save changes', 'error');
    }
  } finally {
    if (!silent && saveBtn) {
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
    }
  }
}

// Store scroll position (received from iframe via postMessage)
let lastPreviewScrollY = 0;

// Listen for messages from preview iframe
window.addEventListener('message', (event) => {
  if (event.data?.type === 'scrollPosition') {
    lastPreviewScrollY = event.data.scrollY;
  }
  // Handle page navigation in preview - sync admin to show that page
  if (event.data?.type === 'pageNavigation') {
    const pathname = event.data.pathname;
    // Map pathname to collection/slug (only for pages collection)
    // e.g., "/" -> pages/home, "/teaching" -> pages/teaching
    let slug = pathname === '/' ? 'home' : pathname.replace(/^\/|\/$/g, '');
    // Only switch if it's a different page and we're in pages collection
    if (slug && slug !== currentSlug) {
      loadEntry('pages', slug, true);
    }
  }
});

// Update preview
async function updatePreview() {
  const iframe = document.getElementById('previewFrame');
  const placeholder = document.getElementById('previewPlaceholder');
  const previewControls = document.getElementById('previewControls');

  if (!previewUrl) {
    return;
  }

  // Show preview and controls
  iframe.style.display = 'block';
  placeholder.style.display = 'none';
  previewControls.style.display = 'flex';

  // Determine preview page URL
  const pageUrl = currentCollection === 'pages' && currentSlug === 'home'
    ? `${previewUrl}/`
    : `${previewUrl}/${currentSlug}`;

  // Save current scroll position before reload
  const scrollToRestore = lastPreviewScrollY;

  // Add loading state for subtle visual feedback
  iframe.classList.add('loading');

  // Force iframe reload
  const newUrl = pageUrl + '?t=' + Date.now();

  // Listen for load to restore scroll position
  const onLoad = () => {
    iframe.removeEventListener('load', onLoad);
    // Remove loading state
    iframe.classList.remove('loading');
    // Wait a frame for content to render, then tell iframe to restore scroll
    requestAnimationFrame(() => {
      if (iframe.contentWindow && scrollToRestore > 0) {
        iframe.contentWindow.postMessage({
          type: 'restoreScroll',
          scrollY: scrollToRestore
        }, '*');
      }
    });
  };
  iframe.addEventListener('load', onLoad);

  if (iframe.contentWindow) {
    iframe.contentWindow.location.replace(newUrl);
  } else {
    iframe.src = newUrl;
  }

  console.log('Preview updated:', newUrl);
}

// Refresh preview manually
document.getElementById('refreshPreview')?.addEventListener('click', () => {
  updatePreview();
});

// Viewport size selector
document.getElementById('viewportSelector')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.viewport-btn');
  if (!btn) return;

  // Update active state
  document.querySelectorAll('.viewport-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  // Resize scaler (which contains iframe)
  const width = btn.dataset.width;
  const scaler = document.getElementById('previewScaler');
  const wrapper = document.getElementById('previewWrapper');

  if (width === '100%') {
    scaler.style.width = '100%';
    scaler.style.maxWidth = 'none';
    wrapper.style.padding = '0';
  } else {
    scaler.style.width = width;
    scaler.style.maxWidth = width;
    wrapper.style.padding = '16px';
  }
});

// Show notification
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 60px;
    right: 20px;
    padding: 12px 20px;
    background: ${type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#667eea'};
    color: white;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 1000;
    font-size: 14px;
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.remove();
  }, 3000);
}

// Save button handler
document.getElementById('saveBtn').addEventListener('click', () => {
  saveContent();
});

// Keyboard shortcut: Cmd/Ctrl + S to save
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (currentCollection && currentSlug) {
      saveContent();
    }
  }
});

// Delete entry handler
document.getElementById('deleteEntryBtn').addEventListener('click', async () => {
  if (!currentCollection || !currentSlug || isNewEntry) return;

  const confirmed = confirm(`Are you sure you want to delete "${currentSlug}" from ${currentCollection}?\n\nThis cannot be undone.`);
  if (!confirmed) return;

  try {
    const response = await fetch(`/api/content/${currentCollection}/${currentSlug}`, {
      method: 'DELETE',
    });

    const result = await response.json();

    if (result.success) {
      showNotification(`Deleted "${currentSlug}"`, 'success');

      // Refresh the page list
      await loadPages();

      // Clear the editor
      currentCollection = null;
      currentSlug = null;
      currentData = null;
      document.getElementById('editorTitle').textContent = 'Select a page to edit';
      document.getElementById('editorForm').innerHTML = '<p class="placeholder-text">Choose a page from the dropdown above to start editing.</p>';
      document.getElementById('saveBtn').style.display = 'none';
      document.getElementById('deleteEntryBtn').style.display = 'none';
      document.getElementById('pageSelector').value = '';

      // Update URL
      history.pushState({}, '', '/dashboard');

      // Hide preview
      document.getElementById('previewFrame').style.display = 'none';
      document.getElementById('previewPlaceholder').style.display = 'flex';
      document.getElementById('previewControls').style.display = 'none';

      // Update changes badge
      updateChangesBadge();
    } else {
      showNotification('Failed to delete: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('Delete failed:', error);
    showNotification('Failed to delete entry', 'error');
  }
});

// Logout
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  } catch (error) {
    console.error('Logout failed:', error);
  }
});

// Changes panel toggle
document.getElementById('changesBtn').addEventListener('click', toggleChangesPanel);

// Update changes badge count
async function updateChangesBadge() {
  const count = await getChangesCount();
  const badge = document.getElementById('changesBadge');

  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// Listen for file reverts to reload the editor
window.addEventListener('fileReverted', () => {
  if (currentCollection && currentSlug) {
    loadEntry(currentCollection, currentSlug, false);
  }
});

// Initialize
async function init() {
  await checkAuth();
  await loadConfig();
  await loadPages();

  // Update changes badge
  updateChangesBadge();

  // Load entry from URL if present, otherwise auto-select first page
  const entry = getEntryFromUrl();
  if (entry) {
    loadEntry(entry.collection, entry.slug, false);
  } else {
    // Auto-select first page - prefer "home" from pages collection
    const homePage = allPages.find(p => p.collection === 'pages' && p.slug === 'home');
    const firstPage = homePage || allPages.find(p => p.collection === 'pages') || allPages[0];

    if (firstPage) {
      loadEntry(firstPage.collection, firstPage.slug, true);
    }
  }
}

init();
