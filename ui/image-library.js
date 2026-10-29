/**
 * Image Library Component
 * Modal for browsing and selecting images
 */

import { escapeHtml } from './escape-html.js';
import { readJson, failureText } from './api-response.js';
import { MAX_IMAGE_SIZE, MAX_VIDEO_SIZE, megabytes, mediaRefusal } from './media-kinds.js';

let currentCallback = null;
let currentImages = [];
let selectedImageUrl = null;
let isUploading = false;
// Opened for an Astro image() field: uploads go where Astro can import them,
// and every image is offered. For any other caller, image() files (source
// 'assets', served only to the editor) are hidden: a public field storing
// /assets/images/x.jpg would show in the editor and 404 on the live site.
let forAstroImage = false;
// What the library is opened for: 'image' or 'video'. Both live in the same
// folders (server/api/images.js); a picker sees only its own kind, so a video
// cannot be put into an image field or the reverse.
let libraryKind = 'image';
/** @type {IntersectionObserver|null} the grid's lazy video thumbnails */
let thumbnailObserver = null;

/**
 * The words and file types for each kind. The caps and refusals are the
 * server's own (media-kinds.js), checked here too so an editor is not made to
 * upload 20MB only to be refused (above 25MB the hosted proxy refuses it
 * first, with its own page rather than our message). The file input's
 * `accept` is only a hint: a chooser set to "All Files" offers anything.
 */
const KINDS = {
  image: {
    title: 'Image Library',
    noun: 'image',
    accept: 'image/*',
    hint: `JPG, PNG, GIF, WebP, SVG (max ${megabytes(MAX_IMAGE_SIZE)})`,
  },
  video: {
    title: 'Video Library',
    noun: 'video',
    accept: 'video/mp4,video/webm,.mp4,.webm',
    hint: `MP4 or WebM, muted and short (max ${megabytes(MAX_VIDEO_SIZE)})`,
  },
};

/** The upload URL for the current caller; the server refuses a file of another kind. */
function uploadEndpoint(astroImage, kind) {
  return astroImage ? '/api/images?for=image-field' : `/api/images?kind=${kind}`;
}

/**
 * A library entry's thumbnail: for a video, a muted <video> that loads only
 * its metadata (enough for the first frame), and only once it is in view
 * (loadVideoThumbnailsInView).
 */
function thumbnailHtml(item) {
  if (item.kind === 'video') {
    return `<video src="${escapeHtml(item.url)}" muted playsinline preload="none" data-lazy-thumbnail title="${escapeHtml(item.filename)}"></video>`;
  }
  return `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.filename)}" loading="lazy">`;
}

/**
 * Open the image library modal
 * @param {Function} onSelect - Callback when image is selected (receives the
 *   url and the library entry: {filename, url, source, ...})
 * @param {string} currentValue - Current value to pre-select
 * @param {object} [options]
 * @param {boolean} [options.astroImage] - opened for an Astro image() field
 * @param {'image'|'video'} [options.kind] - which library files to offer
 */
export async function openImageLibrary(onSelect, currentValue = '', { astroImage = false, kind = 'image' } = {}) {
  currentCallback = onSelect;
  forAstroImage = astroImage;
  libraryKind = kind;
  selectedImageUrl = currentValue || null;

  // Create modal if it doesn't exist
  let modal = document.getElementById('imageLibraryModal');
  if (!modal) {
    modal = createModal();
    document.body.appendChild(modal);
    setupModalEvents(modal);
  }
  labelModal(modal);
  // Nothing from the last opening survives into this one: it may have been
  // for the other kind, and an item clicked before the new list arrives would
  // be handed to this caller (a video into an image field).
  currentImages = [];
  modal.querySelector('[data-grid]').innerHTML = '';

  // Show modal
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Load images
  await loadImages();
  // The field's current file, highlighted by renderImages, is a selection:
  // the footer names it and Select takes it.
  selectImage(selectedImageUrl);
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
 * Word the (shared) modal for the kind it is opened for.
 */
function labelModal(modal) {
  const { title, noun, accept, hint } = KINDS[libraryKind];
  modal.querySelector('.image-modal-title').textContent = title;
  modal.querySelector('[data-file-input]').accept = accept;
  modal.querySelector('.image-modal-upload-text').textContent = `Drop ${noun} here or click to upload`;
  modal.querySelector('.image-modal-upload-hint').textContent = hint;
  modal.querySelector('[data-empty] p').textContent = `No ${noun}s yet. Upload your first ${noun} above.`;
  modal.querySelector('[data-select]').textContent = `Select ${noun[0].toUpperCase()}${noun.slice(1)}`;
  modal.querySelector('[data-select]').disabled = true;
  modal.querySelector('[data-selected-info]').textContent = `No ${noun} selected`;
  modal.querySelector('[data-alt-field]').classList.add('hidden');
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
          <div class="image-modal-upload-hint"></div>
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
    // Any file: uploadImage says why one of the wrong kind is refused.
    if (files.length > 0) await uploadImage(files[0]);
  });

  // Select button
  modal.querySelector('[data-select]').addEventListener('click', () => {
    if (selectedImageUrl && currentCallback) {
      currentCallback(selectedImageUrl, currentImages.find(img => img.url === selectedImageUrl) || null);
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
    const data = await readJson(response);

    if (data.success) {
      currentImages = data.images
        .filter(img => (img.kind || 'image') === libraryKind)
        .filter(img => forAstroImage || img.source !== 'assets');
      renderImages(grid, empty);
    } else {
      console.error('Failed to load images:', data.error);
      grid.innerHTML = '<p class="text-red-500">Failed to load images</p>';
    }
  } catch (error) {
    console.error('Error loading images:', error);
    grid.innerHTML = `<p class="text-red-500">${escapeHtml(failureText('Error loading images', error))}</p>`;
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
    <div class="image-library-item ${selectedImageUrl === img.url ? 'selected' : ''}" data-url="${escapeHtml(img.url)}">
      ${thumbnailHtml(img)}
      <div class="image-library-item-overlay">
        <span class="image-library-item-check">✓</span>
      </div>
      ${img.source === 'uploads' ? `<button type="button" class="image-library-item-delete" data-delete="${escapeHtml(img.filename)}" title="Delete">&times;</button>` : ''}
    </div>
  `).join('');
  loadVideoThumbnailsInView(grid);
}

/**
 * A video thumbnail fetches nothing until it scrolls into view (the lazy
 * loading an <img> gets from `loading="lazy"`), so opening a library of many
 * videos does not start a request for each.
 */
function loadVideoThumbnailsInView(grid) {
  // One observer at a time: a re-render replaced every element the last one
  // was watching.
  thumbnailObserver?.disconnect();
  thumbnailObserver = null;
  const videos = grid.querySelectorAll('video[data-lazy-thumbnail]');
  if (videos.length === 0) return;
  const startLoading = (video) => {
    video.removeAttribute('data-lazy-thumbnail');
    video.preload = 'metadata';
    video.load();
  };
  if (typeof IntersectionObserver === 'undefined') {
    videos.forEach(startLoading);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      startLoading(entry.target);
    }
  }, { root: grid.closest('.image-modal-body'), rootMargin: '200px' });
  videos.forEach((video) => observer.observe(video));
  thumbnailObserver = observer;
}

/**
 * Select an image. Only a file this opening lists can be selected: an upload
 * started before the modal was reopened (perhaps for the other kind) finishes
 * by selecting its file, which must not become this caller's choice.
 */
function selectImage(url) {
  if (!currentImages.some(img => img.url === url)) return;
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

    // Alt text describes an image; a video has none to give here
    altField.classList.toggle('hidden', image.kind === 'video');
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

    const data = await readJson(response);

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
  const refusal = mediaRefusal(file.name, file.size, libraryKind);
  if (refusal) {
    alert('Upload failed: ' + refusal);
    return;
  }
  isUploading = true;

  uploadZone.classList.add('hidden');
  uploadingIndicator.classList.remove('hidden');

  try {
    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch(uploadEndpoint(forAstroImage, libraryKind), {
      method: 'POST',
      body: formData,
    });

    const data = await readJson(response);

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

    const data = await readJson(response);

    if (data.success) {
      // If deleted image was selected, clear selection
      const deletedImage = currentImages.find(img => img.filename === filename);
      if (deletedImage && deletedImage.url === selectedImageUrl) {
        selectedImageUrl = null;
        const modal = document.getElementById('imageLibraryModal');
        modal.querySelector('[data-select]').disabled = true;
        modal.querySelector('[data-selected-info]').textContent = `No ${KINDS[libraryKind].noun} selected`;
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
 * @param {Function} onUpload - Callback when upload completes (receives the url
 *   and the uploaded image: {filename, url, source, ...})
 * @param {object} [options]
 * @param {boolean} [options.astroImage] - for an Astro image() field
 * @param {'image'|'video'} [options.kind] - what the file input accepts
 */
export async function uploadNewImage(onUpload, { astroImage = false, kind = 'image' } = {}) {
  // Create a temporary file input
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = KINDS[kind].accept;

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const refusal = mediaRefusal(file.name, file.size, kind);
    if (refusal) {
      alert('Upload failed: ' + refusal);
      return;
    }

    try {
      const formData = new FormData();
      formData.append('image', file);

      const response = await fetch(uploadEndpoint(astroImage, kind), {
        method: 'POST',
        body: formData,
      });

      const data = await readJson(response);

      if (data.success) {
        onUpload(data.image.url, data.image);
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
