/**
 * Fields whose values are a fixed set of literals, through the real
 * renderer, binding and extractFormData in happy-dom, with schemas from real
 * zod 4 and the shapes zod 3's converter gives.
 *
 * A union of literals (`z.union([z.literal(1), z.literal(2)])`, an `anyOf`
 * of consts with no `type`) used to be a free-text textarea that saved "1";
 * zod 3's `{type: 'number', enum: [1, 2]}` was a free number box; a list of
 * one literal (`z.array(z.literal(5))`) was a list of editable number boxes.
 * Pins:
 *   - a union of literals, or an enum holding a non-string, is a select
 *     whose options carry their JSON type (a number saves as a number, null
 *     as null), with "Not set" when the schema allows null;
 *   - a list of one literal shows its items as fixed text; adding an item
 *     adds the literal;
 *   - an untouched value round-trips byte-identically in a bound form,
 *     including one that is not among the choices;
 *   - a NEW block or card starts its literal unions on "Choose..." (zod 4's
 *     anyOf of consts used to be seeded '', zod 3's number enum 0, which the
 *     select showed as chosen and the save wrote), and "Choose..." is read
 *     as nothing chosen: absent, for a required key too, never "";
 *   - a string enum is still the plain select (control).
 *
 *   bun tests/literal-fields.test.js
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
    console.log(`❌ ${name}\n   ${error.message.split('\n').slice(0, 12).join('\n   ')}`);
  }
}

const toSchema = (zodSchema) => z.toJSONSchema(zodSchema, { reused: 'inline', unrepresentable: 'any', io: 'input' });

function render(schema, data, { bind = true } = {}) {
  document.body.innerHTML = '';
  const form = document.createElement('form');
  form.innerHTML = fg.generateForm(schema, data);
  document.body.appendChild(form);
  // happy-dom 20 mis-selects a <select> parsed from HTML (see extract-fields).
  for (const select of form.querySelectorAll('select')) {
    const marked = [...select.options].findIndex((option) => option.hasAttribute('selected'));
    if (marked >= 0) select.selectedIndex = marked;
  }
  fg.setupFormHandlers(form, () => {});
  if (bind) fg.bindOriginalValues(form, data);
  return form;
}

function type(root, name, value) {
  const control = root.querySelector(`[name="${name}"]`);
  assert.ok(control, `a control named ${name}`);
  if (control.tagName === 'SELECT') {
    // happy-dom's FormData reads the option selected by index, not by value.
    const index = [...control.options].findIndex((option) => option.value === value);
    assert.ok(index >= 0, `${name} has an option ${value}`);
    control.selectedIndex = index;
  } else {
    control.value = value;
  }
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

const optionValues = (select) => [...select.options].map((option) => option.value);

const unionZod = z.object({
  title: z.string(),
  f: z.union([z.literal(1), z.literal(2)]),
  mixed: z.union([z.literal(1), z.literal('a'), z.null()]),
  maybe: z.union([z.literal(1), z.literal(2)]).nullable().optional(),
  g: z.array(z.literal(5)),
});
const unionSchema = toSchema(unionZod);
const stored = () => ({ title: 'T', f: 2, mixed: 'a', maybe: null, g: [5, 5] });

await check('a union of literals is a select whose options carry their JSON type', () => {
  const form = render(unionSchema, stored());
  const select = form.querySelector('select[name="f"]');
  assert.ok(select, `a select: ${form.querySelector('[name="f"]')?.outerHTML}`);
  assert.deepEqual(optionValues(select), ['1', '2']);
  assert.equal(select.value, '2', 'the stored value is selected');
  assert.deepEqual(optionValues(form.querySelector('select[name="mixed"]')), ['null', '1', '"a"']);
  assert.deepEqual(optionValues(form.querySelector('select[name="maybe"]')), ['null', '1', '2'], 'a nullable union offers Not set');
});

await check('choosing an option saves it with its type', () => {
  const form = render(unionSchema, stored());
  type(form, 'f', '1');
  type(form, 'mixed', '1');
  type(form, 'maybe', '2');
  const saved = fg.extractFormData(form, unionSchema);
  assert.strictEqual(saved.f, 1);
  assert.strictEqual(saved.mixed, 1);
  assert.strictEqual(saved.maybe, 2);
  assert.ok(unionZod.safeParse(saved).success, JSON.stringify(saved));
  type(form, 'mixed', 'null');
  assert.strictEqual(fg.extractFormData(form, unionSchema).mixed, null, 'Not set saves null');
});

await check('a list of one literal shows fixed values, and adding an item adds the literal', () => {
  const form = render(unionSchema, stored());
  const list = form.querySelector('.array-field[data-field="g"]');
  assert.equal(list.querySelectorAll('input[type="number"], input[type="text"], textarea').length, 0, `no editable box: ${list.innerHTML}`);
  assert.match(list.textContent, /5/, 'the value is shown');
  list.querySelector('.add-array-item').click();
  const saved = fg.extractFormData(form, unionSchema);
  assert.deepStrictEqual(saved.g, [5, 5, 5]);
});

await check('untouched literal fields round-trip byte-identically when the title is edited', () => {
  for (const data of [stored(), { title: 'T', f: 1, mixed: null, g: [] }, { title: 'T', f: '1', mixed: 'b', maybe: 7, g: [5, '5'] }]) {
    const form = render(unionSchema, data);
    type(form, 'title', 'T2');
    assert.equal(JSON.stringify(fg.extractFormData(form, unionSchema)), JSON.stringify({ ...data, title: 'T2' }));
  }
});

await check('a stored value not among the choices is shown, not replaced by the first option', () => {
  const form = render(unionSchema, { title: 'T', f: '1', mixed: 'a', g: [] });
  const select = form.querySelector('select[name="f"]');
  assert.equal(select.value, '"1"', select.outerHTML);
});

await check("zod 3's shape, an enum holding numbers, is the same typed select", () => {
  const schema = { type: 'object', properties: { title: { type: 'string' }, n: { type: 'number', enum: [1, 2] }, m: { type: ['number', 'string'], enum: [1, 'a'] } }, required: ['title', 'n', 'm'] };
  const form = render(schema, { title: 'T', n: 1, m: 'a' });
  assert.ok(form.querySelector('select[name="n"]'), 'n is a select');
  type(form, 'n', '2');
  type(form, 'm', '1');
  const saved = fg.extractFormData(form, schema);
  assert.strictEqual(saved.n, 2);
  assert.strictEqual(saved.m, 1);
});

await check('a list whose items are a union of literals is a list of typed selects', () => {
  const schema = toSchema(z.object({ title: z.string(), h: z.array(z.union([z.literal(1), z.literal(2)])) }));
  const form = render(schema, { title: 'T', h: [1] });
  type(form, 'h[0]', '2');
  assert.deepStrictEqual(fg.extractFormData(form, schema).h, [2]);
});

await check('with no value, nothing is chosen for the editor: an optional one stays absent in a new entry', () => {
  const schema = toSchema(z.object({ title: z.string(), f: z.union([z.literal(1), z.literal(2)]).optional() }));
  const form = render(schema, {}, { bind: false });
  const select = form.querySelector('select[name="f"]');
  assert.equal(select.value, '', 'a placeholder is selected, not the first literal');
  type(form, 'title', 'X');
  assert.deepStrictEqual(fg.extractFormData(form, schema), { title: 'X' });
  type(form, 'f', '2');
  assert.deepStrictEqual(fg.extractFormData(form, schema), { title: 'X', f: 2 }, 'positive control: a choice is saved');
});

await check('a string enum is still the plain select (control)', () => {
  const schema = toSchema(z.object({ title: z.string(), e: z.enum(['x', 'y']) }));
  const form = render(schema, { title: 'T', e: 'y' });
  const select = form.querySelector('select[name="e"]');
  assert.deepEqual(optionValues(select), ['x', 'y']);
  assert.equal(select.dataset.valueType, undefined);
  type(form, 'e', 'x');
  assert.strictEqual(fg.extractFormData(form, schema).e, 'x');
});

// --- New blocks and cards: a literal union starts on "Choose..." ------------
//
// createEmptyBlock / createEmptyArrayItem used to seed a union of literals
// with '' (zod 4's anyOf of consts) or 0 (zod 3's {type: 'number', enum}),
// which literalSelect then showed as a stored value: "Choose..." never
// appeared and the unchosen value was saved, which zod refuses.

const waitFor = async (selector) => {
  for (let i = 0; i < 200 && !document.querySelector(selector); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  return document.querySelector(selector);
};
const selectedValues = (select) => [...select.options].filter((option) => option.selected).map((option) => option.value);
function fixSelected(root) {
  for (const select of root.querySelectorAll('select')) {
    const marked = [...select.options].findIndex((option) => option.hasAttribute('selected'));
    if (marked >= 0) select.selectedIndex = marked;
  }
}

const literalBlockZod = z.object({
  type: z.literal('s'),
  label: z.string(),
  size: z.union([z.literal(1), z.literal(2)]),
  sizeOpt: z.union([z.literal(1), z.literal(2)]).optional(),
  lvl: z.union([z.literal('a'), z.literal('b')]),
});
const literalBlock = toSchema(literalBlockZod);
const literalBlockPage = {
  type: 'object',
  properties: { title: { type: 'string' }, blocks: { type: 'array', blockTypes: { s: literalBlock }, items: { anyOf: [literalBlock] } } },
  required: ['title', 'blocks'],
};
// zod 3's converter gives a union of number literals as {type: 'number', enum}.
const zod3Block = { type: 'object', properties: { type: { type: 'string', const: 't' }, label: { type: 'string' }, n: { type: 'number', enum: [1, 2] } }, required: ['type', 'label', 'n'] };
const zod3BlockPage = {
  type: 'object',
  properties: { title: { type: 'string' }, blocks: { type: 'array', blockTypes: { t: zod3Block }, items: { anyOf: [zod3Block] } } },
  required: ['title', 'blocks'],
};

function addBlock(form, blockType) {
  form.querySelector('.add-block-type').value = blockType;
  form.querySelector('.add-block-btn').click();
  fixSelected(form);
}

await check('a new block (zod 4): its literal unions start on Choose... and are not saved until chosen', () => {
  const form = render(literalBlockPage, { title: 'T', blocks: [] });
  addBlock(form, 's');
  for (const name of ['size', 'sizeOpt', 'lvl']) {
    const select = form.querySelector(`select[name="blocks[0].${name}"]`);
    assert.deepEqual(selectedValues(select), [''], `${name} starts on Choose...: ${select.outerHTML}`);
  }
  type(form, 'blocks[0].label', 'x');
  assert.deepStrictEqual(fg.extractFormData(form, literalBlockPage).blocks[0], { type: 's', label: 'x' });
  type(form, 'blocks[0].size', '2');
  type(form, 'blocks[0].lvl', '"b"');
  const chosen = fg.extractFormData(form, literalBlockPage).blocks[0];
  assert.deepStrictEqual(chosen, { type: 's', label: 'x', size: 2, lvl: 'b' }, 'positive control: choices are saved');
  assert.ok(literalBlockZod.safeParse(chosen).success, JSON.stringify(chosen));
});

await check("a new block (zod 3's number enum): starts on Choose..., not 0", () => {
  const form = render(zod3BlockPage, { title: 'T', blocks: [] });
  addBlock(form, 't');
  assert.deepEqual(selectedValues(form.querySelector('select[name="blocks[0].n"]')), ['']);
  type(form, 'blocks[0].label', 'x');
  assert.deepStrictEqual(fg.extractFormData(form, zod3BlockPage).blocks[0], { type: 't', label: 'x' });
});

await check('a new card: literal unions (zod 3 shape and zod 4) start on Choose... and are not saved', async () => {
  const card = { type: 'object', properties: { label: { type: 'string' }, n: { type: 'number', enum: [1, 2] }, m: literalBlock.properties.size }, required: ['label', 'n', 'm'] };
  const cardPage = { type: 'object', properties: { title: { type: 'string' }, stats: { type: 'array', items: card } }, required: ['title', 'stats'] };
  const form = render(cardPage, { title: 'T', stats: [] });
  form.querySelector('[data-add-array-card]').click();
  const overlay = await waitFor('.array-item-edit-overlay');
  fixSelected(overlay);
  for (const name of ['n', 'm']) {
    assert.deepEqual(selectedValues(overlay.querySelector(`select[name="${name}"]`)), [''], `${name} starts on Choose...`);
  }
  type(overlay, 'label', 'New');
  overlay.querySelector('[data-save]').click();
  assert.deepStrictEqual(fg.extractFormData(form, cardPage).stats[0], { label: 'New' });
});

await check('createEmptyBlock / createEmptyArrayItem leave a literal union absent; a default still wins', () => {
  const schema = toSchema(z.object({
    type: z.literal('s'),
    a: z.union([z.literal(1), z.literal(2)]),
    b: z.union([z.literal(1), z.literal(2)]).nullable(),
    c: z.union([z.literal(1), z.literal(2)]).default(2),
    n: z.number(),
  }));
  assert.deepStrictEqual(fg.createEmptyBlock('s', schema), { type: 's', c: 2, n: 0 });
  const { type: _type, ...cardProps } = schema.properties;
  const cardSchema = { type: 'object', properties: { ...cardProps, z3: { type: 'number', enum: [1, 2] } }, required: ['a', 'b', 'n', 'z3'] };
  assert.deepStrictEqual(fg.createEmptyArrayItem(cardSchema), { c: 2, n: 0 });
});

// --- "Choose..." is read as nothing chosen (readFields) ---------------------
//
// A literal option's value is its JSON (`""` for an empty-string literal), so
// the placeholder's '' is never a value: it is left out wherever it is, a
// required key at the top level and an optional one inside a block alike.

await check('a REQUIRED literal union left on Choose... is absent, not ""', () => {
  const schema = toSchema(z.object({ title: z.string(), f: z.union([z.literal(1), z.literal(2)]) }));
  const form = render(schema, {}, { bind: false });
  assert.equal(form.querySelector('select[name="f"]').value, '');
  type(form, 'title', 'X');
  assert.deepStrictEqual(fg.extractFormData(form, schema), { title: 'X' });
});

await check('an optional literal union chosen and put back on Choose... in a stored block stays absent', () => {
  // Back at its baseline the control counts as untouched, so binding gives
  // it its stored absence; the read branch itself is pinned by the new block
  // (an optional union, unbound, inside a block) and new entry checks.
  const stored = { title: 'T', blocks: [{ type: 's', label: 'a', size: 1, lvl: 'a' }] };
  const form = render(literalBlockPage, stored);
  assert.equal(form.querySelector('select[name="blocks[0].sizeOpt"]').value, '');
  type(form, 'blocks[0].sizeOpt', '2');
  assert.strictEqual(fg.extractFormData(form, literalBlockPage).blocks[0].sizeOpt, 2, 'positive control: the choice is saved');
  type(form, 'blocks[0].sizeOpt', '');
  type(form, 'blocks[0].label', 'b');
  assert.deepStrictEqual(fg.extractFormData(form, literalBlockPage).blocks[0], { ...stored.blocks[0], label: 'b' });
});

await check('an empty-string literal is a choice of its own (""), distinct from Choose...', () => {
  const schema = toSchema(z.object({ title: z.string(), e: z.union([z.literal(''), z.literal(1)]) }));
  const form = render(schema, {}, { bind: false });
  assert.deepEqual(optionValues(form.querySelector('select[name="e"]')), ['', '""', '1']);
  type(form, 'title', 'X');
  assert.deepStrictEqual(fg.extractFormData(form, schema), { title: 'X' });
  type(form, 'e', '""');
  assert.deepStrictEqual(fg.extractFormData(form, schema), { title: 'X', e: '' }, 'the "" literal is saved when chosen');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
