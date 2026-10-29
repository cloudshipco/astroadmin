/**
 * Page scroll stays locked while any modal is open, and only then.
 *
 * Each modal used to write `document.body.style.overflow` itself: 'hidden' on
 * open, '' on close. Closing a modal opened from another (the image library
 * over a gallery) then unlocked the page while the gallery was still open, so
 * the dashboard scrolled behind it. The modal stack (`ui/modal-stack.js`) now
 * owns the lock: locked while the stack has an open entry, restored to the
 * value it had before the first lock when the last one closes.
 *
 * Driven through the real buttons in happy-dom, with fetch stubbed for the
 * library listing.
 *
 *   bun tests/modal-scroll-lock.test.js
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';
import { z } from 'zod';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.FormData = window.FormData;
globalThis.CSS = window.CSS;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.MutationObserver = window.MutationObserver;
globalThis.confirm = () => true;
globalThis.fetch = async () => jsonResponse({ success: true, images: [{ url: '/images/a.png', filename: 'a.png', source: 'uploads' }] });

const { generateForm, setupFormHandlers, bindOriginalValues } = await import('../ui/form-generator.js');
const { openSingleItemEditor } = await import('../ui/array-editor.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${error.message}`);
  } finally {
    document.body.style.overflow = '';
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const pressEscape = (target = document.body) => {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
};
const isOpen = (element) => Boolean(element && element.isConnected && !element.classList.contains('hidden'));
const locked = () => document.body.style.overflow === 'hidden';
const newestItemEditor = () => [...document.querySelectorAll('.array-item-edit-overlay')].at(-1);

const schema = z.toJSONSchema(z.object({
  title: z.string(),
  gallery: z.array(z.object({ src: z.string(), alt: z.string() })).optional(),
}), { unrepresentable: 'any' });
const stored = { title: 'T', gallery: [{ src: '/images/one.png', alt: 'One' }] };

const form = document.createElement('form');
form.innerHTML = generateForm(schema, structuredClone(stored));
document.body.appendChild(form);
setupFormHandlers(form, () => {});
bindOriginalValues(form, structuredClone(stored));

async function openGallery() {
  click(form.querySelector('[data-edit-gallery]'));
  await settle();
  const galleryModal = document.getElementById('galleryEditorModal');
  assert.ok(isOpen(galleryModal), 'positive control: the gallery opened');
  return galleryModal;
}

async function openLibraryFrom(galleryModal) {
  click(galleryModal.querySelector('[data-add]'));
  await settle();
  const library = document.getElementById('imageLibraryModal');
  assert.ok(isOpen(library), 'positive control: the library opened');
  return library;
}

await check('positive control: one modal locks the page and unlocks it on close', async () => {
  assert.equal(locked(), false, 'locked before anything opened');
  const galleryModal = await openGallery();
  assert.ok(locked(), 'the gallery did not lock the page');
  click(galleryModal.querySelector('[data-close]'));
  assert.equal(isOpen(galleryModal), false, 'positive control: the gallery closed');
  assert.equal(locked(), false, 'the page is still locked after the only modal closed');
});

await check('closing the library over a gallery keeps the page locked; closing the gallery unlocks it', async () => {
  const galleryModal = await openGallery();
  const library = await openLibraryFrom(galleryModal);
  click(library.querySelector('[data-close]'));
  assert.equal(isOpen(library), false, 'positive control: the library closed');
  assert.ok(isOpen(galleryModal), 'positive control: the gallery is still open');
  assert.ok(locked(), 'the page unlocked while the gallery is still open');
  click(galleryModal.querySelector('[data-close]'));
  assert.equal(locked(), false, 'the page is still locked after the gallery closed');
});

await check('the same through Escape, one modal at a time', async () => {
  const galleryModal = await openGallery();
  const library = await openLibraryFrom(galleryModal);
  pressEscape();
  assert.equal(isOpen(library), false, 'positive control: Escape closed the library');
  assert.ok(locked(), 'the page unlocked while the gallery is still open');
  pressEscape();
  assert.equal(isOpen(galleryModal), false, 'positive control: Escape closed the gallery');
  assert.equal(locked(), false, 'the page is still locked');
});

await check('the overflow the page had before the first modal is restored, not cleared', async () => {
  document.body.style.overflow = 'clip';
  const galleryModal = await openGallery();
  assert.ok(locked(), 'the gallery did not lock the page');
  const library = await openLibraryFrom(galleryModal);
  click(library.querySelector('[data-close]'));
  click(galleryModal.querySelector('[data-close]'));
  assert.equal(document.body.style.overflow, 'clip');
});

const itemSchema = z.toJSONSchema(z.object({
  heading: z.string(),
  image: z.string().optional(),
  description: z.string().optional(),
}), { unrepresentable: 'any' });

await check('an item editor locks the page, and the library and textarea it opens leave it locked', async () => {
  openSingleItemEditor({ heading: 'H', image: '', description: 'D' }, itemSchema, () => {});
  await settle();
  const itemEditor = newestItemEditor();
  assert.ok(isOpen(itemEditor), 'positive control: the item editor opened');
  assert.ok(locked(), 'the item editor did not lock the page');

  click(itemEditor.querySelector('[data-browse]'));
  await settle();
  const library = document.getElementById('imageLibraryModal');
  assert.ok(isOpen(library), 'positive control: the library opened');
  click(library.querySelector('[data-close]'));
  assert.ok(locked(), 'closing the library unlocked the page under the item editor');

  click(itemEditor.querySelector('[data-expand-textarea]'));
  const textareaModal = document.getElementById('textareaModal');
  assert.ok(isOpen(textareaModal), 'positive control: the textarea modal opened');
  click(textareaModal.querySelector('[data-close-textarea-modal]'));
  assert.equal(isOpen(textareaModal), false, 'positive control: the textarea modal closed');
  assert.ok(locked(), 'closing the textarea modal unlocked the page under the item editor');

  click(itemEditor.querySelector('[data-close]'));
  assert.equal(isOpen(itemEditor), false, 'positive control: the item editor closed');
  assert.equal(locked(), false, 'the page is still locked after the item editor closed');
});

await check('a modal removed without removeModal does not hold the lock for ever', async () => {
  openSingleItemEditor({ heading: 'H' }, itemSchema, () => {});
  await settle();
  // Taken out of the document behind the stack's back.
  newestItemEditor().remove();
  const galleryModal = await openGallery();
  click(galleryModal.querySelector('[data-close]'));
  assert.equal(locked(), false, 'a stale entry kept the page locked');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
