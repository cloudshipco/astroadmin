/**
 * Reference Picker Component
 * Modal for browsing and selecting items from a collection
 */

let currentCallback = null;
let currentCollection = null;
let currentEntries = [];
let selectedItems = [];

/**
 * Open the reference picker modal
 * @param {string} collectionName - Name of the collection to browse
 * @param {Function} onSelect - Callback when item is selected (receives item id)
 * @param {Array} excludeIds - IDs to exclude from selection (already selected)
 */
export async function openReferencePicker(collectionName, onSelect, excludeIds = []) {
  currentCallback = onSelect;
  currentCollection = collectionName;
  selectedItems = [];

  // Create modal if it doesn't exist
  let modal = document.getElementById('referencePickerModal');
  if (!modal) {
    modal = createModal();
    document.body.appendChild(modal);
    setupModalEvents(modal);
  }

  // Update modal title
  const singularName = collectionName.endsWith('s') ? collectionName.slice(0, -1) : collectionName;
  modal.querySelector('[data-title]').textContent = `Select ${formatLabel(singularName)}`;

  // Show modal
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Load entries
  await loadEntries(excludeIds);
}

/**
 * Close the reference picker modal
 */
export function closeReferencePicker() {
  const modal = document.getElementById('referencePickerModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
  currentCallback = null;
  currentCollection = null;
  currentEntries = [];
  selectedItems = [];
}

/**
 * Create the modal HTML structure
 */
function createModal() {
  const modal = document.createElement('div');
  modal.id = 'referencePickerModal';
  modal.className = 'reference-modal-overlay hidden';
  modal.innerHTML = `
    <div class="reference-modal">
      <div class="reference-modal-header">
        <h2 class="reference-modal-title" data-title>Select Item</h2>
        <button type="button" class="reference-modal-close" data-close>&times;</button>
      </div>
      <div class="reference-modal-body">
        <div class="reference-search-wrapper">
          <input type="text" class="form-input reference-search" data-search placeholder="Search...">
        </div>
        <div class="reference-list" data-list>
          <!-- Entries will be loaded here -->
        </div>
        <div class="reference-loading hidden" data-loading>
          Loading...
        </div>
        <div class="reference-empty hidden" data-empty>
          <p>No items available</p>
        </div>
      </div>
      <div class="reference-modal-footer">
        <div class="reference-selected-info" data-selected-info>
          Click an item to select
        </div>
        <div class="reference-modal-actions">
          <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
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
  modal.querySelector('[data-close]').addEventListener('click', closeReferencePicker);
  modal.querySelector('[data-cancel]').addEventListener('click', closeReferencePicker);

  // Click outside to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeReferencePicker();
    }
  });

  // Escape key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeReferencePicker();
    }
  });

  // Search input
  const searchInput = modal.querySelector('[data-search]');
  searchInput.addEventListener('input', (e) => {
    filterEntries(e.target.value);
  });

  // List click delegation (for selecting items)
  const list = modal.querySelector('[data-list]');
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.reference-list-item');
    if (item && !item.classList.contains('disabled')) {
      selectItem(item.dataset.id);
    }
  });
}

/**
 * Load entries from the API
 */
async function loadEntries(excludeIds = []) {
  const modal = document.getElementById('referencePickerModal');
  const list = modal.querySelector('[data-list]');
  const empty = modal.querySelector('[data-empty]');
  const loading = modal.querySelector('[data-loading]');
  const searchInput = modal.querySelector('[data-search]');

  // Clear search
  searchInput.value = '';

  // Show loading
  list.innerHTML = '';
  loading.classList.remove('hidden');
  empty.classList.add('hidden');

  try {
    const response = await fetch(`/api/collections/${currentCollection}/entries?preview=true`);
    const data = await response.json();

    loading.classList.add('hidden');

    if (data.success) {
      currentEntries = data.entries.map(entry => ({
        ...entry,
        disabled: excludeIds.includes(entry.slug)
      }));
      renderEntries(list, empty);
    } else {
      console.error('Failed to load entries:', data.error);
      list.innerHTML = '<p class="text-red-500">Failed to load items</p>';
    }
  } catch (error) {
    console.error('Error loading entries:', error);
    loading.classList.add('hidden');
    list.innerHTML = '<p class="text-red-500">Error loading items</p>';
  }
}

/**
 * Render entries in the list
 */
function renderEntries(list, empty, filter = '') {
  const filteredEntries = filter
    ? currentEntries.filter(entry => {
        // Search across all data fields
        const dataStr = entry.data ? JSON.stringify(entry.data).toLowerCase() : '';
        const searchStr = `${entry.slug} ${entry.title || ''} ${entry.preview || ''} ${dataStr}`.toLowerCase();
        return searchStr.includes(filter.toLowerCase());
      })
    : currentEntries;

  if (filteredEntries.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  list.innerHTML = filteredEntries.map(entry => renderEntryCard(entry)).join('');
}

/**
 * Render a rich card for an entry based on its data
 */
function renderEntryCard(entry) {
  const data = entry.data || {};
  const disabled = entry.disabled;

  // Build card content based on available fields
  let cardContent = '';

  // Header: name/title with optional position/role
  const name = data.name || data.title || entry.title || entry.slug;
  const subtitle = data.position || data.role || data.organization || '';

  cardContent += `
    <div class="reference-card-header">
      <div class="reference-card-name">${escapeHtml(name)}</div>
      ${subtitle ? `<div class="reference-card-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    </div>
  `;

  // Quote/description - show full text
  const quote = data.quote || data.description || data.excerpt || data.content || '';
  if (quote) {
    cardContent += `
      <div class="reference-card-quote">
        <span class="reference-card-quote-mark">"</span>
        ${escapeHtml(quote)}
      </div>
    `;
  }

  // Meta info: organization, rating, etc.
  const metaItems = [];
  if (data.organization && data.organization !== subtitle) {
    metaItems.push(`<span class="reference-card-meta-item">${escapeHtml(data.organization)}</span>`);
  }
  if (data.rating) {
    metaItems.push(`<span class="reference-card-meta-item reference-card-rating">${'★'.repeat(data.rating)}${'☆'.repeat(5 - data.rating)}</span>`);
  }
  if (data.date) {
    metaItems.push(`<span class="reference-card-meta-item">${escapeHtml(data.date)}</span>`);
  }

  if (metaItems.length > 0) {
    cardContent += `<div class="reference-card-meta">${metaItems.join('')}</div>`;
  }

  return `
    <div class="reference-list-item reference-card ${disabled ? 'disabled' : ''}" data-id="${entry.slug}">
      ${cardContent}
      ${disabled ? '<span class="reference-list-item-badge">Already added</span>' : ''}
    </div>
  `;
}

/**
 * Filter entries based on search
 */
function filterEntries(searchTerm) {
  const modal = document.getElementById('referencePickerModal');
  const list = modal.querySelector('[data-list]');
  const empty = modal.querySelector('[data-empty]');
  renderEntries(list, empty, searchTerm);
}

/**
 * Select an item
 */
function selectItem(id) {
  if (currentCallback) {
    // Find the entry data to pass back
    const entry = currentEntries.find(e => e.slug === id);
    currentCallback(id, entry || null);
    closeReferencePicker();
  }
}

/**
 * Format field name into readable label
 */
function formatLabel(name) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim();
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
