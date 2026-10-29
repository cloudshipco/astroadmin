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
 *
 * The stack also owns page scroll locking: the body does not scroll while any
 * modal on it is open, and gets back the overflow it had before the first one
 * opened when the last one closes. Each modal used to write
 * `document.body.style.overflow` itself, so closing the image library over a
 * gallery unlocked the page while the gallery was still open. A modal never
 * touches body overflow; being on the stack is what locks it.
 */

/** @type {Array<{ element: HTMLElement, onEscape: () => void }>} */
const openModals = [];
let listening = false;
/** The body's inline overflow before the first open modal locked it; null while unlocked. */
let overflowBeforeLock = null;

function isShowing(element) {
  return element.isConnected && !element.classList.contains('hidden');
}

/** Drop entries whose modal closed without a removeModal (gone, or hidden). */
function forgetClosedModals() {
  for (let index = openModals.length - 1; index >= 0; index--) {
    if (!isShowing(openModals[index].element)) openModals.splice(index, 1);
  }
}

function updateScrollLock() {
  if (openModals.length > 0) {
    if (overflowBeforeLock === null) {
      overflowBeforeLock = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
  } else if (overflowBeforeLock !== null) {
    document.body.style.overflow = overflowBeforeLock;
    overflowBeforeLock = null;
  }
}

function handleKeydown(event) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  forgetClosedModals();
  updateScrollLock();
  const topmost = openModals[openModals.length - 1];
  if (!topmost) return;
  event.preventDefault();
  topmost.onEscape();
}

/**
 * Record a modal as open, on top of every modal already open, and lock page
 * scroll. Call it once the modal is in the document and showing.
 * @param {HTMLElement} element - The modal's overlay element
 * @param {() => void} onEscape - Closes the modal (without saving)
 */
export function pushModal(element, onEscape) {
  removeModal(element);
  openModals.push({ element, onEscape });
  updateScrollLock();
  if (!listening) {
    document.addEventListener('keydown', handleKeydown);
    listening = true;
  }
}

/**
 * Record a modal as closed, unlocking page scroll if it was the last one open.
 * Safe to call for a modal that is not open.
 * @param {HTMLElement} element - The modal's overlay element
 */
export function removeModal(element) {
  const index = openModals.findIndex((entry) => entry.element === element);
  if (index !== -1) openModals.splice(index, 1);
  forgetClosedModals();
  updateScrollLock();
}
