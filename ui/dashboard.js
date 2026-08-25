/**
 * Dashboard functionality - Shopify-style layout
 */

import { generateForm, extractFormData, setupFormHandlers } from './form-generator.js';
import { resolvePreviewTarget } from './preview-routes.js';
import { registerReferenceFieldHandlers } from './field-widgets.js';
import { openReferencePicker } from './reference-picker.js';
import { toggleChangesPanel, getChangesCount, showPublishDialog } from './changes-panel.js';
import { initEntryPicker, syncEntryPickerLabel } from './entry-picker.js';

import { escapeHtml } from './escape-html.js';

// Reference fields can appear anywhere a field can — including inside the array item
// modal — so hand their wiring to the shared field layer rather than binding it to
// the main form here. setupFieldWidgets applies it to every container it sets up.
registerReferenceFieldHandlers(setupReferencePickers);

let currentCollection = null;
let currentSlug = null;
let currentData = null;
let previewUrl = '';
let publicUrl = ''; // Production site origin (optional); enables the live-status check
let allPages = []; // Store all pages for dropdown
let allCollections = []; // Store collection info for new entries
let allStaticPages = []; // Store discovered static pages (virtual pages)
let isNewEntry = false; // Track if current entry is new (unsaved)
let isVirtualPage = false; // Track if current view is a virtual page
let selectedPreviewBlock = null; // For component preview: which block to render with
let gitEnabled = true; // Whether git integration is enabled (from /api/config)
// Collection group order for the entry picker (from /api/config). Empty until
// loadConfig() resolves, which init() awaits before loadPages() builds the list.
let collectionOrder = [];

// Monotonic id for the in-flight entry load. A slower earlier load must not
// overwrite a newer selection when its response arrives out of order.
let loadSeq = 0;
// The save function and its debounced wrapper for the form currently on screen.
// Each is bound to ITS form + immutable target, so a navigation can flush the
// pending edit (it saves that entry, not the next one), and saves for a target
// are serialized so an older POST can't overwrite a newer one.
let activeSaver = null;
let activeDebouncedSave = null;
// Guards the delete handler against a double-click firing two DELETEs.
let deleteInProgress = false;

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
    publicUrl = data.publicUrl || '';
    gitEnabled = data.gitEnabled !== false;
    if (Array.isArray(data.collectionOrder)) collectionOrder = data.collectionOrder;

    // Content lives in the database, so the git-history "Changes" panel only
    // makes sense when git is enabled. Hide it otherwise (publish still works
    // via /api/publish).
    if (!gitEnabled) {
      const changesBtn = document.getElementById('changesBtn');
      if (changesBtn) changesBtn.style.display = 'none';
    }

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

  // Read-only "virtual page" routes are deliberately NOT surfaced in the picker.
  // A page a user can reach should be editable; the fix for a route with a
  // hardcoded heading is to back it with a content entry, not to offer a
  // read-only dead-end. (`allStaticPages` is still kept for preview-URL
  // resolution and any legacy /dashboard/__page__/ deep link.)

  // Group order comes from config (`collectionOrder`). Anything unlisted sorts
  // after the listed names, keeping its natural order — Array.sort is stable, so
  // equal ranks are left alone.
  const rank = (name) => {
    const i = collectionOrder.indexOf(name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sortedCollections = [...collections].sort((a, b) => rank(a.name) - rank(b.name));

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
      // Show the entry's title (e.g. "Journal") rather than its slug ("blog").
      // The slug is kept as the option value and in `allPages` for URL matching.
      option.textContent = collection.entryTitles?.[slug] || slug;
      optgroup.appendChild(option);

      // Store for reference
      allPages.push({ collection: collection.name, slug });
    });

    selector.appendChild(optgroup);
  });

  // Restore previous selection if it still exists
  if (previousValue && !previousValue.startsWith('new:') && !previousValue.startsWith('__page__:')) {
    selector.value = previousValue;
    syncEntryPickerLabel(document.getElementById('pageSelector'));
  }
}

/**
 * Display title for an entry, matching what the page selector shows (e.g.
 * "Journal" for the entry whose slug is "blog"). Falls back to the slug when no
 * title is known, so the editor header and the selector never disagree.
 */
function entryDisplayTitle(collection, slug) {
  const entryTitles = allCollections.find(c => c.name === collection)?.entryTitles;
  return entryTitles?.[slug] || slug;
}

/**
 * After a save, keep the cached display title in step with the saved data, so an
 * edited title shows in the picker/header immediately rather than after a reload.
 * Mirrors the server's title extraction (title/name/heading).
 */
function updateEntryTitleCache(collection, slug, data) {
  const coll = allCollections.find(c => c.name === collection);
  if (!coll || !coll.entryTitles) return;
  // Mirror the server's fallback (title/name/heading, else a humanised slug) so
  // clearing every title field doesn't leave the old label until a reload.
  const title = data?.title || data?.name || data?.heading || humaniseSlug(slug);
  coll.entryTitles[slug] = title;
  const selector = document.getElementById('pageSelector');
  const option = [...selector.options].find(o => o.value === `${collection}/${slug}`);
  if (option) option.textContent = title;
}

/** Humanise a slug for display, matching the server's title fallback. */
function humaniseSlug(slug) {
  const s = String(slug).replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  if (!i18nConfig.enabled) return [];

  try {
    const response = await fetch(`/api/collections/${collection}/entries-with-locales`);
    const data = await response.json();
    if (data.success) {
      const entry = data.entries.find(e => e.slug === slug);
      return entry?.locales || [];
    }
    return [];
  } catch (error) {
    console.error('Failed to load entry locales:', error);
    return [];
  }
}

/**
 * Create a new translation for an existing entry
 */
async function createTranslation(collection, slug, ctx) {
  document.getElementById('editorTitle').textContent = `New Translation: ${slug} (${currentLocale.toUpperCase()})`;
  updateSaveStatus('New translation - unsaved');

  try {
    const schemaResponse = await fetch(`/api/collections/${collection}`);
    const schemaData = await schemaResponse.json();
    if (ctx && ctx.myLoad !== loadSeq) return; // superseded during the schema fetch

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

    renderEditorForNewEntry(schemaData.collection.schema, contentType, {
      collection, slug, locale: currentLocale,
    });

  } catch (error) {
    console.error('Failed to create translation:', error);
    if (ctx && ctx.myLoad !== loadSeq) return;
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

// Replace the long native selector with a searchable modal picker. The <select>
// stays as the hidden source of truth; the picker drives it. Registered after
// the change handler above so a picked row's dispatched `change` is handled.
initEntryPicker(document.getElementById('pageSelector'));

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
  flushPendingSave();
  const myLoad = ++loadSeq; // claim, so a pending entry load can't overwrite this form
  currentCollection = collection;
  currentSlug = slug;
  isNewEntry = true;

  // Update URL
  const newUrl = `/dashboard/${collection}/${slug}`;
  history.pushState({ collection, slug }, '', newUrl);

  // Update dropdown (won't find the new item yet, that's OK)
  const selector = document.getElementById('pageSelector');
  selector.value = '';
  syncEntryPickerLabel(document.getElementById('pageSelector'));

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

    if (myLoad !== loadSeq) return; // superseded by a newer selection

    // Determine content type based on collection
    const contentType = schemaData.collection.type === 'data' ? 'data' : 'content';

    // Initialize currentData with empty content
    currentData = {
      data: {},
      body: '',
      type: contentType,
      schema: schemaData.collection.schema
    };

    // Render empty editor, bound to this new entry.
    renderEditorForNewEntry(schemaData.collection.schema, contentType, {
      collection, slug, locale: currentLocale,
    });

  } catch (error) {
    console.error('Failed to create new entry:', error);
    if (myLoad !== loadSeq) return;
    document.getElementById('editorForm').innerHTML = `
      <p class="text-red-500">Failed to initialize: ${error.message}</p>
    `;
  }
}

// Render editor for a new entry (with empty data)
function renderEditorForNewEntry(schema, contentType, ctx) {
  const editorForm = document.getElementById('editorForm');

  // Generate form from schema with empty data
  const formHtml = generateForm(schema, {});

  // Only show markdown body editor for content types that DON'T use blocks.
  // Markup matches the edit view (wrapper + data-markdown) so the formatting
  // toolbar (setupFieldWidgets → enhanceMarkdownEditor) attaches here too.
  const hasBlocks = schema?.properties?.blocks;
  const bodyEditor = (contentType === 'content' && !hasBlocks) ? `
    <div class="form-group">
      <label for="markdown-body" class="form-label">Content (Markdown)</label>
      <div class="textarea-wrapper">
        <textarea
          id="markdown-body"
          data-content-field="body"
          rows="8"
          class="form-input textarea-autogrow"
          placeholder="Enter markdown content..."
          data-markdown="true"
        ></textarea>
        <button type="button" class="textarea-expand-btn" data-expand-textarea title="Expand editor">
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

  // Setup form handlers, bound to a saver for this NEW entry.
  const form = document.getElementById('contentForm');
  installSaver(form, {
    form,
    collection: ctx.collection,
    slug: ctx.slug,
    locale: ctx.locale,
    type: contentType,
    schema,
    isNew: true,
  });
  collapseAllBlocks();
}

// Load an entry for editing
async function loadEntry(collection, slug, updateUrl = true) {
  // A queued autosave belongs to the form we're leaving — flush it before its
  // form is replaced, so it saves that entry rather than firing against this one.
  flushPendingSave();

  // Claim this load. A response that arrives after a newer load must not render.
  const myLoad = ++loadSeq;

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
  syncEntryPickerLabel(document.getElementById('pageSelector'));

  // Fetch available locales for this entry (if i18n enabled)
  if (i18nConfig.enabled) {
    const locales = await loadEntryLocales(collection, slug);
    if (myLoad !== loadSeq) return; // superseded by a newer load
    entryLocales = locales;
    renderLocaleTabs();
  }

  const localeLabel = i18nConfig.enabled && currentLocale ? ` (${currentLocale.toUpperCase()})` : '';
  document.getElementById('editorTitle').textContent = `Editing: ${entryDisplayTitle(collection, slug)}${localeLabel}`;
  document.getElementById('editorForm').innerHTML = '<p class="placeholder-text">Loading...</p>';
  document.getElementById('deleteEntryBtn').style.display = 'inline-block';

  // The load context threaded through the async render so a stale response bails.
  const ctx = { collection, slug, locale: currentLocale, myLoad };

  try {
    // Build URL with locale query param if i18n enabled
    let apiUrl = `/api/content/${collection}/${slug}`;
    if (i18nConfig.enabled && currentLocale) {
      apiUrl += `?locale=${currentLocale}`;
    }

    const response = await fetch(apiUrl);
    const data = await response.json();

    // A newer load started while this request was in flight — drop this result
    // rather than render entry A's data under entry B's identity.
    if (myLoad !== loadSeq) return;

    if (data.success) {
      currentData = data;
      await renderEditor(data, ctx);
      if (myLoad !== loadSeq) return; // renderEditor awaited a schema; recheck
      renderBlockSelector(); // Show block selector for component preview
      updatePreview();
    } else if (response.status === 404 && i18nConfig.enabled) {
      // Entry doesn't exist for this locale - show empty form for new translation
      isNewEntry = true;
      await createTranslation(collection, slug, ctx);
    } else {
      // Anything else (e.g. a 404 for a non-existent entry) must not leave the
      // panel stuck on "Loading…" — say what happened.
      document.getElementById('editorTitle').textContent = 'Not found';
      document.getElementById('deleteEntryBtn').style.display = 'none';
      document.getElementById('editorForm').innerHTML =
        `<p class="placeholder-text">No entry found for <code>${escapeHtml(collection)}/${escapeHtml(slug)}</code>.</p>`;
    }
  } catch (error) {
    console.error('Failed to load entry:', error);
    if (myLoad !== loadSeq) return; // a newer load owns the panel now
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
  // Leaving an entry: flush its pending save and invalidate any in-flight load,
  // so a late content/schema response can't repopulate this virtual-page view.
  flushPendingSave();
  ++loadSeq;

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
        This is a template page. For inline editing, see the <a href="https://github.com/cloudshipco/astroadmin/blob/main/docs/inline-editing.md" target="_blank" rel="noopener">conversion guide</a>.
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
    syncEntryPickerLabel(document.getElementById('pageSelector'));
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

// Render editor for an entry. `ctx` identifies the load {collection, slug,
// locale, myLoad} so a schema fetch that finishes after a newer load is dropped
// instead of installing the wrong form/saver.
async function renderEditor(entryData, ctx) {
  const editorForm = document.getElementById('editorForm');

  // Get schema for this collection (from the load's collection, not a global
  // that a newer navigation may already have changed).
  const schemaResponse = await fetch(`/api/collections/${ctx.collection}`);
  const schemaData = await schemaResponse.json();
  if (ctx.myLoad !== loadSeq) return; // superseded during the schema fetch

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
          data-content-field="body"
          rows="${bodyRows}"
          class="form-input textarea-autogrow"
          placeholder="Enter markdown content..."
          data-markdown="true"
        >${bodyContent}</textarea>
        <button type="button" class="textarea-expand-btn" data-expand-textarea title="Expand editor">
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

  // Setup form handlers for dynamic fields (blocks, arrays), bound to a saver
  // that always writes THIS form to THIS entry.
  const form = document.getElementById('contentForm');
  installSaver(form, {
    form,
    collection: ctx.collection,
    slug: ctx.slug,
    locale: ctx.locale,
    type: entryData.type,
    schema: schemaData.collection.schema,
    isNew: false,
  });

  // Collapse all blocks by default
  collapseAllBlocks();

  // Setup block focus handler (click to scroll in preview)
  setupBlockFocus();

  // Image, gallery, colour, textarea and reference widgets all come from
  // setupFormHandlers, which applies them to every container that holds fields.
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
  let timeout = null;
  let lastArgs = null;
  const debounced = function (...args) {
    lastArgs = args;
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      const args2 = lastArgs;
      lastArgs = null;
      func(...args2);
    }, wait);
  };
  // Is a call queued but not yet fired?
  debounced.pending = () => timeout !== null;
  // Drop a queued call without running it.
  debounced.cancel = () => {
    clearTimeout(timeout);
    timeout = null;
    lastArgs = null;
  };
  // Run a queued call NOW (used before navigating away, so a pending autosave
  // lands on its own entry rather than the next one).
  debounced.flush = () => {
    if (timeout === null) return undefined;
    clearTimeout(timeout);
    timeout = null;
    const args2 = lastArgs;
    lastArgs = null;
    return func(...(args2 || []));
  };
  return debounced;
}

// Flush the on-screen form's pending autosave before its form is replaced, then
// abandon that saver so nothing (reorder, Cmd+S) can fire it against the new
// form. An already-in-flight save keeps running against its own bound target.
function flushPendingSave() {
  const saver = activeSaver;
  const deb = activeDebouncedSave;
  activeSaver = null;
  activeDebouncedSave = null;
  // Flush the final save while the saver is still enabled, THEN disable it so
  // the old form's listeners can't queue another save against the new entry.
  if (deb && deb.pending()) deb.flush();
  if (saver) saver.disable();
}

// Setup auto-save on form changes
function setupAutoSave(form, saver, debouncedSave) {
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

  // Immediate save for structural changes (reordering cards). Cancel the pending
  // debounce first so this doesn't stack a second save behind the reorder — the
  // saver coalesces, so only the latest form state is written.
  form.addEventListener('cards-reordered', () => {
    debouncedSave.cancel();
    saver(true);
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
/**
 * Build a save function bound to ONE form and an immutable target
 * `{form, collection, slug, locale, type, isNew}`. It always reads from its own
 * form and POSTs to its own entry — never the globals — so a flush during
 * navigation saves the entry being left, not the one arrived at. Saves are
 * serialized per target and coalesced (one trailing save), so two POSTs for the
 * same entry never overlap and an older snapshot can't overwrite a newer one.
 * UI side effects tied to the on-screen entry are gated on `isTargetCurrent()`.
 */
function makeSaver(target) {
  const isTargetCurrent = () =>
    currentCollection === target.collection &&
    currentSlug === target.slug &&
    currentLocale === target.locale;

  const runOnce = async (silent) => {
    const formData = extractFormData(target.form, target.schema);
    // The markdown body is the entry's CONTENT, sent separately as `body`. Its
    // textarea carries no form `name` (only #markdown-body + data-content-field)
    // precisely so extractFormData/FormData don't sweep it into the frontmatter
    // `data` — otherwise the file gets a duplicate `body:` key on top of its
    // real body. A collection that legitimately declares a `body` frontmatter
    // field keeps it, because that field's own control IS named `body`.
    const body = target.form.querySelector('#markdown-body')?.value || '';
    const current = isTargetCurrent();

    if (current) updateSaveStatus('Saving...');

    // Preview change-detection only matters if this entry is on screen.
    let originalHash = null;
    if (current) {
      const previewPageUrl = getPreviewPageUrl();
      if (previewPageUrl) {
        try {
          const res = await fetch(previewPageUrl + '?t=' + Date.now(), { cache: 'no-store' });
          originalHash = quickHash(await res.text());
        } catch { /* proceed without hash */ }
      }
    }

    try {
      let apiUrl = `/api/content/${target.collection}/${target.slug}`;
      if (i18nConfig.enabled && target.locale) apiUrl += `?locale=${target.locale}`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: formData, body, type: target.type }),
      });
      const result = await response.json();

      if (!result.success) {
        if (isTargetCurrent()) {
          updateSaveStatus('Error');
          if (!silent) showNotification('Failed to save: ' + result.error, 'error');
        }
        return;
      }

      if (isTargetCurrent()) {
        updateSaveStatus('Saved');
        if (!silent) showNotification('Changes saved!', 'success');
      }

      // Keep the cached display title in step with the saved data — entry-scoped
      // and safe to run whether or not this entry is still on screen.
      updateEntryTitleCache(target.collection, target.slug, formData);

      if (target.isNew) {
        target.isNew = false; // subsequent saves of this target are edits
        if (isTargetCurrent()) isNewEntry = false;
        // Refresh the picker so it includes the new entry (populatePageSelector
        // preserves the current selection, so this is safe off-screen too).
        await loadPages();
        if (isTargetCurrent()) {
          const localeLabel = i18nConfig.enabled && currentLocale ? ` (${currentLocale.toUpperCase()})` : '';
          document.getElementById('editorTitle').textContent =
            `Editing: ${entryDisplayTitle(target.collection, target.slug)}${localeLabel}`;
          document.getElementById('pageSelector').value = `${target.collection}/${target.slug}`;
          syncEntryPickerLabel(document.getElementById('pageSelector'));
          if (i18nConfig.enabled) {
            const locales = await loadEntryLocales(target.collection, target.slug);
            if (isTargetCurrent()) { entryLocales = locales; renderLocaleTabs(); }
          }
        }
      } else if (isTargetCurrent()) {
        // Reflect any title change in the header + picker button.
        const localeLabel = i18nConfig.enabled && currentLocale ? ` (${currentLocale.toUpperCase()})` : '';
        document.getElementById('editorTitle').textContent =
          `Editing: ${entryDisplayTitle(target.collection, target.slug)}${localeLabel}`;
        syncEntryPickerLabel(document.getElementById('pageSelector'));
      }

      updateChangesBadge();

      // Preview refresh only if this entry is still on screen; otherwise a newer
      // load already drove the preview to the right page.
      if (isTargetCurrent()) {
        if (originalHash) await waitForContentChange(originalHash);
        // WORKAROUND: Astro/Vite HMR needs a beat after the change is detected.
        // See https://github.com/withastro/astro/issues/13138
        await new Promise((r) => setTimeout(r, 2000));
        if (isTargetCurrent()) updatePreview();
      }
    } catch (error) {
      console.error('Save failed:', error);
      if (isTargetCurrent()) {
        updateSaveStatus('Error');
        if (!silent) showNotification('Failed to save changes', 'error');
      }
    }
  };

  // Serialize + coalesce: while a save runs, a further request sets `again` so
  // exactly one more save runs afterward with the latest form state. Once
  // disabled (the form is being left/deleted), the saver is inert — this closes
  // the window where the leaving form's own input/reorder listeners, which still
  // reference this saver, could queue a POST after navigation or a DELETE.
  let inFlight = null;
  let again = false;
  let disabled = false;
  const saver = (silent = true) => {
    if (disabled) return Promise.resolve();
    if (inFlight) { again = true; return inFlight; }
    inFlight = (async () => {
      // Drain `again` unconditionally: once disabled, no new call can set it
      // (they no-op above), so this only replays edits queued BEFORE disable —
      // e.g. the final flush-on-navigate must not be dropped.
      do { again = false; await runOnce(silent); } while (again);
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  // Resolves once no save is in flight — used before a destructive op (delete).
  saver.whenIdle = () => inFlight || Promise.resolve();
  // Make the saver inert for good (future calls no-op; an in-flight save still
  // finishes its current run against its own bound target).
  saver.disable = () => { disabled = true; };
  return saver;
}

/**
 * Wire a freshly rendered form to a bound saver: input debounces a save,
 * reordering coalesces one immediate save, and the form's pending edit can be
 * flushed on navigation. Sets the module-level active saver/debounce.
 */
function installSaver(form, target) {
  const saver = makeSaver(target);
  const debouncedSave = debounce(() => saver(true), 1000);
  activeSaver = saver;
  activeDebouncedSave = debouncedSave;
  setupFormHandlers(form, debouncedSave);
  setupAutoSave(form, saver, debouncedSave);
  return { saver, debouncedSave };
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

// Escape a string for literal use inside a RegExp (the fixed parts of a preview
// route like "/blog/" around its {slug} placeholder).
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The origin of the preview iframe (e.g. "http://localhost:4321"), used to
// authenticate postMessages from it. Null if previewUrl isn't set/parseable.
function previewOrigin() {
  try {
    return previewUrl ? new URL(previewUrl, location.href).origin : null;
  } catch {
    return null;
  }
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
  // Only trust messages from the preview iframe showing OUR preview origin.
  // `event.source` (set by the browser to the real sender) stops an unrelated
  // window forging a pageNavigation; the origin check stops a page the iframe
  // was navigated to on a DIFFERENT origin from doing the same, since the
  // iframe's WindowProxy identity is stable across such navigations.
  const previewFrame = document.getElementById('previewFrame');
  if (!previewFrame || event.source !== previewFrame.contentWindow) return;
  if (previewOrigin() && event.origin !== previewOrigin()) return;

  if (event.data?.type === 'scrollPosition') {
    lastPreviewScrollY = event.data.scrollY;
  }

  // Click-to-edit: an element tagged data-aa-field was clicked in the preview →
  // focus, scroll to and briefly highlight its editor control.
  if (event.data?.type === 'fieldFocus') {
    focusEditorField(event.data.field);
    return;
  }

  // Handle page navigation in preview - sync admin to show that page
  if (event.data?.type === 'pageNavigation') {
    const pathname = event.data.pathname;
    // A malformed message without a string pathname would throw below.
    if (typeof pathname !== 'string') return;

    // Ignore component-preview URLs - these are for non-page collections
    if (pathname.startsWith('/component-preview/')) {
      return;
    }

    // Resolve the previewed route to an editor target. A route can be BOTH a
    // rendered `.astro` file (read-only "site page") and an editable pages
    // entry — prefer the editable entry.
    //   1. an editable `pages` entry at /<slug>  -> load it
    //   2. otherwise a discovered route (blog/faq index, etc.) -> read-only view
    //   3. otherwise leave the sidebar as-is (never fire a load that 404s and
    //      hangs the panel on "Loading…").
    const norm = pathname.replace(/\/+$/, '') || '/';

    // Ignore the echo of our OWN preview update. Loading any entry points the
    // preview at that entry's route, which fires a pageNavigation back here; if
    // that route also happens to be an editable `pages` entry (e.g. an faqs
    // entry previews at /faq, which is also the pages/faq entry), resolving it
    // below would yank the editor off the entry the user just picked. The
    // current entry's own preview path is never a user navigation. Only compare
    // when the current entry HAS a real page path — a component-only collection
    // returns null, which must not be coerced to '/' (that would swallow a
    // genuine Home navigation).
    const currentPath = getCurrentPagePath();
    if (currentPath !== null && norm === ((currentPath.replace(/\/+$/, '')) || '/')) return;

    const target = resolvePreviewTarget(norm, allPages, allCollections, collectionOrder);
    if (target && !(currentCollection === target.collection && currentSlug === target.slug)) {
      loadEntry(target.collection, target.slug, true);
    }
    if (target) return;
    // Unresolved (a route with no matching content entry) — leave the editor
    // as it is rather than opening a read-only view.
  }
});

/**
 * Click-to-edit (preview → editor): focus, scroll to and briefly flash the
 * editor control for `field`, expanding a collapsed block if it lives in one.
 */
function focusEditorField(field) {
  if (typeof field !== 'string' || !field) return;
  const form = document.getElementById('contentForm');
  if (!form) return;
  // Match a named control, or the markdown body textarea (which has no form
  // name — see makeSaver — so it's found via data-content-field instead).
  const esc = CSS.escape(field);
  const el = form.querySelector(`[name="${esc}"], [data-content-field="${esc}"]`);
  if (!el) return;
  const block = el.closest('.block-item.collapsed');
  if (block) block.querySelector('.block-header')?.click(); // expand it
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  flashFieldGroup(el.closest('.form-group') || el);
}

// Briefly flash a field group. Tracks one timer + the ORIGINAL inline style per
// element, so re-clicking within the flash window resets the timer without ever
// snapshotting (and then restoring) the flash colour itself.
const flashState = new WeakMap();
function flashFieldGroup(group) {
  let state = flashState.get(group);
  if (state) {
    clearTimeout(state.timer);
  } else {
    state = { prevShadow: group.style.boxShadow, prevTransition: group.style.transition };
    flashState.set(group, state);
  }
  group.style.transition = 'box-shadow .15s';
  group.style.boxShadow = '0 0 0 2px #3b82f6';
  state.timer = setTimeout(() => {
    group.style.boxShadow = state.prevShadow;
    group.style.transition = state.prevTransition;
    flashState.delete(group);
  }, 1200);
}

// Click-to-edit (editor → preview): clicking a field in the editor highlights
// its element in the preview (no-op if the site hasn't tagged that element).
document.addEventListener('click', (event) => {
  const form = document.getElementById('contentForm');
  if (!form || !form.contains(event.target)) return;
  // Match a named control OR the markdown body (which has data-content-field, not
  // a form name — see makeSaver), so clicking the body control also highlights.
  const sel = '[name], [data-content-field]';
  const control = event.target.closest(sel) || event.target.closest('.form-group')?.querySelector(sel);
  const field = control?.getAttribute('name') || control?.getAttribute('data-content-field');
  if (!field) return;
  const iframe = document.getElementById('previewFrame');
  iframe?.contentWindow?.postMessage({ type: 'highlightField', field }, previewOrigin() || '*');
});

// Update preview
async function updatePreview() {
  const iframe = document.getElementById('previewFrame');
  const placeholder = document.getElementById('previewPlaceholder');
  const previewControls = document.getElementById('previewControls');

  const pageUrl = getPreviewPageUrl();
  if (!pageUrl) {
    // No route to preview this collection at — say so instead of leaving a
    // blank pane (routeless collections on e.g. single-page sites hit this
    // until `preview.routes` maps them somewhere).
    iframe.style.display = 'none';
    previewControls.style.display = 'none';
    placeholder.style.display = 'flex';
    placeholder.innerHTML = `
      <div class="preview-placeholder-message">
        <p>No preview route for the <code>${escapeHtml(currentCollection ?? '')}</code> collection.</p>
        <p class="preview-placeholder-hint">
          If this content appears on an existing page, map it there in
          <code>astroadmin.config.js</code> — e.g.
          <code>preview: { routes: { ${escapeHtml(currentCollection ?? 'collection')}: '/' } }</code>.
        </p>
      </div>
    `;
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
    // Save the on-screen form now (its bound saver coalesces with any pending
    // autosave). No form / new-unsaved-with-no-saver → nothing to do.
    if (activeSaver) {
      activeDebouncedSave?.cancel();
      activeSaver(false);
    }
  }
});

// Delete entry handler
document.getElementById('deleteEntryBtn').addEventListener('click', async () => {
  if (!currentCollection || !currentSlug || isNewEntry) return;
  if (deleteInProgress) return; // a DELETE is already running — ignore a re-click

  // Snapshot the delete target BEFORE any await, so navigating mid-delete can't
  // redirect the DELETE (or the editor-clearing) to a different entry.
  const target = { collection: currentCollection, slug: currentSlug, locale: currentLocale };
  const localeLabel = i18nConfig.enabled && target.locale ? ` (${target.locale.toUpperCase()})` : '';
  const deleteMessage = i18nConfig.enabled && target.locale
    ? `Are you sure you want to delete the ${target.locale.toUpperCase()} translation of "${target.slug}"?\n\nThis cannot be undone.`
    : `Are you sure you want to delete "${target.slug}" from ${target.collection}?\n\nThis cannot be undone.`;

  const confirmed = confirm(deleteMessage);
  if (!confirmed) return;

  deleteInProgress = true;
  const deleteBtn = document.getElementById('deleteEntryBtn');
  deleteBtn.disabled = true;

  // Declared outside the try so the catch can read it; assigned before the await.
  let delGen = 0;

  // Everything below is inside the try so the finally ALWAYS runs — even if the
  // awaited pending save rejects — leaving deleteInProgress/button restored.
  try {
    // Disable the on-screen saver (so its form listeners can't queue a POST),
    // cancel any queued autosave, and let an in-flight one finish BEFORE
    // deleting, so a POST can't land after the DELETE and resurrect the entry.
    // Invalidate loads (capturing this op's generation NOW, before the await) so
    // a load that starts during the wait can't be mistaken for this delete's.
    const saver = activeSaver;
    activeDebouncedSave?.cancel();
    saver?.disable?.();
    activeSaver = null;
    activeDebouncedSave = null;
    const pendingSave = saver?.whenIdle?.();
    delGen = ++loadSeq;
    // A failed save must not stop the delete (they're independent) — swallow it.
    if (pendingSave) await pendingSave.catch(() => {});

    let apiUrl = `/api/content/${target.collection}/${target.slug}`;
    if (i18nConfig.enabled && target.locale) {
      apiUrl += `?locale=${target.locale}`;
    }

    const response = await fetch(apiUrl, { method: 'DELETE' });
    const result = await response.json();

    if (result.success) {
      showNotification(`Deleted "${target.slug}"${localeLabel}`, 'success');
      await loadPages();
      if (loadSeq !== delGen) return; // user moved on — leave their editor alone

      // Clear the editor
      currentCollection = null;
      currentSlug = null;
      currentData = null;
      document.getElementById('editorTitle').textContent = 'Select a page to edit';
      document.getElementById('editorForm').innerHTML = '<p class="placeholder-text">Choose a page from the dropdown above to start editing.</p>';
      document.getElementById('deleteEntryBtn').style.display = 'none';
      document.getElementById('pageSelector').value = '';
      syncEntryPickerLabel(document.getElementById('pageSelector'));

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
      // The delete didn't happen — reinstate a working editor (fresh saver)
      // rather than leaving the disabled one stranded.
      if (loadSeq === delGen) loadEntry(target.collection, target.slug, false);
    }
  } catch (error) {
    console.error('Delete failed:', error);
    showNotification('Failed to delete entry', 'error');
    if (loadSeq === delGen) loadEntry(target.collection, target.slug, false);
  } finally {
    deleteInProgress = false;
    // Harmless when the button is hidden (successful delete); re-enables it for
    // the visible editor after a failed delete or a mid-delete navigation.
    document.getElementById('deleteEntryBtn').disabled = false;
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

/**
 * Turn the publish API result into a friendly, non-technical message for CMS
 * users. The server's own message ("committed and pushed") is accurate for the
 * API but too technical for the editor. A synchronous deploy adapter (e.g.
 * rsync) is live immediately; a git push to a build-on-push host (Netlify,
 * Cloudflare Pages, etc.) takes a short while to build, so we say so.
 */
function friendlyPublishMessage(result) {
  const didPublish = result.committed || result.pushed || result.deploy;
  if (!didPublish) {
    return 'Nothing new to publish — your work is already saved.';
  }
  // A deploy adapter uploads the built site directly, so it's live right away.
  if (result.deploy) {
    return '✅ Published! Your changes are now live on your site.';
  }
  // Git push → the host builds and deploys, which takes a minute or two.
  return '✅ Published! Your changes will appear on your live site in a minute or two.';
}

/**
 * The production path of the current entry (e.g. '/', '/about'), or null when
 * the entry has no real production page (component-preview-only collections).
 * Mirrors getPreviewPageUrl()'s routing, minus the origin.
 */
function getCurrentPagePath() {
  const isDefaultLocale = !i18nConfig.enabled || currentLocale === i18nConfig.defaultLocale;
  const localePrefix = isDefaultLocale ? '' : `/${currentLocale}`;

  if (currentCollection === 'pages') {
    if (currentSlug === 'home') return isDefaultLocale ? '/' : localePrefix;
    return `${localePrefix}/${currentSlug}`;
  }
  const collection = allCollections.find(c => c.name === currentCollection);
  if (collection?.previewRoute) {
    return `${localePrefix}${collection.previewRoute.replace('{slug}', currentSlug)}`;
  }
  return null; // component-preview-only: no standalone production page
}

// A persistent, updatable status toast (unlike showNotification's fire-and-forget)
// so the post-publish "publishing… → now live!" flow can update in place.
function showPublishStatus(message) {
  const el = document.createElement('div');
  el.className = 'notification notification-info';
  el.style.cssText = `position:fixed;top:60px;right:20px;padding:12px 20px;background:#667eea;` +
    `color:white;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:1000;` +
    `font-size:14px;max-width:360px;`;
  el.textContent = message;
  document.body.appendChild(el);
  return {
    update(msg, { type = 'info', link = null, autoDismissMs = null } = {}) {
      el.style.background = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#667eea';
      el.textContent = msg;
      if (link) {
        el.appendChild(document.createTextNode(' '));
        const a = document.createElement('a');
        a.href = link; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'View site →';
        a.style.cssText = 'color:white;text-decoration:underline;font-weight:600;';
        el.appendChild(a);
      }
      if (autoDismissMs) setTimeout(() => el.remove(), autoDismissMs);
    },
    remove() { el.remove(); },
  };
}

async function fetchLiveHash(pagePath) {
  try {
    const res = await fetch(`/api/publish/live-status?path=${encodeURIComponent(pagePath)}`);
    const data = await res.json();
    if (data.configured && data.reachable && data.hash) return data.hash;
  } catch { /* mid-deploy the site may be briefly unreachable */ }
  return null;
}

// Poll the production URL until the page's HTML hash changes (the deploy went
// live) or we give up. Updates the status toast in place.
async function pollUntilLive(pagePath, preHash, status, liveUrl) {
  const maxMs = 5 * 60 * 1000;
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise(r => setTimeout(r, 5000));
    const hash = await fetchLiveHash(pagePath);
    if (hash && hash !== preHash) {
      status.update('✅ Your changes are now live!', { type: 'success', link: liveUrl, autoDismissMs: 10000 });
      return;
    }
  }
  status.update('✅ Published. Your changes should be live shortly.', { type: 'success', link: liveUrl, autoDismissMs: 10000 });
}

// Publish changes
document.getElementById('publishBtn').addEventListener('click', async () => {
  const message = await showPublishDialog();
  if (message === null) return; // User cancelled

  const publishBtn = document.getElementById('publishBtn');
  const originalText = publishBtn.textContent;
  publishBtn.textContent = 'Publishing...';
  publishBtn.disabled = true;

  // Snapshot the live page hash BEFORE publishing so we can detect when the
  // deploy actually goes live. Only possible with a configured publicUrl and a
  // real production page for this entry.
  const pagePath = getCurrentPagePath();
  const liveUrl = (publicUrl && pagePath) ? publicUrl.replace(/\/$/, '') + pagePath : null;
  const preHash = (publicUrl && pagePath) ? await fetchLiveHash(pagePath) : null;

  try {
    const response = await fetch('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message || undefined }),
    });

    const result = await response.json();

    if (result.success) {
      updateChangesBadge();
      const didPublish = result.committed || result.pushed || result.deploy;

      if (didPublish && result.deploy) {
        // Synchronous deploy adapter — already live.
        showPublishStatus('').update('✅ Published! Your changes are now live on your site.',
          { type: 'success', link: liveUrl, autoDismissMs: 8000 });
      } else if (didPublish && preHash) {
        // Build-on-push host — poll until the change appears on the live site.
        const status = showPublishStatus('✅ Published! Waiting for your changes to go live…');
        pollUntilLive(pagePath, preHash, status, liveUrl);
      } else {
        // No live-check available — fall back to the plain friendly message.
        showNotification(friendlyPublishMessage(result), 'success');
      }
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
  const badge = document.getElementById('changesBadge');

  // The changes badge is git-only; skip the /api/git/status call when disabled.
  if (!gitEnabled) {
    if (badge) badge.style.display = 'none';
    return;
  }

  const count = await getChangesCount();

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
    // Auto-select: prefer content entries over virtual pages
    // (Virtual pages are for sites that haven't converted to content collections yet)
    const homePage = allPages.find(p => p.collection === 'pages' && p.slug === 'home');
    const firstPage = homePage || allPages.find(p => p.collection === 'pages') || allPages[0];

    if (firstPage) {
      loadEntry(firstPage.collection, firstPage.slug, true);
    } else if (allStaticPages.length > 0) {
      // No content entries - show virtual pages for unconverted sites
      loadVirtualPage(allStaticPages[0].slug);
    }
  }
}

init();
