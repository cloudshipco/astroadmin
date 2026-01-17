/**
 * Changes Panel Component
 * Shows git status, diffs, and allows reverting changes
 */

let panelOpen = false;
let currentStatus = null;

/**
 * Toggle the changes panel
 */
export async function toggleChangesPanel() {
  const panel = document.getElementById('changesPanel');

  if (!panel) {
    createPanel();
  }

  panelOpen = !panelOpen;
  const panelEl = document.getElementById('changesPanel');

  if (panelOpen) {
    panelEl.classList.remove('hidden');
    await loadStatus();
  } else {
    panelEl.classList.add('hidden');
  }
}

/**
 * Close the panel
 */
export function closeChangesPanel() {
  panelOpen = false;
  const panel = document.getElementById('changesPanel');
  if (panel) {
    panel.classList.add('hidden');
  }
}

/**
 * Create the panel HTML
 */
function createPanel() {
  const panel = document.createElement('div');
  panel.id = 'changesPanel';
  panel.className = 'changes-panel hidden';
  panel.innerHTML = `
    <div class="changes-panel-header">
      <h3 class="changes-panel-title">Changes</h3>
      <button type="button" class="changes-panel-close" data-close-changes>&times;</button>
    </div>
    <div class="changes-panel-body">
      <div class="changes-section">
        <h4 class="changes-section-title">Uncommitted Changes</h4>
        <div class="changes-list" data-changes-list>
          <div class="changes-loading">Loading...</div>
        </div>
      </div>
      <div class="changes-section">
        <h4 class="changes-section-title">Recent History</h4>
        <div class="commits-list" data-commits-list>
          <div class="changes-loading">Loading...</div>
        </div>
      </div>
    </div>
    <div class="changes-panel-footer">
      <button type="button" class="btn btn-sm btn-secondary" data-refresh-changes>Refresh</button>
      <button type="button" class="btn btn-sm btn-primary" data-commit-changes disabled>Commit All</button>
    </div>
  `;

  document.body.appendChild(panel);
  setupPanelEvents(panel);
}

/**
 * Setup panel event listeners
 */
function setupPanelEvents(panel) {
  // Close button
  panel.querySelector('[data-close-changes]').addEventListener('click', closeChangesPanel);

  // Refresh button
  panel.querySelector('[data-refresh-changes]').addEventListener('click', loadStatus);

  // Commit button
  panel.querySelector('[data-commit-changes]').addEventListener('click', commitChanges);

  // Delegated events for file actions
  panel.addEventListener('click', async (e) => {
    // View diff
    if (e.target.matches('[data-view-diff]')) {
      const file = e.target.dataset.viewDiff;
      await showDiff(file);
    }

    // Revert file
    if (e.target.matches('[data-revert-file]')) {
      const file = e.target.dataset.revertFile;
      if (confirm(`Revert all changes to ${file}?\n\nThis cannot be undone.`)) {
        await revertFile(file);
      }
    }

    // Close diff modal
    if (e.target.matches('[data-close-diff]') || e.target.matches('.diff-modal-overlay')) {
      closeDiffModal();
    }
  });
}

/**
 * Load git status
 */
async function loadStatus() {
  const changesList = document.querySelector('[data-changes-list]');
  const commitsList = document.querySelector('[data-commits-list]');
  const commitBtn = document.querySelector('[data-commit-changes]');

  try {
    // Load status and log in parallel
    const [statusRes, logRes] = await Promise.all([
      fetch('/api/git/status'),
      fetch('/api/git/log?limit=5')
    ]);

    const statusData = await statusRes.json();
    const logData = await logRes.json();

    if (statusData.success) {
      currentStatus = statusData.status;
      renderChanges(changesList, statusData.status);

      // Enable commit button if there are changes
      const hasChanges = statusData.status.modified.length > 0 ||
                        statusData.status.created.length > 0 ||
                        statusData.status.deleted.length > 0;
      commitBtn.disabled = !hasChanges;
    }

    if (logData.success) {
      renderCommits(commitsList, logData.commits);
    }
  } catch (error) {
    console.error('Error loading status:', error);
    changesList.innerHTML = '<div class="changes-error">Failed to load changes</div>';
  }
}

/**
 * Render the changes list
 */
function renderChanges(container, status) {
  const allChanges = [
    ...status.modified.map(f => ({ file: f, type: 'modified' })),
    ...status.created.map(f => ({ file: f, type: 'added' })),
    ...status.deleted.map(f => ({ file: f, type: 'deleted' })),
  ];

  if (allChanges.length === 0) {
    container.innerHTML = '<div class="changes-empty">No uncommitted changes</div>';
    return;
  }

  container.innerHTML = allChanges.map(change => `
    <div class="change-item">
      <span class="change-type change-type-${change.type}">${change.type[0].toUpperCase()}</span>
      <span class="change-file" title="${change.file}">${formatFilePath(change.file)}</span>
      <div class="change-actions">
        ${change.type !== 'deleted' ? `<button type="button" class="btn-icon" data-view-diff="${change.file}" title="View changes">👁</button>` : ''}
        <button type="button" class="btn-icon btn-icon-danger" data-revert-file="${change.file}" title="Revert changes">↩</button>
      </div>
    </div>
  `).join('');
}

/**
 * Render commits list
 */
function renderCommits(container, commits) {
  if (commits.length === 0) {
    container.innerHTML = '<div class="changes-empty">No commit history</div>';
    return;
  }

  container.innerHTML = commits.map(commit => `
    <div class="commit-item">
      <span class="commit-hash">${commit.hashShort}</span>
      <span class="commit-message" title="${escapeHtml(commit.message)}">${truncate(commit.message, 40)}</span>
      <span class="commit-date">${formatRelativeDate(commit.date)}</span>
    </div>
  `).join('');
}

/**
 * Show diff modal
 */
async function showDiff(file) {
  try {
    const res = await fetch(`/api/git/diff?file=${encodeURIComponent(file)}`);
    const data = await res.json();

    if (!data.success) {
      alert('Failed to load diff: ' + data.error);
      return;
    }

    // Create diff modal
    let modal = document.getElementById('diffModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'diffModal';
      document.body.appendChild(modal);
    }

    modal.className = 'diff-modal-overlay';
    modal.innerHTML = `
      <div class="diff-modal">
        <div class="diff-modal-header">
          <h3>Changes: ${formatFilePath(file)}</h3>
          <button type="button" class="diff-modal-close" data-close-diff>&times;</button>
        </div>
        <div class="diff-modal-body">
          <pre class="diff-content">${formatDiff(data.diff)}</pre>
        </div>
        <div class="diff-modal-footer">
          <button type="button" class="btn btn-sm btn-secondary" data-close-diff>Close</button>
          <button type="button" class="btn btn-sm btn-danger" data-revert-file="${file}">Revert File</button>
        </div>
      </div>
    `;

    // Add event listeners for the modal (since it's outside the panel's event delegation)
    modal.querySelectorAll('[data-close-diff]').forEach(btn => {
      btn.addEventListener('click', closeDiffModal);
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDiffModal(); // Click on overlay
    });
    modal.querySelector('[data-revert-file]').addEventListener('click', async () => {
      if (confirm(`Revert all changes to ${file}?\n\nThis cannot be undone.`)) {
        await revertFile(file);
      }
    });
  } catch (error) {
    console.error('Error loading diff:', error);
    alert('Failed to load diff');
  }
}

/**
 * Close diff modal
 */
function closeDiffModal() {
  const modal = document.getElementById('diffModal');
  if (modal) {
    modal.remove();
  }
}

/**
 * Revert a file
 */
async function revertFile(file) {
  try {
    const res = await fetch('/api/git/revert-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });

    const data = await res.json();

    if (data.success) {
      closeDiffModal();
      await loadStatus();

      // Trigger a page reload in the preview if editing that file
      window.dispatchEvent(new CustomEvent('fileReverted', { detail: { file } }));
    } else {
      alert('Failed to revert: ' + data.error);
    }
  } catch (error) {
    console.error('Error reverting file:', error);
    alert('Failed to revert file');
  }
}

/**
 * Show publish dialog and return promise with message
 * @param {Object} options - Dialog options
 * @param {string} options.title - Dialog title
 * @param {string} options.confirmText - Text for confirm button
 * @returns {Promise<string|null>} Resolves with message (or empty string), null if cancelled
 */
export function showPublishDialog(options = {}) {
  const {
    title = 'Publish Your Changes',
    confirmText = 'Publish'
  } = options;

  return new Promise((resolve) => {
    let modal = document.getElementById('commitModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'commitModal';
      document.body.appendChild(modal);
    }

    const closeAndResolve = (value) => {
      modal.remove();
      resolve(value);
    };

    modal.className = 'commit-modal-overlay';
    modal.innerHTML = `
      <div class="commit-modal">
        <div class="commit-modal-header">
          <h3>${title}</h3>
          <button type="button" class="commit-modal-close" data-close-commit>&times;</button>
        </div>
        <div class="commit-modal-body">
          <label for="commitMessage" class="commit-label">
            Add a note about your changes
            <span class="commit-optional">(optional)</span>
          </label>
          <textarea
            id="commitMessage"
            class="commit-input"
            placeholder="e.g. Updated opening hours, Added new menu item..."
            rows="3"
          ></textarea>
          <p class="commit-hint">If left blank, we'll create a note based on what was changed.</p>
        </div>
        <div class="commit-modal-footer">
          <button type="button" class="btn btn-sm btn-secondary" data-close-commit>Cancel</button>
          <button type="button" class="btn btn-sm btn-primary" data-confirm-commit>${confirmText}</button>
        </div>
      </div>
    `;

    // Event listeners
    modal.querySelectorAll('[data-close-commit]').forEach(btn => {
      btn.addEventListener('click', () => closeAndResolve(null));
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAndResolve(null);
    });
    modal.querySelector('[data-confirm-commit]').addEventListener('click', () => {
      const message = document.getElementById('commitMessage').value.trim();
      closeAndResolve(message);
    });

    // Focus the textarea
    setTimeout(() => {
      document.getElementById('commitMessage').focus();
    }, 100);

    // Handle Enter key (with shift for newline), Escape to cancel
    modal.querySelector('#commitMessage').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        modal.querySelector('[data-confirm-commit]').click();
      }
      if (e.key === 'Escape') {
        closeAndResolve(null);
      }
    });
  });
}

/**
 * Show commit dialog (internal use for changes panel)
 */
function showCommitDialog() {
  showPublishDialog({ title: 'Save Your Changes', confirmText: 'Save Changes' })
    .then(message => {
      if (message !== null) {
        performCommit(message);
      }
    });
}

/**
 * Commit all changes
 */
function commitChanges() {
  showCommitDialog();
}

/**
 * Perform the actual commit
 * @param {string} message - Optional commit message
 */
async function performCommit(message) {
  // Generate a default message if none provided
  const commitMessage = message || generateDefaultMessage();

  try {
    const res = await fetch('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        files: ['src/content/', 'src/styles/', 'public/images/']
      })
    });

    const data = await res.json();

    if (data.success) {
      await loadStatus();
      showSuccessToast('Changes saved successfully!');
    } else {
      alert('Failed to commit: ' + data.error);
    }
  } catch (error) {
    console.error('Error committing:', error);
    alert('Failed to commit changes');
  }
}

/**
 * Generate a default commit message based on changes
 */
function generateDefaultMessage() {
  if (!currentStatus) return 'Content updates';

  const parts = [];
  const modified = currentStatus.modified.length;
  const created = currentStatus.created.length;
  const deleted = currentStatus.deleted.length;

  if (created > 0) parts.push(`Added ${created} file${created > 1 ? 's' : ''}`);
  if (modified > 0) parts.push(`Updated ${modified} file${modified > 1 ? 's' : ''}`);
  if (deleted > 0) parts.push(`Removed ${deleted} file${deleted > 1 ? 's' : ''}`);

  return parts.length > 0 ? parts.join(', ') : 'Content updates';
}

/**
 * Show a success toast notification
 */
function showSuccessToast(message) {
  let toast = document.getElementById('successToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'successToast';
    document.body.appendChild(toast);
  }

  toast.className = 'success-toast';
  toast.textContent = message;

  setTimeout(() => {
    toast.classList.add('success-toast-hidden');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * Format file path for display
 */
function formatFilePath(path) {
  // Show just the filename and parent dir
  const parts = path.split('/');
  if (parts.length > 2) {
    return '.../' + parts.slice(-2).join('/');
  }
  return path;
}

/**
 * Format diff with syntax highlighting
 */
function formatDiff(diff) {
  if (!diff) return '<span class="diff-empty">No changes</span>';

  return escapeHtml(diff)
    .split('\n')
    .map(line => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<span class="diff-add">${line}</span>`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `<span class="diff-remove">${line}</span>`;
      }
      if (line.startsWith('@@')) {
        return `<span class="diff-info">${line}</span>`;
      }
      return line;
    })
    .join('\n');
}

/**
 * Format relative date
 */
function formatRelativeDate(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Truncate string
 */
function truncate(str, len) {
  if (str.length <= len) return str;
  return str.substring(0, len) + '...';
}

/**
 * Escape HTML
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Get count of uncommitted changes
 */
export async function getChangesCount() {
  try {
    const res = await fetch('/api/git/status');
    const data = await res.json();

    if (data.success) {
      return data.status.modified.length +
             data.status.created.length +
             data.status.deleted.length;
    }
  } catch (error) {
    console.error('Error getting changes count:', error);
  }
  return 0;
}
