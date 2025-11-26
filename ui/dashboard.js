/**
 * Dashboard functionality - Shopify-style layout
 */

import { generateForm, extractFormData, setupFormHandlers } from './form-generator.js';
import { openImageLibrary, uploadNewImage } from './image-library.js';
import { toggleChangesPanel, getChangesCount } from './changes-panel.js';

let currentCollection = null;
let currentSlug = null;
let currentData = null;
let previewUrl = '';
let allPages = []; // Store all pages for dropdown

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
      populatePageSelector(data.collections);
    }
  } catch (error) {
    console.error('Failed to load collections:', error);
  }
}

// Populate page selector dropdown
function populatePageSelector(collections) {
  const selector = document.getElementById('pageSelector');
  selector.innerHTML = '<option value="">Select page...</option>';

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
    optgroup.label = collection.name.charAt(0).toUpperCase() + collection.name.slice(1);

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

  // Handle selection change
  selector.addEventListener('change', (e) => {
    const value = e.target.value;
    if (value) {
      const [collection, slug] = value.split('/');
      loadEntry(collection, slug);
    }
  });
}

// Load an entry for editing
async function loadEntry(collection, slug, updateUrl = true) {
  currentCollection = collection;
  currentSlug = slug;

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

  // URL input change (allow manual URL entry)
  form.addEventListener('input', (e) => {
    if (e.target.matches('[data-url-input]')) {
      const picker = e.target.closest('.image-picker');
      const url = e.target.value;
      updateImagePickerFromUrl(picker, url);
      // Note: onChangeCallback is already triggered by auto-save
    }
  });
}

/**
 * Update image picker with new URL
 */
function updateImagePicker(picker, url) {
  const hiddenInput = picker.querySelector('.image-picker-input');
  const urlInput = picker.querySelector('[data-url-input]');
  const preview = picker.querySelector('[data-preview]');
  const previewImg = picker.querySelector('[data-preview-img]');
  const placeholder = picker.querySelector('[data-placeholder]');

  // Update values
  hiddenInput.value = url;
  urlInput.value = url;

  // Update preview visibility
  if (url && url.trim()) {
    previewImg.src = url;
    preview.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    preview.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }
}

/**
 * Update image picker from URL input (for manual entry)
 */
function updateImagePickerFromUrl(picker, url) {
  const hiddenInput = picker.querySelector('.image-picker-input');
  const preview = picker.querySelector('[data-preview]');
  const previewImg = picker.querySelector('[data-preview-img]');
  const placeholder = picker.querySelector('[data-placeholder]');

  // Update hidden input
  hiddenInput.value = url;

  // Update preview visibility
  if (url && url.trim()) {
    previewImg.src = url;
    preview.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    preview.classList.add('hidden');
    placeholder.classList.remove('hidden');
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

// Listen for scroll position updates from iframe
window.addEventListener('message', (event) => {
  if (event.data?.type === 'scrollPosition') {
    lastPreviewScrollY = event.data.scrollY;
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

  // Load entry from URL if present
  const entry = getEntryFromUrl();
  if (entry) {
    loadEntry(entry.collection, entry.slug, false);
  }
}

init();
