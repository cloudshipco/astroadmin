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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
