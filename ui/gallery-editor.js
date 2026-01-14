/**
 * Gallery Editor Component
 * Modal for editing arrays of images with drag-to-reorder
 */

import { openImageLibrary } from './image-library.js';

let currentCallback = null;
let currentImages = []; // Array of { src, alt } objects
let draggedItem = null;
let draggedIndex = null;
let dropPosition = null; // { index, position: 'before' | 'after' }
let allImageMetadata = {}; // Cache of image metadata

/**
 * Open the gallery editor modal
 * @param {Array} images - Current array of image objects [{ src, alt }, ...]
 * @param {Function} onSave - Callback when saved (receives updated array)
 */
export async function openGalleryEditor(images, onSave) {
  currentCallback = onSave;
  currentImages = JSON.parse(JSON.stringify(images || [])); // Deep clone

  // Create modal if it doesn't exist
  let modal = document.getElementById('galleryEditorModal');
  if (!modal) {
    modal = createModal();
    document.body.appendChild(modal);
    setupModalEvents(modal);
  }

  // Show modal
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Load image metadata for alt text lookup
  await loadImageMetadata();

  // Render images
  renderImages();
}

/**
 * Close the gallery editor modal
 */
export function closeGalleryEditor() {
  const modal = document.getElementById('galleryEditorModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
  currentCallback = null;
  currentImages = [];
}

/**
 * Load image metadata from API
 */
async function loadImageMetadata() {
  try {
    const response = await fetch('/api/images');
    const data = await response.json();
    if (data.success) {
      // Build lookup by URL
      allImageMetadata = {};
      data.images.forEach(img => {
        allImageMetadata[img.url] = img;
      });
    }
  } catch (error) {
    console.error('Error loading image metadata:', error);
  }
}

/**
 * Create the modal HTML structure
 */
function createModal() {
  const modal = document.createElement('div');
  modal.id = 'galleryEditorModal';
  modal.className = 'gallery-editor-overlay hidden';
  modal.innerHTML = `
    <div class="gallery-editor-modal">
      <div class="gallery-editor-header">
        <h2 class="gallery-editor-title">Edit Gallery</h2>
        <button type="button" class="gallery-editor-close" data-close>&times;</button>
      </div>
      <div class="gallery-editor-body">
        <div class="gallery-editor-list" data-list>
          <!-- Images will be rendered here -->
        </div>
        <div class="gallery-editor-empty hidden" data-empty>
          <p>No images in gallery. Add some below.</p>
        </div>
      </div>
      <div class="gallery-editor-footer">
        <button type="button" class="btn btn-secondary" data-add>
          + Add Images
        </button>
        <div class="gallery-editor-actions">
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
  // Close button
  modal.querySelector('[data-close]').addEventListener('click', closeGalleryEditor);
  modal.querySelector('[data-cancel]').addEventListener('click', closeGalleryEditor);

  // Click outside to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeGalleryEditor();
    }
  });

  // Escape key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeGalleryEditor();
    }
  });

  // Add images button
  modal.querySelector('[data-add]').addEventListener('click', () => {
    openImageLibrary((url) => {
      const metadata = allImageMetadata[url] || {};
      currentImages.push({
        src: url,
        alt: metadata.alt || '',
      });
      renderImages();
    });
  });

  // Save button
  modal.querySelector('[data-save]').addEventListener('click', () => {
    if (currentCallback) {
      currentCallback(currentImages);
      closeGalleryEditor();
    }
  });

  // List click delegation
  const list = modal.querySelector('[data-list]');

  list.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      const index = parseInt(removeBtn.dataset.remove, 10);
      currentImages.splice(index, 1);
      renderImages();
    }
  });

  // Drag and drop
  list.addEventListener('dragstart', handleDragStart);
  list.addEventListener('dragend', handleDragEnd);
  list.addEventListener('dragover', handleDragOver);
  list.addEventListener('drop', handleDrop);
}

/**
 * Render images in the list
 */
function renderImages() {
  const modal = document.getElementById('galleryEditorModal');
  const list = modal.querySelector('[data-list]');
  const empty = modal.querySelector('[data-empty]');

  if (currentImages.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  list.innerHTML = currentImages.map((img, index) => {
    const metadata = allImageMetadata[img.src] || {};
    const displayAlt = img.alt || metadata.alt || '';
    const filename = img.src.split('/').pop();

    return `
      <div class="gallery-editor-item" draggable="true" data-index="${index}">
        <div class="gallery-editor-item-handle" title="Drag to reorder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/>
            <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
            <circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>
          </svg>
        </div>
        <div class="gallery-editor-item-thumb">
          <img src="${escapeHtml(img.src)}" alt="">
        </div>
        <div class="gallery-editor-item-info">
          <div class="gallery-editor-item-filename">${escapeHtml(filename)}</div>
          <div class="gallery-editor-item-alt">${displayAlt ? escapeHtml(displayAlt) : '<span class="text-gray-400">No alt text</span>'}</div>
        </div>
        <button type="button" class="gallery-editor-item-remove" data-remove="${index}" title="Remove">
          &times;
        </button>
      </div>
    `;
  }).join('');
}

/**
 * Drag handlers
 */
function handleDragStart(e) {
  const item = e.target.closest('.gallery-editor-item');
  if (!item) return;

  draggedItem = item;
  draggedIndex = parseInt(item.dataset.index, 10);
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', item.dataset.index);
}

function handleDragEnd(e) {
  const item = e.target.closest('.gallery-editor-item');
  if (item) {
    item.classList.remove('dragging');
  }
  draggedItem = null;
  draggedIndex = null;
  dropPosition = null;

  // Remove all drag indicator classes
  document.querySelectorAll('.gallery-editor-item').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const item = e.target.closest('.gallery-editor-item');
  if (!item || item === draggedItem) return;

  const rect = item.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const position = e.clientY < midY ? 'before' : 'after';
  const itemIndex = parseInt(item.dataset.index, 10);

  // Remove indicators from all items
  document.querySelectorAll('.gallery-editor-item').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });

  // Add indicator to current item
  item.classList.add(position === 'before' ? 'drop-before' : 'drop-after');
  dropPosition = { index: itemIndex, position };
}

function handleDrop(e) {
  e.preventDefault();

  if (!draggedItem || !dropPosition) return;

  const fromIndex = draggedIndex;
  let toIndex = dropPosition.index;

  // Adjust toIndex based on position and direction
  if (dropPosition.position === 'after') {
    toIndex += 1;
  }
  // If moving down, account for the removal
  if (fromIndex < toIndex) {
    toIndex -= 1;
  }

  if (fromIndex !== toIndex) {
    // Reorder the array
    const [moved] = currentImages.splice(fromIndex, 1);
    currentImages.splice(toIndex, 0, moved);
    renderImages();
  }

  // Clean up
  document.querySelectorAll('.gallery-editor-item').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
  dropPosition = null;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
