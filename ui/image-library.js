/**
 * Image Library Component
 * Modal for browsing and selecting images
 */

let currentCallback = null;
let currentImages = [];
let selectedImageUrl = null;
let isUploading = false;

/**
 * Open the image library modal
 * @param {Function} onSelect - Callback when image is selected (receives url)
 * @param {string} currentValue - Current value to pre-select
 */
export async function openImageLibrary(onSelect, currentValue = '') {
  currentCallback = onSelect;
  selectedImageUrl = currentValue || null;

  // Create modal if it doesn't exist
  let modal = document.getElementById('imageLibraryModal');
  if (!modal) {
    modal = createModal();
    document.body.appendChild(modal);
    setupModalEvents(modal);
  }

  // Show modal
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Load images
  await loadImages();
}

/**
 * Close the image library modal
 */
export function closeImageLibrary() {
  const modal = document.getElementById('imageLibraryModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
  currentCallback = null;
  selectedImageUrl = null;
}

/**
 * Create the modal HTML structure
 */
function createModal() {
  const modal = document.createElement('div');
  modal.id = 'imageLibraryModal';
  modal.className = 'image-modal-overlay hidden';
  modal.innerHTML = `
    <div class="image-modal">
      <div class="image-modal-header">
        <h2 class="image-modal-title">Image Library</h2>
        <button type="button" class="image-modal-close" data-close>&times;</button>
      </div>
      <div class="image-modal-body">
        <div class="image-modal-upload-zone" data-upload-zone>
          <input type="file" accept="image/*" data-file-input>
          <div class="image-modal-upload-icon">📤</div>
          <div class="image-modal-upload-text">Drop image here or click to upload</div>
          <div class="image-modal-upload-hint">JPG, PNG, GIF, WebP, SVG (max 10MB)</div>
        </div>
        <div class="image-uploading hidden" data-uploading>
          <div class="image-uploading-spinner"></div>
          <span>Uploading...</span>
        </div>
        <div class="image-library-grid" data-grid>
          <!-- Images will be loaded here -->
        </div>
        <div class="image-library-empty hidden" data-empty>
          <p>No images yet. Upload your first image above.</p>
        </div>
      </div>
      <div class="image-modal-footer">
        <div class="image-modal-selected-details" data-selected-details>
          <div class="image-modal-selected-info" data-selected-info>
            No image selected
          </div>
          <div class="image-modal-alt-field hidden" data-alt-field>
            <label class="image-modal-alt-label">Alt text:</label>
            <input type="text" class="image-modal-alt-input" data-alt-input placeholder="Describe this image...">
            <button type="button" class="btn btn-sm btn-ghost" data-save-alt>Save</button>
          </div>
        </div>
        <div class="image-modal-actions">
          <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
          <button type="button" class="btn btn-primary" data-select disabled>Select Image</button>
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
  modal.querySelector('[data-close]').addEventListener('click', closeImageLibrary);
  modal.querySelector('[data-cancel]').addEventListener('click', closeImageLibrary);

  // Click outside to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeImageLibrary();
    }
  });

  // Escape key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeImageLibrary();
    }
  });

  // Upload zone click
  const uploadZone = modal.querySelector('[data-upload-zone]');
  const fileInput = modal.querySelector('[data-file-input]');

  uploadZone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await uploadImage(file);
      fileInput.value = ''; // Reset input
    }
  });

  // Drag and drop
  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
  });

  uploadZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');

    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      await uploadImage(files[0]);
    }
  });

  // Select button
  modal.querySelector('[data-select]').addEventListener('click', () => {
    if (selectedImageUrl && currentCallback) {
      currentCallback(selectedImageUrl);
      closeImageLibrary();
    }
  });

  // Save alt text button
  modal.querySelector('[data-save-alt]').addEventListener('click', saveAltText);

  // Save alt text on Enter
  modal.querySelector('[data-alt-input]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveAltText();
    }
  });

  // Grid click delegation (for selecting and deleting images)
  const grid = modal.querySelector('[data-grid]');
  grid.addEventListener('click', async (e) => {
    // Delete button
    const deleteBtn = e.target.closest('[data-delete]');
    if (deleteBtn) {
      e.stopPropagation();
      const filename = deleteBtn.dataset.delete;
      if (confirm(`Delete ${filename}?`)) {
        await deleteImage(filename);
      }
      return;
    }

    // Image selection
    const item = e.target.closest('.image-library-item');
    if (item) {
      selectImage(item.dataset.url);
    }
  });
}

/**
 * Load images from the API
 */
async function loadImages() {
  const modal = document.getElementById('imageLibraryModal');
  const grid = modal.querySelector('[data-grid]');
  const empty = modal.querySelector('[data-empty]');

  try {
    const response = await fetch('/api/images');
    const data = await response.json();

    if (data.success) {
      currentImages = data.images;
      renderImages(grid, empty);
    } else {
      console.error('Failed to load images:', data.error);
      grid.innerHTML = '<p class="text-red-500">Failed to load images</p>';
    }
  } catch (error) {
    console.error('Error loading images:', error);
    grid.innerHTML = '<p class="text-red-500">Error loading images</p>';
  }
}

/**
 * Render images in the grid
 */
function renderImages(grid, empty) {
  if (currentImages.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  grid.innerHTML = currentImages.map(img => `
    <div class="image-library-item ${selectedImageUrl === img.url ? 'selected' : ''}" data-url="${img.url}">
      <img src="${img.url}" alt="${img.filename}" loading="lazy">
      <div class="image-library-item-overlay">
        <span class="image-library-item-check">✓</span>
      </div>
      ${img.source === 'uploads' ? `<button type="button" class="image-library-item-delete" data-delete="${img.filename}" title="Delete">&times;</button>` : ''}
    </div>
  `).join('');
}

/**
 * Select an image
 */
function selectImage(url) {
  selectedImageUrl = url;

  const modal = document.getElementById('imageLibraryModal');
  const grid = modal.querySelector('[data-grid]');
  const selectBtn = modal.querySelector('[data-select]');
  const selectedInfo = modal.querySelector('[data-selected-info]');
  const altField = modal.querySelector('[data-alt-field]');
  const altInput = modal.querySelector('[data-alt-input]');

  // Update selection visuals
  grid.querySelectorAll('.image-library-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.url === url);
  });

  // Update footer
  const image = currentImages.find(img => img.url === url);
  if (image) {
    selectedInfo.textContent = `${image.filename} (${image.sizeFormatted})`;
    selectBtn.disabled = false;

    // Show alt text field
    altField.classList.remove('hidden');
    altInput.value = image.alt || '';
  }
}

/**
 * Save alt text for selected image
 */
async function saveAltText() {
  if (!selectedImageUrl) return;

  const modal = document.getElementById('imageLibraryModal');
  const altInput = modal.querySelector('[data-alt-input]');
  const saveBtn = modal.querySelector('[data-save-alt]');
  const image = currentImages.find(img => img.url === selectedImageUrl);

  if (!image) return;

  const newAlt = altInput.value.trim();
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    const response = await fetch(`/api/images/${encodeURIComponent(image.filename)}/metadata`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alt: newAlt }),
    });

    const data = await response.json();

    if (data.success) {
      // Update local cache
      image.alt = newAlt;
      saveBtn.textContent = 'Saved!';
      setTimeout(() => {
        saveBtn.textContent = 'Save';
        saveBtn.disabled = false;
      }, 1500);
    } else {
      alert('Failed to save alt text: ' + data.error);
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
    }
  } catch (error) {
    console.error('Error saving alt text:', error);
    alert('Error saving alt text: ' + error.message);
    saveBtn.textContent = 'Save';
    saveBtn.disabled = false;
  }
}

/**
 * Upload an image
 */
async function uploadImage(file) {
  const modal = document.getElementById('imageLibraryModal');
  const uploadingIndicator = modal.querySelector('[data-uploading]');
  const uploadZone = modal.querySelector('[data-upload-zone]');

  if (isUploading) return;
  isUploading = true;

  uploadZone.classList.add('hidden');
  uploadingIndicator.classList.remove('hidden');

  try {
    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch('/api/images', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();

    if (data.success) {
      // Reload images and auto-select the new one
      await loadImages();
      selectImage(data.image.url);
    } else {
      alert('Upload failed: ' + data.error);
    }
  } catch (error) {
    console.error('Error uploading image:', error);
    alert('Error uploading image: ' + error.message);
  } finally {
    isUploading = false;
    uploadZone.classList.remove('hidden');
    uploadingIndicator.classList.add('hidden');
  }
}

/**
 * Delete an image
 */
async function deleteImage(filename) {
  try {
    const response = await fetch(`/api/images/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
    });

    const data = await response.json();

    if (data.success) {
      // If deleted image was selected, clear selection
      const deletedImage = currentImages.find(img => img.filename === filename);
      if (deletedImage && deletedImage.url === selectedImageUrl) {
        selectedImageUrl = null;
        const modal = document.getElementById('imageLibraryModal');
        modal.querySelector('[data-select]').disabled = true;
        modal.querySelector('[data-selected-info]').textContent = 'No image selected';
      }

      // Reload images
      await loadImages();
    } else {
      alert('Delete failed: ' + data.error);
    }
  } catch (error) {
    console.error('Error deleting image:', error);
    alert('Error deleting image: ' + error.message);
  }
}

/**
 * Direct upload (for "Upload New" button in image picker)
 * @param {Function} onUpload - Callback when upload completes (receives url)
 */
export async function uploadNewImage(onUpload) {
  // Create a temporary file input
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;

    try {
      const formData = new FormData();
      formData.append('image', file);

      const response = await fetch('/api/images', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (data.success) {
        onUpload(data.image.url);
      } else {
        alert('Upload failed: ' + data.error);
      }
    } catch (error) {
      console.error('Error uploading image:', error);
      alert('Error uploading image: ' + error.message);
    }
  });

  input.click();
}
