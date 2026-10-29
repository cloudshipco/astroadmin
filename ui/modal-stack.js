/**
 * Escape closes the topmost open modal, and only that one.
 *
 * Modals stack (a gallery opens the image library, an item editor opens
 * another item editor or a picker), and each used to listen for Escape on its
 * own, so one keypress closed every modal it reached: Escape in the image
 * library also closed the gallery behind it and threw away the gallery's
 * unsaved edits (#35). A per-modal "is anything above me open?" check cannot
 * work either: whichever listener runs first closes its modal, and the next one
 * then finds itself on top.
 *
 * So there is ONE document listener and a stack in opening order (a modal is
 * only ever opened from the one beneath it, so opening order is stacking
 * order). A modal calls `pushModal` when it opens and `removeModal` when it
 * closes, however it closes; an entry whose element is gone from the document
 * or hidden is skipped, so a missed `removeModal` cannot swallow the key.
 *
 * A modal that handles Escape itself on an element inside it (the entry
 * picker, the commit dialog, the new-entry dialog) calls preventDefault, and
 * the stack leaves that keypress alone.
 */

/** @type {Array<{ element: HTMLElement, onEscape: () => void }>} */
const openModals = [];
let listening = false;

function isShowing(element) {
  return element.isConnected && !element.classList.contains('hidden');
}

function handleKeydown(event) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  while (openModals.length > 0 && !isShowing(openModals[openModals.length - 1].element)) {
    openModals.pop();
  }
  const topmost = openModals[openModals.length - 1];
  if (!topmost) return;
  event.preventDefault();
  topmost.onEscape();
}

/**
 * Record a modal as open, on top of every modal already open.
 * @param {HTMLElement} element - The modal's overlay element
 * @param {() => void} onEscape - Closes the modal (without saving)
 */
export function pushModal(element, onEscape) {
  removeModal(element);
  openModals.push({ element, onEscape });
  if (!listening) {
    document.addEventListener('keydown', handleKeydown);
    listening = true;
  }
}

/**
 * Record a modal as closed. Safe to call for a modal that is not open.
 * @param {HTMLElement} element - The modal's overlay element
 */
export function removeModal(element) {
  const index = openModals.findIndex((entry) => entry.element === element);
  if (index !== -1) openModals.splice(index, 1);
}
