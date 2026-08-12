/**
 * Searchable modal entry picker.
 *
 * Replaces the long native <select> of pages/entries with a command-palette
 * modal: a button showing the current entry, and a modal with a search box and
 * a grouped, filterable, keyboard-navigable list.
 *
 * Design: the native <select> stays in the DOM as the source of truth (hidden).
 * The modal is a pure VIEW over its <optgroup>/<option> tree; selecting a row
 * sets `select.value` and dispatches `change`, so every existing load path
 * (loadEntry / loadVirtualPage / the new-item modal) runs unchanged. That keeps
 * this change entirely front-end and off the load logic.
 */

/** The slug half of an entry option value (`pages/blog` -> `blog`). */
function rowSlug(value) {
  const i = value.indexOf('/');
  return i === -1 ? '' : value.slice(i + 1);
}

/** Read the select's option tree into groups the modal renders from. */
function readGroups(select) {
  const groups = [];
  for (const group of select.querySelectorAll('optgroup')) {
    const rows = [];
    for (const opt of group.querySelectorAll('option')) {
      if (!opt.value) continue;
      const isNew = opt.value.startsWith('new:');
      rows.push({
        value: opt.value,
        // The option text is already a display label (a title for entries,
        // given text for routes/"+ New"); show it verbatim.
        label: opt.textContent.trim(),
        // Search also matches the value, so the slug (e.g. "blog") still finds
        // an entry whose visible label is its title (e.g. "Journal").
        raw: opt.value,
        isNew,
      });
    }
    if (rows.length) groups.push({ label: group.label, rows });
  }
  return groups;
}

export function initEntryPicker(select) {
  if (!select || select.dataset.pickerInit === 'true') return;
  select.dataset.pickerInit = 'true';
  select.classList.add('entry-picker-native-hidden');

  // Trigger button (shows the current entry) inserted after the select.
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'entry-picker-button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.innerHTML = `<span class="entry-picker-button-label"></span><span class="entry-picker-button-caret" aria-hidden="true">▾</span>`;
  select.insertAdjacentElement('afterend', button);

  // Modal.
  const overlay = document.createElement('div');
  overlay.className = 'entry-picker-overlay hidden';
  overlay.innerHTML = `
    <div class="entry-picker-modal" role="dialog" aria-modal="true" aria-label="Choose a page">
      <div class="entry-picker-search-wrap">
        <input type="text" class="entry-picker-search" placeholder="Search pages and entries…"
               role="combobox" aria-expanded="true" aria-controls="entry-picker-listbox"
               aria-autocomplete="list" aria-label="Search" autocomplete="off" spellcheck="false">
      </div>
      <div class="entry-picker-list" id="entry-picker-listbox" role="listbox" tabindex="-1"></div>
      <div class="entry-picker-empty hidden">No matches</div>
    </div>`;
  document.body.appendChild(overlay);

  const searchInput = overlay.querySelector('.entry-picker-search');
  const list = overlay.querySelector('.entry-picker-list');
  const emptyEl = overlay.querySelector('.entry-picker-empty');

  let rowEls = []; // currently-visible row elements, in order
  let activeIndex = -1;

  const setActive = (i) => {
    if (!rowEls.length) { activeIndex = -1; searchInput.removeAttribute('aria-activedescendant'); return; }
    activeIndex = (i + rowEls.length) % rowEls.length;
    rowEls.forEach((el, idx) => {
      const on = idx === activeIndex;
      el.classList.toggle('active', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
    // Focus stays in the search box (the combobox), so the active row is
    // announced via the input's aria-activedescendant, not the listbox's.
    searchInput.setAttribute('aria-activedescendant', rowEls[activeIndex].id);
  };

  const render = (query = '') => {
    const q = query.trim().toLowerCase();
    list.innerHTML = '';
    rowEls = [];
    const groups = readGroups(select);
    // Which display labels are shared by more than one entry — those rows show a
    // muted slug so the client can tell them apart (and not edit the wrong one).
    const labelCounts = {};
    for (const group of groups) {
      for (const r of group.rows) {
        if (!r.isNew) labelCounts[r.label] = (labelCounts[r.label] || 0) + 1;
      }
    }
    let rowId = 0;
    for (const group of groups) {
      const matching = group.rows.filter(
        (r) => !q || r.label.toLowerCase().includes(q) || r.raw.toLowerCase().includes(q),
      );
      if (!matching.length) continue;
      const header = document.createElement('div');
      header.className = 'entry-picker-group';
      header.textContent = group.label;
      list.appendChild(header);
      for (const r of matching) {
        const row = document.createElement('button');
        row.type = 'button';
        row.id = `entry-picker-row-${rowId++}`;
        // Off the tab order: the search box keeps focus and drives selection, so
        // Tab can't land focus on a row (and thus can't escape the modal).
        row.tabIndex = -1;
        row.className = 'entry-picker-row' + (r.isNew ? ' is-new' : '');
        row.dataset.value = r.value;
        row.setAttribute('role', 'option');
        const current = r.value === select.value;
        row.setAttribute('aria-selected', current ? 'true' : 'false');
        const slugHint =
          !r.isNew && labelCounts[r.label] > 1
            ? `<span class="entry-picker-row-slug">${escapeText(rowSlug(r.value))}</span>`
            : '';
        row.innerHTML =
          `<span class="entry-picker-row-check" aria-hidden="true">${current ? '✓' : ''}</span>` +
          `<span class="entry-picker-row-label">${escapeText(r.label)}</span>` +
          slugHint;
        list.appendChild(row);
        rowEls.push(row);
      }
    }
    emptyEl.classList.toggle('hidden', rowEls.length > 0);
    // Highlight the current entry, or the first row when filtering.
    const currentIdx = rowEls.findIndex((el) => el.dataset.value === select.value);
    setActive(q ? 0 : currentIdx >= 0 ? currentIdx : 0);
  };

  const open = () => {
    render('');
    searchInput.value = '';
    overlay.classList.remove('hidden');
    searchInput.focus();
  };
  const close = () => {
    overlay.classList.add('hidden');
    button.focus();
  };
  const choose = (value) => {
    close();
    if (select.value === value && !value.startsWith('new:')) return; // no-op re-select
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncEntryPickerLabel(select);
  };

  button.addEventListener('click', open);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.entry-picker-row');
    if (row) choose(row.dataset.value);
  });
  searchInput.addEventListener('input', () => render(searchInput.value));
  // Keys are handled at the overlay level so Escape/arrows work no matter where
  // focus is, and Tab navigates the list instead of moving focus behind the
  // modal (a lightweight focus trap — focus stays on the search box throughout).
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (rowEls[activeIndex]) choose(rowEls[activeIndex].dataset.value); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  // Keep the button label in step with the select (some code sets .value directly).
  select.addEventListener('change', () => syncEntryPickerLabel(select));
  syncEntryPickerLabel(select);
}

/** Update the trigger button to show the current entry. */
export function syncEntryPickerLabel(select) {
  if (!select) return;
  const button = select.nextElementSibling;
  if (!button || !button.classList.contains('entry-picker-button')) return;
  const labelEl = button.querySelector('.entry-picker-button-label');
  const opt = select.selectedOptions[0];
  const value = select.value;
  // The option text is already a display label (see readGroups); show it verbatim.
  labelEl.textContent = opt && value ? opt.textContent.trim() : 'Select page…';
}

/** Minimal text escape for row labels (labels are slugs/names, but be safe). */
function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
