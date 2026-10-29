/**
 * What the array item modal saves, through the real card Edit button, the
 * real item modal (ui/array-editor.js), Done, and extractFormData: real
 * renderer and handlers in happy-dom, schemas from real zod 4.
 *
 * Pins:
 *   - a field the editor emptied in the modal is gone from the saved item,
 *     whichever step left it out: an empty number box (#61, readFields leaves
 *     its key out), not only an optional "" or [] that cleanup drops. The
 *     modal merges the item it was opened with under what it read, so a key
 *     left out by the read came back as stored (a cleared number saved its
 *     old value). Optional and required numbers, a number inside an object
 *     field of the item, and a file() entry that is one list of cards.
 *   - controls: a cleared nullable saves null, an emptied optional list is
 *     dropped, an untouched item is its stored self (an unrendered property
 *     included), and a property the schema does not render is kept.
 *
 *   bun tests/modal-item-save.test.js
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

// The same serializer the schema parser uses for a zod 4 site.
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

async function openCard(form, index) {
  form.querySelector(`.array-card-edit[data-edit-card="${index}"]`).click();
  for (let i = 0; i < 100 && !document.querySelector('.array-item-edit-overlay'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const overlay = document.querySelector('.array-item-edit-overlay');
  assert.ok(overlay, 'the item modal opened');
  return overlay;
}

function type(root, name, value) {
  const control = root.querySelector(`[name="${name}"]`);
  assert.ok(control, `a control named ${name}`);
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

function done(overlay) {
  overlay.querySelector('[data-save]').click();
  assert.equal(document.querySelector('.array-item-edit-overlay'), null, 'the modal closed');
}

const statsSchema = toSchema(z.object({
  title: z.string(),
  stats: z.array(z.object({
    label: z.string(),
    value: z.number().optional(),
    total: z.number(),
    note: z.string().nullable(),
    tags: z.array(z.string()).optional(),
    meta: z.object({ count: z.number().optional(), unit: z.string() }),
  })),
}));
const statsData = () => ({
  title: 'T',
  stats: [
    { label: 'Visitors', value: 1200, total: 5, note: 'n', tags: ['a'], meta: { count: 3, unit: 'u' }, legacy: 'kept' },
    { label: 'B', value: 2, total: 7, note: 'm', meta: { count: 1, unit: 'v' } },
  ],
});

await check('a cleared optional number is gone after Done', async () => {
  const data = statsData();
  const form = render(statsSchema, data);
  const overlay = await openCard(form, 0);
  type(overlay, 'value', '');
  done(overlay);
  const saved = fg.extractFormData(form, statsSchema);
  assert.equal('value' in saved.stats[0], false, `saved ${JSON.stringify(saved.stats[0])}`);
  assert.deepEqual(saved.stats[1], statsData().stats[1], 'the other card is as stored');
  assert.equal(saved.stats[0].label, 'Visitors', 'positive control: the rest of the card stays');
});

await check('a cleared required number is gone after Done (it is not quietly its old value)', async () => {
  const form = render(statsSchema, statsData());
  const overlay = await openCard(form, 0);
  type(overlay, 'total', '');
  done(overlay);
  const saved = fg.extractFormData(form, statsSchema);
  assert.equal('total' in saved.stats[0], false, `saved ${JSON.stringify(saved.stats[0])}`);
});

await check('a cleared number inside an object field of the item is gone after Done', async () => {
  const form = render(statsSchema, statsData());
  const overlay = await openCard(form, 0);
  type(overlay, 'meta.count', '');
  done(overlay);
  const saved = fg.extractFormData(form, statsSchema);
  assert.deepEqual(saved.stats[0].meta, { unit: 'u' }, `saved ${JSON.stringify(saved.stats[0])}`);
});

await check('a number edited in the modal saves the new number (positive control)', async () => {
  const form = render(statsSchema, statsData());
  const overlay = await openCard(form, 0);
  type(overlay, 'value', '42');
  done(overlay);
  const saved = fg.extractFormData(form, statsSchema);
  assert.strictEqual(saved.stats[0].value, 42);
  assert.strictEqual(saved.stats[0].total, 5, 'an untouched number keeps its value');
});

await check('a cleared nullable saves null, an emptied optional list is dropped', async () => {
  const form = render(statsSchema, statsData());
  const overlay = await openCard(form, 0);
  type(overlay, 'note', '');
  overlay.querySelector('[data-field="tags"] .remove-array-item').click();
  done(overlay);
  const saved = fg.extractFormData(form, statsSchema);
  assert.strictEqual(saved.stats[0].note, null);
  assert.equal('tags' in saved.stats[0], false, `saved ${JSON.stringify(saved.stats[0])}`);
});

await check('Done with nothing edited keeps the item as stored, an unrendered property included', async () => {
  const form = render(statsSchema, statsData());
  const overlay = await openCard(form, 0);
  done(overlay);
  const saved = fg.extractFormData(form, statsSchema);
  assert.deepEqual(saved.stats[0], statsData().stats[0]);
});

await check('an unrendered property survives an edit of a sibling', async () => {
  const form = render(statsSchema, statsData());
  const overlay = await openCard(form, 0);
  type(overlay, 'label', 'People');
  done(overlay);
  const saved = fg.extractFormData(form, statsSchema);
  assert.equal(saved.stats[0].legacy, 'kept');
  assert.equal(saved.stats[0].label, 'People');
});

const menuSchema = toSchema(z.array(z.object({ label: z.string(), value: z.number().optional() })));
await check('a file() entry that is one list of cards: a cleared number is gone after Done', async () => {
  const data = [{ label: 'Visitors', value: 1200 }, { label: 'B', value: 2 }];
  const form = render(menuSchema, data);
  const overlay = await openCard(form, 0);
  type(overlay, 'value', '');
  done(overlay);
  const saved = fg.extractFormData(form, menuSchema);
  assert.deepEqual(saved, [{ label: 'Visitors' }, { label: 'B', value: 2 }]);
});

// A new block or card starts with nothing in an optional number (unless the
// schema has a default): 0 is a value nobody chose, saved as if they had.
const counted = toSchema(z.object({
  type: z.literal('stat'),
  label: z.string(),
  count: z.number().optional(),
  total: z.number(),
  rank: z.number().default(3),
}));
await check('a new block: an optional number starts empty and is left out; a required one is 0; a default is kept', () => {
  const schema = { type: 'object', properties: { blocks: { type: 'array', blockTypes: { stat: counted }, items: { anyOf: [counted] } } }, required: ['blocks'] };
  const form = render(schema, { blocks: [] });
  form.querySelector('.add-block-type').value = 'stat';
  form.querySelector('.add-block-btn').click();
  assert.equal(form.querySelector('[name="blocks[0].count"]').value, '', 'the optional number box is empty');
  const saved = fg.extractFormData(form, schema);
  assert.equal('count' in saved.blocks[0], false, `saved ${JSON.stringify(saved.blocks[0])}`);
  assert.strictEqual(saved.blocks[0].total, 0);
  assert.strictEqual(saved.blocks[0].rank, 3);
});

await check('a new card: an optional number starts empty and is left out', async () => {
  const schema = toSchema(z.object({ title: z.string(), stats: z.array(z.object({ label: z.string(), count: z.number().optional(), total: z.number() })) }));
  const form = render(schema, { title: 'T', stats: [] });
  form.querySelector('[data-add-array-card]').click();
  for (let i = 0; i < 100 && !document.querySelector('.array-item-edit-overlay'); i++) await new Promise((r) => setTimeout(r, 5));
  const overlay = document.querySelector('.array-item-edit-overlay');
  assert.equal(overlay.querySelector('[name="count"]').value, '', 'the optional number box is empty');
  type(overlay, 'label', 'New');
  done(overlay);
  const saved = fg.extractFormData(form, schema);
  assert.deepEqual(saved.stats, [{ label: 'New', total: 0 }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
