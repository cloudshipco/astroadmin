/**
 * Alt text stored under the image picker's old built-in key (#88 follow-up),
 * through the real renderer, binding and extractFormData in happy-dom, with
 * schemas from real zod 4.
 *
 * Before #88 a `bannerImage` beside a declared `bannerAlt` showed its own alt
 * box too, which wrote `bannerImageAlt`. #88 took that box away, so a stored
 * `bannerImageAlt` had no control and the next save dropped it. Pins:
 *   - while the declared alt is empty, its control shows the old text, and a
 *     save with only the title edited writes it under the declared key;
 *   - an edit of the declared alt control saves the edit;
 *   - a declared alt that has text of its own keeps it (the old key is not
 *     shown);
 *   - the same inside a block and in the item modal. DELIBERATE (review
 *     round 2): the item modal used to keep the old key as well, being a
 *     property the schema does not render, so an untouched Done wrote both
 *     keys, an edit left the stale old text beside it for good, and a
 *     cleared alt came back from the old key on the next open. The modal
 *     now drops the key a control was carried over from (its
 *     data-original-path), as the main form, which reads only what it
 *     renders, always did.
 *
 *   bun tests/legacy-alt.test.js
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';
import { z } from 'zod';

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
window.confirm = () => true;

const fg = await import('../ui/form-generator.js');

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

const toSchema = (zodSchema) => z.toJSONSchema(zodSchema, { reused: 'inline', unrepresentable: 'any', io: 'input' });

function render(schema, data) {
  document.body.innerHTML = '';
  const form = document.createElement('form');
  form.innerHTML = fg.generateForm(schema, data);
  document.body.appendChild(form);
  fg.setupFormHandlers(form, () => {});
  fg.bindOriginalValues(form, data);
  return form;
}

function type(root, name, value) {
  const control = root.querySelector(`[name="${name}"]`);
  assert.ok(control, `a control named ${name}`);
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

const pageSchema = toSchema(z.object({
  title: z.string(),
  bannerImage: z.string().optional(),
  bannerAlt: z.string().optional(),
}));

await check('a title-only edit moves the old built-in alt to the declared alt', () => {
  const stored = { title: 'T', bannerImage: '/images/a.jpg', bannerImageAlt: 'Typed earlier' };
  const form = render(pageSchema, stored);
  assert.equal(form.querySelector('[name="bannerAlt"]').value, 'Typed earlier', 'the declared alt box shows the old text');
  assert.equal(form.querySelectorAll('[name="bannerImageAlt"]').length, 0, 'no second alt box');
  type(form, 'title', 'T2');
  const saved = fg.extractFormData(form, pageSchema);
  assert.deepEqual(saved, { title: 'T2', bannerImage: '/images/a.jpg', bannerAlt: 'Typed earlier' });
});

await check('a stored empty declared alt is filled from the old key too', () => {
  const stored = { title: 'T', bannerImage: '/images/a.jpg', bannerAlt: '', bannerImageAlt: 'Typed earlier' };
  const form = render(pageSchema, stored);
  type(form, 'title', 'T2');
  assert.equal(fg.extractFormData(form, pageSchema).bannerAlt, 'Typed earlier');
});

await check('editing the declared alt saves the edit', () => {
  const stored = { title: 'T', bannerImage: '/images/a.jpg', bannerImageAlt: 'Typed earlier' };
  const form = render(pageSchema, stored);
  type(form, 'bannerAlt', 'A field at dusk');
  assert.equal(fg.extractFormData(form, pageSchema).bannerAlt, 'A field at dusk');
});

await check('a declared alt with text of its own keeps it (control)', () => {
  const stored = { title: 'T', bannerImage: '/images/a.jpg', bannerAlt: 'Own text', bannerImageAlt: 'Typed earlier' };
  const form = render(pageSchema, stored);
  assert.equal(form.querySelector('[name="bannerAlt"]').value, 'Own text');
  type(form, 'title', 'T2');
  assert.equal(fg.extractFormData(form, pageSchema).bannerAlt, 'Own text');
});

await check('no old text: an absent declared alt stays absent (control)', () => {
  const stored = { title: 'T', bannerImage: '/images/a.jpg' };
  const form = render(pageSchema, stored);
  type(form, 'title', 'T2');
  assert.deepEqual(fg.extractFormData(form, pageSchema), { title: 'T2', bannerImage: '/images/a.jpg' });
});

await check('inside a list item edited in the item modal', async () => {
  const schema = toSchema(z.object({
    title: z.string(),
    slides: z.array(z.object({ heading: z.string(), bannerImage: z.string(), bannerAlt: z.string().optional() })),
  }));
  const stored = { title: 'T', slides: [{ heading: 'H', bannerImage: '/images/a.jpg', bannerImageAlt: 'Typed earlier' }] };
  const form = render(schema, stored);
  form.querySelector('.array-card-edit[data-edit-card="0"]').click();
  for (let i = 0; i < 100 && !document.querySelector('.array-item-edit-overlay'); i++) await new Promise((r) => setTimeout(r, 5));
  const overlay = document.querySelector('.array-item-edit-overlay');
  assert.equal(overlay.querySelector('[name="bannerAlt"]').value, 'Typed earlier');
  type(overlay, 'heading', 'H2');
  overlay.querySelector('[data-save]').click();
  const saved = fg.extractFormData(form, schema);
  assert.equal(saved.slides[0].bannerAlt, 'Typed earlier');
  assert.equal(saved.slides[0].heading, 'H2');
  assert.equal('bannerImageAlt' in saved.slides[0], false, `the old key is moved, not copied: ${JSON.stringify(saved.slides[0])}`);
});

const cardSchema = toSchema(z.object({
  title: z.string(),
  cards: z.array(z.object({ label: z.string(), bannerImage: z.string().optional(), bannerAlt: z.string().optional() })),
}));
const storedCards = () => ({ title: 'T', cards: [{ label: 'L', bannerImage: '/i.jpg', bannerImageAlt: 'old' }] });

async function openCard(form, index) {
  const before = document.querySelectorAll('.array-item-edit-overlay').length;
  form.querySelector(`.array-card-edit[data-edit-card="${index}"]`).click();
  for (let i = 0; i < 100 && document.querySelectorAll('.array-item-edit-overlay').length === before; i++) await new Promise((r) => setTimeout(r, 5));
  const overlays = document.querySelectorAll('.array-item-edit-overlay');
  return overlays[overlays.length - 1];
}

await check('item modal: an untouched Done moves the old key to the declared alt', async () => {
  const form = render(cardSchema, storedCards());
  const overlay = await openCard(form, 0);
  overlay.querySelector('[data-save]').click();
  assert.deepEqual(fg.extractFormData(form, cardSchema).cards[0], { label: 'L', bannerImage: '/i.jpg', bannerAlt: 'old' });
});

await check('item modal: an edited alt replaces the old key', async () => {
  const form = render(cardSchema, storedCards());
  const overlay = await openCard(form, 0);
  type(overlay, 'bannerAlt', 'new');
  overlay.querySelector('[data-save]').click();
  assert.deepEqual(fg.extractFormData(form, cardSchema).cards[0], { label: 'L', bannerImage: '/i.jpg', bannerAlt: 'new' });
});

await check('item modal: a cleared alt stays cleared, saved and reopened', async () => {
  const form = render(cardSchema, storedCards());
  let overlay = await openCard(form, 0);
  type(overlay, 'bannerAlt', '');
  overlay.querySelector('[data-save]').click();
  assert.deepEqual(fg.extractFormData(form, cardSchema).cards[0], { label: 'L', bannerImage: '/i.jpg' });
  overlay = await openCard(form, 0);
  assert.equal(overlay.querySelector('[name="bannerAlt"]').value, '', 'the old text does not come back');
});

await check('item modal: an old key beside a declared alt with its own text is left alone (control)', async () => {
  const stored = { title: 'T', cards: [{ label: 'L', bannerImage: '/i.jpg', bannerAlt: 'own', bannerImageAlt: 'old' }] };
  const form = render(cardSchema, stored);
  const overlay = await openCard(form, 0);
  type(overlay, 'label', 'L2');
  overlay.querySelector('[data-save]').click();
  assert.deepEqual(fg.extractFormData(form, cardSchema).cards[0], { label: 'L2', bannerImage: '/i.jpg', bannerAlt: 'own', bannerImageAlt: 'old' });
});

await check('inside a block, with a sibling in the block edited', () => {
  // Block lists carry blockTypes (the dashboard adds it from the union).
  const hero = toSchema(z.object({ type: z.literal('hero'), heading: z.string(), bannerImage: z.string(), bannerAlt: z.string().optional() }));
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' }, blocks: { type: 'array', blockTypes: { hero }, items: { anyOf: [hero] } } },
    required: ['title', 'blocks'],
  };
  const stored = { title: 'T', blocks: [{ type: 'hero', heading: 'H', bannerImage: '/images/a.jpg', bannerImageAlt: 'Typed earlier' }] };
  const form = render(schema, stored);
  assert.equal(form.querySelector('[name="blocks[0].bannerAlt"]').value, 'Typed earlier');
  type(form, 'blocks[0].heading', 'H2');
  const saved = fg.extractFormData(form, schema);
  assert.equal(saved.blocks[0].bannerAlt, 'Typed earlier', JSON.stringify(saved.blocks[0]));
  assert.equal(saved.blocks[0].heading, 'H2');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
