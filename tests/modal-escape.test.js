/**
 * Escape closes only the topmost open modal (#35).
 *
 * Every modal used to listen for Escape on its own (the gallery, the image
 * library, the reference picker on the document; an item editor on itself), so
 * one keypress closed every modal it reached. Escape in the image library
 * opened from a gallery also closed the gallery behind it, and closing a
 * gallery drops its unsaved edits; Escape in a library opened from an item
 * editor, with focus still on the item editor's Browse button, closed the item
 * editor too.
 *
 * Driven through the real buttons in happy-dom (field-widgets, gallery-editor,
 * image-library, array-editor), with fetch stubbed for the library listing.
 * The image library is opened, and so created, BEFORE the gallery: its
 * listener then runs first, which is the order where a per-modal "am I on top?"
 * check made after another listener already closed its modal would still close
 * two.
 *
 *   bun tests/modal-escape.test.js
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

const { generateForm, extractFormData, setupFormHandlers, bindOriginalValues } = await import('../ui/form-generator.js');
const { openImageLibrary, closeImageLibrary } = await import('../ui/image-library.js');
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
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
/** Escape pressed with focus on `target` (the body when nothing is focused). */
const pressEscape = (target = document.body) => {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
};
const isOpen = (element) => Boolean(element && element.isConnected && !element.classList.contains('hidden'));
/** The item editor opened last (an earlier check that failed can leave one open beneath it). */
const newestItemEditor = () => [...document.querySelectorAll('.array-item-edit-overlay')].at(-1);

const schema = z.toJSONSchema(z.object({
  title: z.string(),
  gallery: z.array(z.object({ src: z.string(), alt: z.string() })).optional(),
}), { unrepresentable: 'any' });

const stored = {
  title: 'T',
  gallery: [{ src: '/images/one.png', alt: 'One' }, { src: '/images/two.png', alt: 'Two' }],
};

// Create the image library first (see the header), then close it.
openImageLibrary(() => {});
await settle();
closeImageLibrary();

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

await check('positive control: Escape with only the gallery open closes it, unsaved', async () => {
  const galleryModal = await openGallery();
  click(galleryModal.querySelector('[data-remove="0"]'));
  pressEscape();
  assert.equal(isOpen(galleryModal), false, 'the gallery is still open');
  assert.deepEqual(extractFormData(form, schema).gallery, stored.gallery, 'Escape saved the gallery');
});

await check('Escape in the image library opened from the gallery closes the library only; the gallery keeps its edits', async () => {
  const galleryModal = await openGallery();
  // An unsaved edit: remove the first image.
  click(galleryModal.querySelector('[data-remove="0"]'));
  assert.equal(galleryModal.querySelectorAll('[data-remove]').length, 1, 'positive control: the image was removed');

  click(galleryModal.querySelector('[data-add]'));
  await settle();
  const library = document.getElementById('imageLibraryModal');
  assert.ok(isOpen(library), 'positive control: the library opened');

  pressEscape();
  assert.equal(isOpen(library), false, 'the library is still open');
  assert.ok(isOpen(galleryModal), 'the gallery behind the library was closed');
  assert.equal(galleryModal.querySelectorAll('[data-remove]').length, 1, 'the gallery lost its edit');

  // The edit survives to Save.
  click(galleryModal.querySelector('[data-save]'));
  await settle();
  assert.equal(isOpen(galleryModal), false, 'positive control: Save closes the gallery');
  assert.deepEqual(extractFormData(form, schema).gallery, [stored.gallery[1]], 'the saved gallery');
});

await check('a second Escape then closes the gallery: each press closes one modal, top down', async () => {
  const galleryModal = await openGallery();
  click(galleryModal.querySelector('[data-add]'));
  await settle();
  const library = document.getElementById('imageLibraryModal');
  pressEscape();
  assert.equal(isOpen(library), false, 'first Escape: the library is still open');
  assert.ok(isOpen(galleryModal), 'first Escape: the gallery closed too');
  pressEscape();
  assert.equal(isOpen(galleryModal), false, 'second Escape: the gallery is still open');
});

const itemSchema = z.toJSONSchema(z.object({
  heading: z.string(),
  image: z.string().optional(),
}), { unrepresentable: 'any' });

await check('Escape in the image library opened from an item editor (focus still on Browse) leaves the item editor open', async () => {
  let savedItem = null;
  openSingleItemEditor({ heading: 'Old', image: '' }, itemSchema, (item) => { savedItem = item; });
  await settle();
  const itemEditor = newestItemEditor();
  assert.ok(isOpen(itemEditor), 'positive control: the item editor opened');
  const heading = itemEditor.querySelector('[name="heading"]');
  heading.value = 'New';
  heading.dispatchEvent(new window.Event('input', { bubbles: true }));

  const browse = itemEditor.querySelector('[data-browse]');
  assert.ok(browse, 'positive control: the item has an image picker');
  click(browse);
  await settle();
  const library = document.getElementById('imageLibraryModal');
  assert.ok(isOpen(library), 'positive control: the library opened');

  // The click left focus on the Browse button, inside the item editor.
  pressEscape(browse);
  assert.equal(isOpen(library), false, 'the library is still open');
  assert.ok(isOpen(itemEditor), 'the item editor behind the library was closed');

  click(itemEditor.querySelector('[data-save]'));
  assert.equal(savedItem?.heading, 'New', `the item editor's edit (${JSON.stringify(savedItem)})`);
});

await check('positive control: Escape in an item editor alone closes it, without saving', async () => {
  let saveCalls = 0;
  openSingleItemEditor({ heading: 'Old' }, itemSchema, () => { saveCalls++; });
  await settle();
  const itemEditor = newestItemEditor();
  assert.ok(isOpen(itemEditor), 'positive control: the item editor opened');
  pressEscape(itemEditor.querySelector('[name="heading"]'));
  assert.equal(isOpen(itemEditor), false, 'the item editor is still open');
  assert.equal(saveCalls, 0, 'Escape saved the item');
});

await check('nested item editors: Escape closes the inner one only', async () => {
  openSingleItemEditor({ heading: 'Outer' }, itemSchema, () => {});
  openSingleItemEditor({ heading: 'Inner' }, itemSchema, () => {});
  await settle();
  const [outer, inner] = document.querySelectorAll('.array-item-edit-overlay');
  assert.ok(isOpen(outer) && isOpen(inner), 'positive control: both item editors opened');
  pressEscape(inner.querySelector('[name="heading"]'));
  assert.equal(isOpen(inner), false, 'the inner item editor is still open');
  assert.ok(isOpen(outer), 'the outer item editor was closed too');
  pressEscape();
  assert.equal(isOpen(outer), false, 'second Escape: the outer item editor is still open');
});

const proseItemSchema = z.toJSONSchema(z.object({
  heading: z.string(),
  description: z.string().optional(),
}), { unrepresentable: 'any' });

await check('the expanded textarea over an item editor: Escape (focus anywhere in it) cancels it, not the item editor', async () => {
  let savedItem = null;
  openSingleItemEditor({ heading: 'Old', description: 'Body' }, proseItemSchema, (item) => { savedItem = item; });
  await settle();
  const itemEditor = newestItemEditor();
  const heading = itemEditor.querySelector('[name="heading"]');
  heading.value = 'New';
  heading.dispatchEvent(new window.Event('input', { bubbles: true }));
  const expand = itemEditor.querySelector('[data-expand-textarea]');
  assert.ok(expand, 'positive control: the description has an expand button');
  click(expand);
  const textareaModal = document.getElementById('textareaModal');
  assert.ok(isOpen(textareaModal), 'positive control: the textarea modal opened');
  textareaModal.querySelector('#textareaModalInput').value = 'Changed';

  // Focus on a button of the textarea modal, not its input.
  pressEscape(textareaModal.querySelector('[data-close-textarea-modal]'));
  assert.equal(isOpen(textareaModal), false, 'the textarea modal is still open');
  assert.ok(isOpen(itemEditor), 'the item editor behind it was closed');
  assert.equal(itemEditor.querySelector('[name="description"]').value, 'Body', 'Escape kept the textarea edit');

  // Focus in the textarea itself: still the textarea modal only.
  click(expand);
  const reopened = document.getElementById('textareaModal');
  pressEscape(reopened.querySelector('#textareaModalInput'));
  assert.equal(isOpen(reopened), false, 'focus in the input: the textarea modal is still open');
  assert.ok(isOpen(itemEditor), 'focus in the input: the item editor was closed');

  click(itemEditor.querySelector('[data-save]'));
  assert.equal(savedItem?.heading, 'New', `the item editor's edit (${JSON.stringify(savedItem)})`);
});

await check('a key other than Escape closes nothing', async () => {
  const galleryModal = await openGallery();
  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.ok(isOpen(galleryModal), 'Enter closed the gallery');
  pressEscape();
  assert.equal(isOpen(galleryModal), false, 'positive control: Escape still closes it');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
