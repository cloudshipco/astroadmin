/**
 * A gallery's add / remove / reorder counts as an edit even when the result
 * equals the stored value. The gallery is edited in its own modal, out of the
 * form's sight, so a stored invalid `gallery: []` (optional, .min(1)) that the
 * editor emptied by adding an image and removing it came back as the stored
 * `[]`, although the editor's advice said that leaves the field out.
 *
 * Driven through the real buttons in happy-dom: the gallery field's Edit, the
 * gallery modal's Add, the image library's grid and Select, Remove and Save,
 * with fetch stubbed for the library listing.
 *
 *   bun tests/gallery-structural.test.js
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';
import { z } from 'zod';

/** A real JSON Response: the dashboard reads bodies through readJson (ui/api-response.js). */
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

const schema = z.toJSONSchema(z.object({
  title: z.string(),
  gallery: z.array(z.object({ src: z.string(), alt: z.string() })).min(1).optional(),
}), { unrepresentable: 'any' });

function renderBound(data) {
  document.body.innerHTML = '';
  const form = document.createElement('form');
  form.innerHTML = generateForm(schema, data);
  document.body.appendChild(form);
  setupFormHandlers(form, () => {});
  bindOriginalValues(form, data);
  return form;
}

await check('positive control: the gallery renders as a gallery field', () => {
  const form = renderBound({ title: 'T', gallery: [] });
  assert.ok(form.querySelector('.gallery-field[data-field="gallery"]'), form.innerHTML.slice(0, 300));
});

await check('add an image then remove it: the stored invalid [] is left out', async () => {
  const form = renderBound({ title: 'T', gallery: [] });
  click(form.querySelector('[data-edit-gallery]'));
  await settle();
  const galleryModal = document.getElementById('galleryEditorModal');
  click(galleryModal.querySelector('[data-add]'));
  await settle();
  const library = document.getElementById('imageLibraryModal');
  const item = library.querySelector('.image-library-item[data-url="/images/a.png"]');
  assert.ok(item, 'positive control: the stubbed library lists the image');
  click(item);
  click(library.querySelector('[data-select]'));
  await settle();
  assert.ok(galleryModal.querySelector('[data-remove="0"]'), 'positive control: the image was added');
  click(galleryModal.querySelector('[data-remove="0"]'));
  click(galleryModal.querySelector('[data-save]'));
  await settle();
  const data = extractFormData(form, schema);
  assert.equal('gallery' in data, false, JSON.stringify(data));
  assert.equal(data.title, 'T');
});

await check('open the gallery and save without a change: the stored value is kept as it was', async () => {
  const form = renderBound({ title: 'T', gallery: [] });
  click(form.querySelector('[data-edit-gallery]'));
  await settle();
  click(document.getElementById('galleryEditorModal').querySelector('[data-save]'));
  await settle();
  const data = extractFormData(form, schema);
  assert.deepEqual(data.gallery, [], JSON.stringify(data));
});

const richSchema = z.toJSONSchema(z.object({
  title: z.string(),
  gallery: z.array(z.object({
    src: z.string(),
    alt: z.string().optional(),
    note: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })).optional(),
}), { unrepresentable: 'any' });

await check('after an add and a remove, a surviving image keeps its empty optional fields, on this save and the next', async () => {
  document.body.innerHTML = '';
  const stored = { title: 'T', gallery: [{ src: '/images/kept.png', alt: '', note: '', tags: [] }] };
  const form = document.createElement('form');
  form.innerHTML = generateForm(richSchema, stored);
  document.body.appendChild(form);
  setupFormHandlers(form, () => {});
  bindOriginalValues(form, structuredClone(stored));
  click(form.querySelector('[data-edit-gallery]'));
  await settle();
  const galleryModal = document.getElementById('galleryEditorModal');
  click(galleryModal.querySelector('[data-add]'));
  await settle();
  const library = document.getElementById('imageLibraryModal');
  click(library.querySelector('.image-library-item[data-url="/images/a.png"]'));
  click(library.querySelector('[data-select]'));
  await settle();
  assert.ok(galleryModal.querySelector('[data-remove="1"]'), 'positive control: the second image was added');
  click(galleryModal.querySelector('[data-remove="1"]'));
  click(galleryModal.querySelector('[data-save]'));
  await settle();
  assert.deepEqual(extractFormData(form, richSchema).gallery, stored.gallery, 'first save');
  const title = form.querySelector('[name="title"]');
  title.value = 'T2';
  title.dispatchEvent(new window.Event('input', { bubbles: true }));
  const second = extractFormData(form, richSchema);
  assert.equal(second.title, 'T2', 'positive control: the title edit is read');
  assert.deepEqual(second.gallery, stored.gallery, 'a later title-only save');
});

const strictAltSchema = z.toJSONSchema(z.object({
  title: z.string(),
  gallery: z.array(z.object({ src: z.string(), alt: z.string().min(1).optional() })).optional(),
}), { unrepresentable: 'any' });

await check('a NEWLY added image is still cleaned: its empty alt is left out, not saved as an invalid ""', async () => {
  document.body.innerHTML = '';
  const stored = { title: 'T', gallery: [{ src: '/images/kept.png', alt: 'Kept' }] };
  const form = document.createElement('form');
  form.innerHTML = generateForm(strictAltSchema, stored);
  document.body.appendChild(form);
  setupFormHandlers(form, () => {});
  bindOriginalValues(form, structuredClone(stored));
  click(form.querySelector('[data-edit-gallery]'));
  await settle();
  const galleryModal = document.getElementById('galleryEditorModal');
  click(galleryModal.querySelector('[data-add]'));
  await settle();
  const library = document.getElementById('imageLibraryModal');
  click(library.querySelector('.image-library-item[data-url="/images/a.png"]'));
  click(library.querySelector('[data-select]'));
  await settle();
  click(galleryModal.querySelector('[data-save]'));
  await settle();
  const gallery = extractFormData(form, strictAltSchema).gallery;
  assert.equal(gallery.length, 2, `positive control: the new image was added (${JSON.stringify(gallery)})`);
  assert.deepEqual(gallery[0], { src: '/images/kept.png', alt: 'Kept' }, 'the stored image is unchanged');
  assert.deepEqual(gallery[1], { src: '/images/a.png' }, `the new image's empty alt is cleaned (${JSON.stringify(gallery[1])})`);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
