/**
 * What a NEW block, card or entry saves when the editor fills in only one
 * field, through the real renderer, its handlers and extractFormData in
 * happy-dom, with schemas from real zod 4. Each saved value is parsed by the
 * zod schema it came from, so a value the site's build would refuse fails here.
 *
 * Pins:
 *   - a nullable number (`type: ['number', 'null']`) starts as null when it is
 *     required and is left out when it is optional, in a new block, a new card
 *     and a new entry; a '' saved there failed the publish check, and nothing
 *     in the editor said why;
 *   - a required number inside a required object of a new block or card
 *     starts at 0, as a required number of the block itself does, so the
 *     object is not saved as `{}`;
 *   - a nullable number the editor left alone in a STORED block keeps its
 *     stored value (control: the rule is for what the DOM produced).
 *
 *   bun tests/new-block-values.test.js
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
globalThis.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '' });

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
    console.log(`❌ ${name}\n   ${error.message.split('\n').slice(0, 12).join('\n   ')}`);
  }
}

const toSchema = (zodSchema) => z.toJSONSchema(zodSchema, { reused: 'inline', unrepresentable: 'any', io: 'input' });

function render(schema, data, { bind = true } = {}) {
  document.body.innerHTML = '';
  const form = document.createElement('form');
  form.innerHTML = fg.generateForm(schema, data);
  document.body.appendChild(form);
  fg.setupFormHandlers(form, () => {});
  if (bind) fg.bindOriginalValues(form, data);
  return form;
}

function type(root, name, value) {
  const control = root.querySelector(`[name="${name}"]`);
  assert.ok(control, `a control named ${name}`);
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

function assertValid(zodSchema, value) {
  const result = zodSchema.safeParse(value);
  assert.ok(result.success, `the schema refuses ${JSON.stringify(value)}: ${JSON.stringify(result.error?.issues)}`);
}

const numberFields = {
  label: z.string(),
  nn: z.number().nullable(),
  on: z.number().nullable().optional(),
  d: z.number().default(4),
  req: z.number(),
  obj: z.object({ c: z.number(), o: z.number().optional() }),
};
const blockZod = z.object({ type: z.literal('s'), ...numberFields });
const block = toSchema(blockZod);
const blockPage = {
  type: 'object',
  properties: { title: { type: 'string' }, blocks: { type: 'array', blockTypes: { s: block }, items: { anyOf: [block] } } },
  required: ['title', 'blocks'],
};

await check('a new block: nullable numbers null or absent, nested required number 0', () => {
  const form = render(blockPage, { title: 'T', blocks: [] });
  form.querySelector('.add-block-type').value = 's';
  form.querySelector('.add-block-btn').click();
  type(form, 'blocks[0].label', 'x');
  const saved = fg.extractFormData(form, blockPage);
  const newBlock = saved.blocks[0];
  assert.deepEqual(newBlock, { type: 's', label: 'x', nn: null, d: 4, req: 0, obj: { c: 0 } }, JSON.stringify(newBlock));
  assert.deepEqual(fg.blankOptionalPaths(saved), [], 'no blank left for the server to judge');
  assertValid(blockZod, newBlock);
});

await check('a stored block keeps its stored nullable numbers when a sibling changes (control)', () => {
  const stored = { title: 'T', blocks: [{ type: 's', label: 'a', nn: 3, on: null, req: 1, obj: { c: 2 } }] };
  const form = render(blockPage, stored);
  type(form, 'blocks[0].label', 'b');
  assert.deepEqual(fg.extractFormData(form, blockPage).blocks[0], { ...stored.blocks[0], label: 'b' });
});

const cardZod = z.object(numberFields);
const cardPageZod = z.object({ title: z.string(), stats: z.array(cardZod) });
const cardPage = toSchema(cardPageZod);

await check('a new card: nullable numbers null or absent, nested required number 0', async () => {
  const form = render(cardPage, { title: 'T', stats: [] });
  form.querySelector('[data-add-array-card]').click();
  for (let i = 0; i < 100 && !document.querySelector('.array-item-edit-overlay'); i++) await new Promise((r) => setTimeout(r, 5));
  const overlay = document.querySelector('.array-item-edit-overlay');
  type(overlay, 'label', 'New');
  overlay.querySelector('[data-save]').click();
  const saved = fg.extractFormData(form, cardPage);
  assert.deepEqual(saved.stats[0], { label: 'New', d: 4, req: 0, obj: { c: 0 }, nn: null }, JSON.stringify(saved.stats[0]));
  assertValid(cardPageZod, saved);
});

const entryZod = z.object({ title: z.string(), nn: z.number().nullable(), on: z.number().nullable().optional() });
const entrySchema = toSchema(entryZod);

await check('a new entry: a required nullable number is null, an optional one absent', () => {
  const form = render(entrySchema, {}, { bind: false });
  type(form, 'title', 'X');
  const saved = fg.extractFormData(form, entrySchema);
  assert.deepEqual(saved, { title: 'X', nn: null });
  assertValid(entryZod, saved);
});

// --- Key order: a new object is saved in the order the form shows it ---------

const literalBlockZod = z.object({ type: z.literal('s'), n: z.literal(5), label: z.string() });
const literalBlock = toSchema(literalBlockZod);
const literalPage = {
  type: 'object',
  properties: { title: { type: 'string' }, blocks: { type: 'array', blockTypes: { s: literalBlock }, items: { anyOf: [literalBlock] } } },
  required: ['title', 'blocks'],
};

await check('a new block holding a number literal keeps `type` first and the schema order', () => {
  const form = render(literalPage, { title: 'T', blocks: [] });
  form.querySelector('.add-block-type').value = 's';
  form.querySelector('.add-block-btn').click();
  type(form, 'blocks[0].label', 'x');
  assert.equal(JSON.stringify(fg.extractFormData(form, literalPage).blocks[0]), '{"type":"s","n":5,"label":"x"}');
});

await check('a new entry holding a number literal keeps the schema order', () => {
  const schema = toSchema(z.object({ title: z.string(), f: z.literal(5), tags: z.array(z.literal(1)) }));
  const form = render(schema, {}, { bind: false });
  type(form, 'title', 'X');
  assert.equal(JSON.stringify(fg.extractFormData(form, schema)), '{"title":"X","f":5,"tags":[]}');
});

await check('a hidden schema field is saved in its schema place, under its own key even with a dot in it', () => {
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' }, 'a.b': { type: 'string', hidden: true }, 'c[0]': { type: 'number', hidden: true }, after: { type: 'string' } },
    required: ['title', 'after'],
  };
  const stored = { title: 'T', 'a.b': 'kept', 'c[0]': 3, after: 'z' };
  const form = render(schema, stored);
  type(form, 'title', 'T2');
  assert.equal(JSON.stringify(fg.extractFormData(form, schema)), JSON.stringify({ ...stored, title: 'T2' }));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
