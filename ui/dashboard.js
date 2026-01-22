/**
 * Dashboard functionality - Shopify-style layout
 */

import { generateForm, extractFormData, setupFormHandlers } from './form-generator.js';
import { openImageLibrary, uploadNewImage } from './image-library.js';
import { openReferencePicker } from './reference-picker.js';
import { toggleChangesPanel, getChangesCount, showPublishDialog } from './changes-panel.js';
import { openGalleryEditor } from './gallery-editor.js';

let currentCollection = null;
let currentSlug = null;
let currentData = null;
let previewUrl = '';
let allPages = []; // Store all pages for dropdown
let allCollections = []; // Store collection info for new entries
let allStaticPages = []; // Store discovered static pages (virtual pages)
let isNewEntry = false; // Track if current entry is new (unsaved)
let isVirtualPage = false; // Track if current view is a virtual page
let selectedPreviewBlock = null; // For component preview: which block to render with

// i18n state
let i18nConfig = {
  enabled: false,
  defaultLocale: 'en',
  locales: ['en'],
};
let currentLocale = null; // Current locale being edited (null if i18n disabled)
let entryLocales = []; // Which locales exist for current entry

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

    // Load i18n config
    if (data.i18n) {
      i18nConfig = data.i18n;
      if (i18nConfig.enabled) {
        currentLocale = i18nConfig.defaultLocale;
      }
    }
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
      allStaticPages = data.pages || []; // Store discovered static pages

      // Update i18n config from collections response (authoritative source)
      if (data.i18n) {
        i18nConfig = data.i18n;
        if (i18nConfig.enabled && !currentLocale) {
          currentLocale = i18nConfig.defaultLocale;
        }
      }

      populatePageSelector(data.collections, data.i18n, allStaticPages);
    }
  } catch (error) {
    console.error('Failed to load collections:', error);
  }
}

// Populate page selector dropdown
function populatePageSelector(collections, i18nInfo = null, staticPages = []) {
  const selector = document.getElementById('pageSelector');
  const previousValue = selector.value; // Preserve selection if reloading
  selector.innerHTML = '<option value="">Select page...</option>';
  allPages = []; // Reset

  // Add "Pages" optgroup for virtual/static pages if any exist
  if (staticPages.length > 0) {
    const pagesOptgroup = document.createElement('optgroup');
    pagesOptgroup.label = 'Pages';

    staticPages.forEach(page => {
      const option = document.createElement('option');
      option.value = `__page__:${page.slug}`;
      option.textContent = page.name;
      pagesOptgroup.appendChild(option);
    });

    selector.appendChild(pagesOptgroup);
  }

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
  if (previousValue && !previousValue.startsWith('new:') && !previousValue.startsWith('__page__:')) {
    selector.value = previousValue;
  }
}

// Simple singularize function
function singularize(word) {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

// ============================================
// Locale Tab Functions (i18n)
// ============================================

/**
 * Render locale tabs in the editor header
 */
function renderLocaleTabs() {
  const container = document.getElementById('localeTabs');

  // Hide tabs if i18n disabled or only one locale
  if (!i18nConfig.enabled || i18nConfig.locales.length <= 1) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';

  container.innerHTML = i18nConfig.locales.map(locale => {
    const isActive = locale === currentLocale;
    const exists = entryLocales.includes(locale);
    const statusIcon = exists ? '' : ' <span class="locale-missing" title="Translation not yet created">+</span>';

    return `
      <button
        type="button"
        class="locale-tab ${isActive ? 'active' : ''} ${exists ? '' : 'locale-tab-missing'}"
        data-locale="${locale}"
      >
        ${locale.toUpperCase()}${statusIcon}
      </button>
    `;
  }).join('');
}

/**
 * Load which locales exist for an entry
 */
async function loadEntryLocales(collection, slug) {
  if (!i18nConfig.enabled) {
    entryLocales = [];
    return;
  }

  try {
    const response = await fetch(`/api/collections/${collection}/entries-with-locales`);
    const data = await response.json();

    if (data.success) {
      const entry = data.entries.find(e => e.slug === slug);
      entryLocales = entry?.locales || [];
    } else {
      entryLocales = [];
    }
  } catch (error) {
    console.error('Failed to load entry locales:', error);
    entryLocales = [];
  }
}

/**
 * Create a new translation for an existing entry
 */
async function createTranslation(collection, slug) {
  document.getElementById('editorTitle').textContent = `New Translation: ${slug} (${currentLocale.toUpperCase()})`;
  updateSaveStatus('New translation - unsaved');

  try {
    const schemaResponse = await fetch(`/api/collections/${collection}`);
    const schemaData = await schemaResponse.json();

    if (!schemaData.success) {
      throw new Error('Failed to load collection schema');
    }

    const contentType = schemaData.collection.type === 'data' ? 'data' : 'content';

    currentData = {
      data: {},
      body: '',
      type: contentType,
      schema: schemaData.collection.schema,
      locale: currentLocale,
    };

    renderEditorForNewEntry(schemaData.collection.schema, contentType);

  } catch (error) {
    console.error('Failed to create translation:', error);
    document.getElementById('editorForm').innerHTML = `
      <p class="text-red-500">Failed to initialize: ${error.message}</p>
    `;
  }
}

// ============================================
// Preview Block Selector (for component preview)
// ============================================

/**
 * Render the block selector dropdown for component preview.
 * Only shown when a non-page collection has multiple blocks that use it.
 */
function renderBlockSelector() {
  const container = document.getElementById('previewBlockSelector');
  if (!container) return;

  // Only show for non-page collections
  if (currentCollection === 'pages') {
    container.style.display = 'none';
    return;
  }

  const collection = allCollections.find(c => c.name === currentCollection);
  const usedByBlocks = collection?.usedByBlocks || [];

  // Hide if no blocks use this collection or only one block
  if (usedByBlocks.length <= 1) {
    container.style.display = 'none';
    return;
  }

  // Show selector with block options
  container.style.display = 'flex';

  const select = document.getElementById('blockSelectorDropdown');
  if (!select) return;

  select.innerHTML = usedByBlocks.map(block => {
    const label = formatBlockLabel(block.type);
    return `<option value="${block.type}">${label}</option>`;
  }).join('');

  // Set current selection
  if (selectedPreviewBlock) {
    select.value = selectedPreviewBlock;
  }
}

/**
 * Format block type as a readable label.
 * e.g., 'testimonials' -> 'Testimonials Block'
 */
function formatBlockLabel(type) {
  return type.charAt(0).toUpperCase() + type.slice(1) + ' Block';
}

// Block selector change handler
document.getElementById('blockSelectorDropdown')?.addEventListener('change', (e) => {
  selectedPreviewBlock = e.target.value;
  updatePreview();
});

// Locale tab click handler
document.getElementById('localeTabs').addEventListener('click', async (e) => {
  const tab = e.target.closest('.locale-tab');
  if (!tab) return;

  const newLocale = tab.dataset.locale;
  if (newLocale === currentLocale) return;

  currentLocale = newLocale;
  renderLocaleTabs();

  // Reload entry for new locale
  if (currentCollection && currentSlug) {
    await loadEntry(currentCollection, currentSlug, false);
  }
});

// Handle page selector change
document.getElementById('pageSelector').addEventListener('change', (e) => {
  const value = e.target.value;
  if (!value) return;

  if (value.startsWith('__page__:')) {
    // Virtual page selected
    const pageSlug = value.split(':')[1];
    loadVirtualPage(pageSlug);
  } else if (value.startsWith('new:')) {
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
  // Reset preview block selection when switching collections
  if (collection !== currentCollection) {
    selectedPreviewBlock = null;
  }

  currentCollection = collection;
  currentSlug = slug;
  isNewEntry = false; // Loading existing entry
  isVirtualPage = false; // Not a virtual page

  // Update URL without page reload
  if (updateUrl) {
    const newUrl = `/dashboard/${collection}/${slug}`;
    history.pushState({ collection, slug }, '', newUrl);
  }

  // Update dropdown to match
  const selector = document.getElementById('pageSelector');
  selector.value = `${collection}/${slug}`;

  // Fetch available locales for this entry (if i18n enabled)
  if (i18nConfig.enabled) {
    await loadEntryLocales(collection, slug);
    renderLocaleTabs();
  }

  const localeLabel = i18nConfig.enabled && currentLocale ? ` (${currentLocale.toUpperCase()})` : '';
  document.getElementById('editorTitle').textContent = `Editing: ${slug}${localeLabel}`;
  document.getElementById('editorForm').innerHTML = '<p class="placeholder-text">Loading...</p>';
  document.getElementById('deleteEntryBtn').style.display = 'inline-block';

  try {
    // Build URL with locale query param if i18n enabled
    let apiUrl = `/api/content/${collection}/${slug}`;
    if (i18nConfig.enabled && currentLocale) {
      apiUrl += `?locale=${currentLocale}`;
    }

    const response = await fetch(apiUrl);
    const data = await response.json();

    if (data.success) {
      currentData = data;
      renderEditor(data);
      renderBlockSelector(); // Show block selector for component preview
      updatePreview();
    } else if (response.status === 404 && i18nConfig.enabled) {
      // Entry doesn't exist for this locale - show empty form for new translation
      isNewEntry = true;
      await createTranslation(collection, slug);
    }
  } catch (error) {
    console.error('Failed to load entry:', error);
    document.getElementById('editorForm').innerHTML = `
      <p class="text-red-500">Failed to load entry: ${error.message}</p>
    `;
  }
}

// ============================================
// Virtual Page Functions
// ============================================

/**
 * Load a virtual page (static .astro/.md/.mdx page from src/pages)
 * Shows a navigation hub instead of an editor form
 */
function loadVirtualPage(pageSlug) {
  const page = allStaticPages.find(p => p.slug === pageSlug);
  if (!page) {
    console.error('Virtual page not found:', pageSlug);
    return;
  }

  // Reset state
  currentCollection = null;
  currentSlug = null;
  currentData = null;
  isNewEntry = false;
  isVirtualPage = true;

  // Update URL
  const newUrl = `/dashboard/__page__/${pageSlug}`;
  history.pushState({ virtualPage: pageSlug }, '', newUrl);

  // Update UI
  document.getElementById('editorTitle').textContent = page.name;
  document.getElementById('deleteEntryBtn').style.display = 'none';
  document.getElementById('localeTabs').style.display = 'none';

  // Hide block selector
  const blockSelector = document.getElementById('previewBlockSelector');
  if (blockSelector) {
    blockSelector.style.display = 'none';
  }

  // Render virtual page panel
  renderVirtualPagePanel(page);

  // Update preview to show the page
  updateVirtualPagePreview(page);
}

/**
 * Render the virtual page info panel
 */
function renderVirtualPagePanel(page) {
  const editorForm = document.getElementById('editorForm');

  // Build collection links if any
  let collectionsHtml = '';
  if (page.collections && page.collections.length > 0) {
    const collectionLinks = page.collections.map(collectionName => {
      const collection = allCollections.find(c => c.name === collectionName);
      const label = collectionName.charAt(0).toUpperCase() + collectionName.slice(1);
      const entryCount = collection?.entries?.length || 0;

      return `
        <button type="button" class="collection-link" data-collection="${collectionName}">
          ${label}
          <span class="collection-link-count">${entryCount}</span>
        </button>
      `;
    }).join('');

    collectionsHtml = `
      <div class="virtual-page-collections">
        <h4>Uses Collections</h4>
        <div class="collection-links">
          ${collectionLinks}
        </div>
      </div>
    `;
  } else {
    collectionsHtml = `
      <div class="virtual-page-collections">
        <p class="virtual-page-no-collections">This page doesn't reference any content collections.</p>
      </div>
    `;
  }

  editorForm.innerHTML = `
    <div class="virtual-page-info">
      <p class="virtual-page-notice">
        This is a template page. For inline editing, see the <a href="https://github.com/cloudship-dev/astroadmin/blob/main/docs/inline-editing.md" target="_blank" rel="noopener">conversion guide</a>.
      </p>
      <div class="virtual-page-details">
        <div class="virtual-page-detail">
          <span class="virtual-page-detail-label">File</span>
          <code>${page.path}</code>
        </div>
        <div class="virtual-page-detail">
          <span class="virtual-page-detail-label">URL</span>
          <code>${page.url}</code>
        </div>
      </div>
      ${collectionsHtml}
    </div>
  `;

  // Setup collection link click handlers
  editorForm.querySelectorAll('.collection-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const collectionName = btn.dataset.collection;
      navigateToCollection(collectionName);
    });
  });
}

/**
 * Navigate to a collection (load first entry or show new entry form)
 */
function navigateToCollection(collectionName) {
  const collection = allCollections.find(c => c.name === collectionName);
  if (!collection) return;

  isVirtualPage = false;

  if (collection.entries && collection.entries.length > 0) {
    // Load first entry
    const firstEntry = collection.entries[0];
    document.getElementById('pageSelector').value = `${collectionName}/${firstEntry}`;
    loadEntry(collectionName, firstEntry);
  } else {
    // No entries - open new entry modal
    openNewItemModal(collectionName);
  }
}

/**
 * Update preview iframe for virtual page
 */
function updateVirtualPagePreview(page) {
  const iframe = document.getElementById('previewFrame');
  const placeholder = document.getElementById('previewPlaceholder');
  const previewControls = document.getElementById('previewControls');

  if (!previewUrl) {
    return;
  }

  // Build the preview URL
  const pageUrl = `${previewUrl}${page.url}`;

  // Show preview and controls
  iframe.style.display = 'block';
  placeholder.style.display = 'none';
  previewControls.style.display = 'flex';

  // Load the page in iframe
  iframe.classList.add('loading');

  const onLoad = () => {
    iframe.removeEventListener('load', onLoad);
    iframe.classList.remove('loading');
  };
  iframe.addEventListener('load', onLoad);

  const newUrl = pageUrl + '?t=' + Date.now();
  if (iframe.contentWindow) {
    iframe.contentWindow.location.replace(newUrl);
  } else {
    iframe.src = newUrl;
  }
}

// Parse URL to get collection/slug
function getEntryFromUrl() {
  const path = window.location.pathname;

  // Check for virtual page URL pattern
  const virtualMatch = path.match(/^\/dashboard\/__page__\/(.+)$/);
  if (virtualMatch) {
    return { virtualPage: virtualMatch[1] };
  }

  const match = path.match(/^\/dashboard\/([^/]+)\/(.+)$/);
  if (match) {
    return { collection: match[1], slug: match[2] };
  }
  return null;
}

// Handle browser back/forward
window.addEventListener('popstate', (e) => {
  if (e.state?.virtualPage) {
    loadVirtualPage(e.state.virtualPage);
  } else if (e.state?.collection && e.state?.slug) {
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
  const bodyContent = entryData.body || '';
  const bodyLineCount = (bodyContent.match(/\n/g) || []).length + 1;
  const bodyCharRows = Math.ceil(bodyContent.length / 60);
  const bodyRows = Math.max(8, Math.min(20, Math.max(bodyLineCount, bodyCharRows)));
  const bodyEditor = (entryData.type === 'content' && !hasBlocks) ? `
    <div class="form-group">
      <label for="markdown-body" class="form-label">Content (Markdown)</label>
      <div class="textarea-wrapper">
        <textarea
          id="markdown-body"
          name="body"
          rows="${bodyRows}"
          class="form-input textarea-autogrow"
          placeholder="Enter markdown content..."
          data-markdown="true"
        >${bodyContent}</textarea>
        <button type="button" class="textarea-expand-btn" data-expand-textarea="markdown-body" title="Expand editor">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 3 21 3 21 9"></polyline>
            <polyline points="9 21 3 21 3 15"></polyline>
            <line x1="21" y1="3" x2="14" y2="10"></line>
            <line x1="3" y1="21" x2="10" y2="14"></line>
          </svg>
        </button>
      </div>
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

    // Gallery edit button
    if (e.target.matches('[data-edit-gallery]')) {
      const fieldPath = e.target.dataset.editGallery;
      const galleryField = e.target.closest('.gallery-field');
      const currentValue = decodeGalleryValue(galleryField.dataset.galleryValue);

      openGalleryEditor(currentValue, (newImages) => {
        // Update the stored value (encoded)
        galleryField.dataset.galleryValue = btoa(encodeURIComponent(JSON.stringify(newImages)));

        // Update the preview
        updateGalleryFieldPreview(galleryField, newImages);

        if (onChangeCallback) onChangeCallback();
      });
      return;
    }
  });

}

/**
 * Decode gallery value from base64-encoded JSON
 */
function decodeGalleryValue(encoded) {
  if (!encoded) return [];
  try {
    return JSON.parse(decodeURIComponent(atob(encoded)));
  } catch (e) {
    console.error('Failed to decode gallery value:', e);
    return [];
  }
}

/**
 * Update gallery field preview after editing
 */
function updateGalleryFieldPreview(galleryField, images) {
  const preview = galleryField.querySelector('.gallery-field-preview');
  const editBtn = galleryField.querySelector('.gallery-field-edit');
  const previewImages = images.slice(0, 6);
  const moreCount = images.length - 6;

  preview.innerHTML = previewImages.length > 0
    ? previewImages.map(img => `
        <div class="gallery-field-thumb">
          <img src="${img.src || ''}" alt="">
        </div>
      `).join('') + (moreCount > 0 ? `<div class="gallery-field-more">+${moreCount}</div>` : '')
    : '<span class="gallery-field-empty">No images</span>';

  editBtn.textContent = images.length > 0 ? `Edit ${images.length} images` : 'Add images';
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

  // Reload previews after drag-drop reordering
  form.addEventListener('reference-reorder', (e) => {
    const referenceField = e.target.closest('.reference-field');
    if (referenceField) {
      loadReferenceFieldPreviews(referenceField);
    }
  });

  form.addEventListener('click', (e) => {
    // Add reference item button
    if (e.target.matches('.add-reference-item')) {
      const referenceField = e.target.closest('.reference-field');
      const collectionName = e.target.dataset.collection;
      const fieldPath = e.target.dataset.field;

      // Get currently selected IDs to exclude from picker
      const existingItems = referenceField.querySelectorAll('.reference-card');
      const excludeIds = Array.from(existingItems).map(item => item.dataset.id);

      openReferencePicker(collectionName, (selectedId, selectedData) => {
        addReferenceItem(referenceField, fieldPath, selectedId, selectedData);
        if (onChangeCallback) onChangeCallback();
      }, excludeIds);
      return;
    }

    // Click on existing reference item to change it
    if (e.target.closest('.edit-reference-item')) {
      const item = e.target.closest('.reference-card');
      const referenceField = e.target.closest('.reference-field');
      const collectionName = referenceField.dataset.collection;
      const fieldPath = referenceField.dataset.field;
      const currentId = item.dataset.id;

      // Get all OTHER selected IDs to exclude (not the current one being edited)
      const existingItems = referenceField.querySelectorAll('.reference-card');
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

    // Edit the referenced item (navigate to it)
    if (e.target.closest('.open-reference-editor')) {
      const item = e.target.closest('.reference-card');
      const referenceField = e.target.closest('.reference-field');
      const collectionName = referenceField.dataset.collection;
      const itemId = item.dataset.id;

      // Navigate to edit the referenced item
      loadEntry(collectionName, itemId);
      return;
    }

    // Remove reference item button
    if (e.target.closest('.remove-reference-item')) {
      const item = e.target.closest('.reference-card');
      const referenceField = e.target.closest('.reference-field');
      item.remove();
      reindexReferenceItems(referenceField);

      // Show empty message if no items left
      const items = referenceField.querySelectorAll('.reference-card');
      if (items.length === 0) {
        const itemsContainer = referenceField.querySelector('.reference-cards');
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
    await loadReferenceFieldPreviews(field);
  }
}

/**
 * Load preview data for a single reference field
 */
async function loadReferenceFieldPreviews(field) {
  const collectionName = field.dataset.collection;
  if (!collectionName) return;

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
      const items = field.querySelectorAll('.reference-card');
      for (const item of items) {
        const itemId = item.dataset.id;
        const entry = entriesMap[itemId];

        const titleEl = item.querySelector('.reference-card-title');
        const previewEl = item.querySelector('.reference-card-preview');

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

/**
 * Add a reference item to the field
 */
function addReferenceItem(referenceField, fieldPath, itemId, itemData = null) {
  const itemsContainer = referenceField.querySelector('.reference-cards');

  // Remove empty message if present
  const emptyMsg = itemsContainer.querySelector('.reference-empty');
  if (emptyMsg) emptyMsg.remove();

  const index = itemsContainer.querySelectorAll('.reference-card').length;
  const title = itemData?.title || itemId;
  const preview = itemData?.preview || '';

  const newItem = document.createElement('div');
  newItem.className = 'reference-card';
  newItem.dataset.index = index;
  newItem.dataset.id = itemId;
  newItem.draggable = true;
  newItem.innerHTML = `
    <div class="reference-card-handle" title="Drag to reorder">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="9" cy="5" r="2"/><circle cx="15" cy="5" r="2"/>
        <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
        <circle cx="9" cy="19" r="2"/><circle cx="15" cy="19" r="2"/>
      </svg>
    </div>
    <input type="hidden" name="${fieldPath}[${index}]" value="${escapeHtml(itemId)}">
    <div class="reference-card-content edit-reference-item" title="Click to change">
      <div class="reference-card-title">${escapeHtml(title)}</div>
      <div class="reference-card-preview">${escapeHtml(preview)}</div>
    </div>
    <div class="reference-card-actions">
      <button type="button" class="reference-card-btn reference-card-edit open-reference-editor" title="Edit">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <button type="button" class="reference-card-btn reference-card-delete remove-reference-item" title="Remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    </div>
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

  const titleEl = item.querySelector('.reference-card-title');
  if (titleEl) titleEl.textContent = title;

  const previewEl = item.querySelector('.reference-card-preview');
  if (previewEl) previewEl.textContent = preview;
}

/**
 * Reindex reference items after removal
 */
function reindexReferenceItems(referenceField) {
  const fieldPath = referenceField.dataset.field;
  const items = referenceField.querySelectorAll('.reference-card');

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

// Setup block focus - clicking a block header scrolls to it in the preview
function setupBlockFocus() {
  const blocksList = document.querySelector('.blocks-list');
  if (!blocksList) {
    console.log('[AstroAdmin] No .blocks-list found for focus handler');
    return;
  }

  blocksList.addEventListener('click', (e) => {
    // Only trigger on header clicks (not on form fields inside the block)
    const header = e.target.closest('.block-header');
    if (!header) return;

    const blockItem = e.target.closest('.block-item');
    if (!blockItem) return;

    const index = blockItem.dataset.index;
    const blockType = blockItem.dataset.type;

    // Don't focus SEO blocks (they're not rendered)
    if (blockType === 'seo') return;

    // Send message to iframe to focus this block/element
    const iframe = document.getElementById('previewFrame');
    if (iframe?.contentWindow) {
      console.log('[AstroAdmin] Focusing block:', { index, blockType });
      iframe.contentWindow.postMessage({
        type: 'focusBlock',
        index: parseInt(index),
        blockType: blockType
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
  // Show loading overlay early (500ms) for immediate visual feedback
  const showLoadingEarly = debounce(() => {
    const iframe = document.getElementById('previewFrame');
    if (iframe) {
      iframe.classList.add('loading');
    }
  }, 500);

  form.addEventListener('input', () => {
    showLoadingEarly();
    debouncedSave();
  });

  // Immediate save for structural changes (reordering cards)
  form.addEventListener('cards-reordered', async () => {
    updateSaveStatus('Saving...');
    await saveContent(true);
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

  // Extract form data
  const formData = extractFormData(form);
  const body = document.getElementById('markdown-body')?.value || '';

  // Capture current preview HTML hash BEFORE save (for change detection)
  let originalHash = null;
  const previewPageUrl = getPreviewPageUrl();
  if (previewPageUrl) {
    try {
      const response = await fetch(previewPageUrl + '?t=' + Date.now(), { cache: 'no-store' });
      const html = await response.text();
      originalHash = quickHash(html);
    } catch (err) { /* proceed without hash */ }
  }

  try {
    // Build URL with locale query param if i18n enabled
    let apiUrl = `/api/content/${currentCollection}/${currentSlug}`;
    if (i18nConfig.enabled && currentLocale) {
      apiUrl += `?locale=${currentLocale}`;
    }

    const response = await fetch(apiUrl, {
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

      // Handle first save of new entry/translation
      if (isNewEntry) {
        isNewEntry = false;
        const localeLabel = i18nConfig.enabled && currentLocale ? ` (${currentLocale.toUpperCase()})` : '';
        document.getElementById('editorTitle').textContent = `Editing: ${currentSlug}${localeLabel}`;
        // Refresh dropdown to include the new entry
        await loadPages();
        // Select the new entry in dropdown
        document.getElementById('pageSelector').value = `${currentCollection}/${currentSlug}`;

        // Refresh entry locales after save (new locale now exists)
        if (i18nConfig.enabled) {
          await loadEntryLocales(currentCollection, currentSlug);
          renderLocaleTabs();
        }
      }

      // Update changes badge
      updateChangesBadge();

      // Wait for Astro to rebuild, then refresh preview
      // Note: HMR causes 2-3 white flashes due to Vite parallel environments bug
      // See: https://github.com/withastro/astro/issues/13138
      if (originalHash) {
        await waitForContentChange(originalHash);
      }
      // WORKAROUND: Additional delay for Astro/Vite rebuild reliability
      // Astro's dev server sometimes needs extra time after content change is detected.
      // This may be fixed in future Astro versions. See: https://github.com/withastro/astro/issues/13138
      await new Promise(r => setTimeout(r, 2000));
      updatePreview();
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
  }
}

// Store scroll position (received from iframe via postMessage)
let lastPreviewScrollY = 0;

// Simple hash function for change detection
function quickHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

// Get current preview page URL
function getPreviewPageUrl() {
  if (!previewUrl) return null;

  const isDefaultLocale = !i18nConfig.enabled || currentLocale === i18nConfig.defaultLocale;
  const localePrefix = isDefaultLocale ? '' : `/${currentLocale}`;

  // Pages collection uses direct URL preview
  if (currentCollection === 'pages') {
    if (currentSlug === 'home') {
      return isDefaultLocale ? `${previewUrl}/` : `${previewUrl}${localePrefix}`;
    }
    return `${previewUrl}${localePrefix}/${currentSlug}`;
  }

  // Check if collection has a preview route (auto-detected or user-configured)
  const collection = allCollections.find(c => c.name === currentCollection);

  if (collection?.previewRoute) {
    // Replace {slug} placeholder with actual slug
    const routePath = collection.previewRoute.replace('{slug}', currentSlug);
    return `${previewUrl}${localePrefix}${routePath}`;
  }

  // Fall back to component preview if available (usedByBlocks)
  const usedByBlocks = collection?.usedByBlocks || [];

  if (usedByBlocks.length > 0) {
    // Use selected block or default to first one
    const blockType = selectedPreviewBlock || usedByBlocks[0].type;
    return `${previewUrl}/component-preview/${blockType}/${currentSlug}`;
  }

  // No preview available for this collection
  return null;
}

// Wait for content to actually change before refreshing preview
// Polls until HTML hash changes or timeout (2.5s)
async function waitForContentChange(originalHash, maxWaitMs = 2500) {
  const pageUrl = getPreviewPageUrl();
  if (!pageUrl || !originalHash) return { changed: false, waited: 0 };

  const startTime = Date.now();
  let pollDelay = 150;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollDelay));

    try {
      const response = await fetch(pageUrl + '?t=' + Date.now(), {
        cache: 'no-store'
      });
      const html = await response.text();
      const newHash = quickHash(html);

      if (newHash !== originalHash) {
        console.log(`[Preview] Content changed after ${Date.now() - startTime}ms`);
        return { changed: true, waited: Date.now() - startTime };
      }
    } catch (err) { /* keep polling */ }

    pollDelay = Math.min(pollDelay * 1.3, 400); // gentle exponential backoff
  }

  console.log('[Preview] Timeout waiting for content change, refreshing anyway');
  return { changed: false, waited: maxWaitMs };
}

// Listen for messages from preview iframe
window.addEventListener('message', (event) => {
  if (event.data?.type === 'scrollPosition') {
    lastPreviewScrollY = event.data.scrollY;
  }
  // Handle page navigation in preview - sync admin to show that page
  if (event.data?.type === 'pageNavigation') {
    const pathname = event.data.pathname;

    // Ignore component-preview URLs - these are for non-page collections
    if (pathname.startsWith('/component-preview/')) {
      return;
    }

    // Map pathname to collection/slug (only for pages collection)
    // e.g., "/" -> pages/home, "/teaching" -> pages/teaching
    let slug = pathname === '/' ? 'home' : pathname.replace(/^\/|\/$/g, '');
    // Only switch if it's a different page and we're in pages collection
    if (slug && slug !== currentSlug && currentCollection === 'pages') {
      loadEntry('pages', slug, true);
    }
  }
});

// Update preview
async function updatePreview() {
  const iframe = document.getElementById('previewFrame');
  const placeholder = document.getElementById('previewPlaceholder');
  const previewControls = document.getElementById('previewControls');

  const pageUrl = getPreviewPageUrl();
  if (!pageUrl) {
    return;
  }

  // Show preview and controls
  iframe.style.display = 'block';
  placeholder.style.display = 'none';
  previewControls.style.display = 'flex';

  // Save current scroll position before reload
  const scrollToRestore = lastPreviewScrollY;

  // Add loading state for subtle visual feedback
  iframe.classList.add('loading');

  // Force iframe reload
  const newUrl = pageUrl + '?t=' + Date.now();

  // Listen for load to restore scroll position
  let loadHandled = false;
  const onLoad = () => {
    if (loadHandled) return;
    loadHandled = true;
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

  // Safety timeout: remove loading class after 10s if load event doesn't fire
  setTimeout(() => {
    if (!loadHandled) {
      loadHandled = true;
      iframe.removeEventListener('load', onLoad);
      iframe.classList.remove('loading');
      console.warn('Preview load timeout - removed loading state');
    }
  }, 10000);

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

  const localeLabel = i18nConfig.enabled && currentLocale ? ` (${currentLocale.toUpperCase()})` : '';
  const deleteMessage = i18nConfig.enabled && currentLocale
    ? `Are you sure you want to delete the ${currentLocale.toUpperCase()} translation of "${currentSlug}"?\n\nThis cannot be undone.`
    : `Are you sure you want to delete "${currentSlug}" from ${currentCollection}?\n\nThis cannot be undone.`;

  const confirmed = confirm(deleteMessage);
  if (!confirmed) return;

  try {
    // Build URL with locale query param if i18n enabled
    let apiUrl = `/api/content/${currentCollection}/${currentSlug}`;
    if (i18nConfig.enabled && currentLocale) {
      apiUrl += `?locale=${currentLocale}`;
    }

    const response = await fetch(apiUrl, {
      method: 'DELETE',
    });

    const result = await response.json();

    if (result.success) {
      showNotification(`Deleted "${currentSlug}"${localeLabel}`, 'success');

      // Refresh the page list
      await loadPages();

      // Clear the editor
      currentCollection = null;
      currentSlug = null;
      currentData = null;
      document.getElementById('editorTitle').textContent = 'Select a page to edit';
      document.getElementById('editorForm').innerHTML = '<p class="placeholder-text">Choose a page from the dropdown above to start editing.</p>';
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

// Publish changes
document.getElementById('publishBtn').addEventListener('click', async () => {
  const message = await showPublishDialog();
  if (message === null) return; // User cancelled

  const publishBtn = document.getElementById('publishBtn');
  const originalText = publishBtn.textContent;
  publishBtn.textContent = 'Publishing...';
  publishBtn.disabled = true;

  try {
    const response = await fetch('/api/git/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message || undefined }),
    });

    const result = await response.json();

    if (result.success) {
      showNotification(result.message, 'success');
      updateChangesBadge();
    } else {
      showNotification('Failed to publish: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('Publish failed:', error);
    showNotification('Failed to publish', 'error');
  } finally {
    publishBtn.textContent = originalText;
    publishBtn.disabled = false;
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

// Panel Resizer functionality
function initPanelResizer() {
  const resizer = document.getElementById('panelResizer');
  const editorPanel = document.querySelector('.editor-panel');

  if (!resizer || !editorPanel) return;

  // Load saved width from localStorage
  const savedWidth = localStorage.getItem('astroadmin-editor-width');
  if (savedWidth) {
    editorPanel.style.setProperty('--editor-width', savedWidth);
  }

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = editorPanel.offsetWidth;

    document.body.classList.add('resizing');
    resizer.classList.add('dragging');

    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const deltaX = e.clientX - startX;
    const newWidth = Math.max(300, Math.min(startWidth + deltaX, window.innerWidth * 0.6));

    editorPanel.style.setProperty('--editor-width', `${newWidth}px`);
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;

    isResizing = false;
    document.body.classList.remove('resizing');
    resizer.classList.remove('dragging');

    // Save width to localStorage
    const currentWidth = editorPanel.style.getPropertyValue('--editor-width');
    if (currentWidth) {
      localStorage.setItem('astroadmin-editor-width', currentWidth);
    }
  });
}

// Initialize
async function init() {
  await checkAuth();
  await loadConfig();
  await loadPages();

  // Initialize panel resizer
  initPanelResizer();

  // Update changes badge
  updateChangesBadge();

  // Load entry from URL if present, otherwise auto-select first page/virtual page
  const entry = getEntryFromUrl();
  if (entry?.virtualPage) {
    // Virtual page from URL
    loadVirtualPage(entry.virtualPage);
  } else if (entry?.collection && entry?.slug) {
    loadEntry(entry.collection, entry.slug, false);
  } else {
    // Auto-select first virtual page (if any), or first content entry
    const firstVirtualPage = allStaticPages[0];
    if (firstVirtualPage) {
      loadVirtualPage(firstVirtualPage.slug);
    } else {
      // Fall back to content entries
      const homePage = allPages.find(p => p.collection === 'pages' && p.slug === 'home');
      const firstPage = homePage || allPages.find(p => p.collection === 'pages') || allPages[0];

      if (firstPage) {
        loadEntry(firstPage.collection, firstPage.slug, true);
      }
    }
  }
}

init();
