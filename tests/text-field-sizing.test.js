/**
 * Text field sizing (#87), through the real renderer, the real widget wiring
 * and real zod 4 `.meta()`.
 *
 * Pins:
 *   - a string that is not a one-line field by name is a textarea sized to
 *     its content, two rows at least: a short value (`Photo: A. Person`) is
 *     not a four-row box. Long text still starts tall, and auto-grow still
 *     grows it (capped at 400px, borders counted), and never shrinks it
 *     below its rows. Setting up a form fits each textarea to its content
 *     once (the rows are a guess from the character count).
 *   - `.meta({ multiline: false })` makes a one-line input, even for a name
 *     that is always a textarea (`description`); `.meta({ multiline: true })`
 *     makes a textarea of a one-line name (`title`).
 *   - a stored value holding a line break stays a textarea whatever the meta
 *     says: an input would drop the break on the first edit.
 *
 *   bun tests/text-field-sizing.test.js
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

const { generateForm, extractFormData, setupFormHandlers, bindOriginalValues } = await import('../ui/form-generator.js');
const { autoGrowTextarea } = await import('../ui/field-widgets.js');

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

function render(formSchema, data) {
  document.body.innerHTML = '';
  const form = document.createElement('form');
  form.innerHTML = generateForm(formSchema, data);
  document.body.appendChild(form);
  setupFormHandlers(form, () => {});
  bindOriginalValues(form, data);
  return form;
}

const control = (form, name) => form.querySelector(`[name="${name}"]`);

await check('a short value is a two-row textarea, not four', () => {
  const form = render(toSchema(z.object({ attribution: z.string(), caption: z.string() })), { attribution: 'Photo: A. Person', caption: '' });
  for (const name of ['attribution', 'caption']) {
    const textarea = control(form, name);
    assert.equal(textarea.tagName, 'TEXTAREA', `${name} is still a textarea`);
    assert.ok(Number(textarea.getAttribute('rows')) <= 2, `${name}: rows="${textarea.getAttribute('rows')}"`);
  }
});

await check('long text still starts tall', () => {
  const longText = 'A sentence about the place and the people in it. '.repeat(12);
  const form = render(toSchema(z.object({ summary: z.string(), notes: z.string() })), { summary: longText, notes: 'one\ntwo\nthree\nfour\nfive' });
  assert.ok(Number(control(form, 'summary').getAttribute('rows')) >= 10, `summary rows="${control(form, 'summary').getAttribute('rows')}"`);
  assert.equal(control(form, 'notes').getAttribute('rows'), '5', 'one row per line');
});

await check('auto-grow fits the content and never forces a 100px box', () => {
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  let contentHeight = 48;
  Object.defineProperty(textarea, 'scrollHeight', { get: () => contentHeight });
  autoGrowTextarea(textarea);
  assert.equal(textarea.style.height, '48px', 'a two-row box stays two rows');
  contentHeight = 900;
  autoGrowTextarea(textarea);
  assert.equal(textarea.style.height, '400px', 'capped');
  // A textarea that is not laid out (inside a collapsed block) measures 0:
  // giving it a 0px height would leave it collapsed when the block opens.
  contentHeight = 0;
  autoGrowTextarea(textarea);
  assert.notEqual(textarea.style.height, '0px', 'an unmeasured textarea keeps its rows');
});

await check('typing grows a textarea through the real input handler', () => {
  const form = render(toSchema(z.object({ attribution: z.string() })), { attribution: 'Short' });
  const textarea = control(form, 'attribution');
  Object.defineProperty(textarea, 'scrollHeight', { get: () => 120 });
  textarea.value = 'Short\nand now\nlonger\nand longer';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(textarea.style.height, '120px');
});

await check('auto-grow counts the borders, so the last line is not cut off', () => {
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  Object.defineProperty(textarea, 'scrollHeight', { get: () => 96 });
  Object.defineProperty(textarea, 'offsetHeight', { get: () => 58 });
  Object.defineProperty(textarea, 'clientHeight', { get: () => 56 });
  autoGrowTextarea(textarea);
  assert.equal(textarea.style.height, '98px', 'border-box: scrollHeight plus the 2px of borders');
});

await check('each textarea is fitted to its content when the form is set up', () => {
  const prototype = window.HTMLTextAreaElement.prototype;
  const own = Object.getOwnPropertyDescriptor(prototype, 'scrollHeight');
  Object.defineProperty(prototype, 'scrollHeight', { configurable: true, get() { return this.value.length > 100 ? 300 : 0; } });
  try {
    const form = render(toSchema(z.object({ summary: z.string(), caption: z.string() })), { summary: 'x'.repeat(200), caption: 'Short' });
    assert.equal(control(form, 'summary').style.height, '300px', 'a long value wraps more than its rows guessed');
    assert.notEqual(control(form, 'caption').style.height, '0px', 'an unmeasured textarea keeps its rows');
  } finally {
    if (own) Object.defineProperty(prototype, 'scrollHeight', own); else delete prototype.scrollHeight;
  }
});

await check('.meta({ multiline: false }) is a one-line input, even for a description', () => {
  const schema = toSchema(z.object({
    attribution: z.string().meta({ multiline: false }),
    description: z.string().optional().meta({ multiline: false, placeholder: 'One line' }),
  }));
  const form = render(schema, { attribution: 'Photo: A. Person', description: 'Short' });
  for (const name of ['attribution', 'description']) {
    const input = control(form, name);
    assert.equal(input.tagName, 'INPUT', `${name} is an input`);
    assert.equal(input.type, 'text');
  }
  assert.equal(control(form, 'description').getAttribute('placeholder'), 'One line');
  control(form, 'attribution').value = 'Photo: B. Person';
  const saved = extractFormData(form, schema);
  assert.equal(saved.attribution, 'Photo: B. Person');
  assert.equal(saved.description, 'Short');
});

await check('.meta({ multiline: true }) is a textarea, even for a title', () => {
  const form = render(toSchema(z.object({ title: z.string().meta({ multiline: true }), heading: z.string() })), { title: 'A title', heading: 'A heading' });
  assert.equal(control(form, 'title').tagName, 'TEXTAREA');
  assert.equal(control(form, 'heading').tagName, 'INPUT', 'control: a title-like name with no meta stays an input');
});

await check('a stored value with a line break stays a textarea despite multiline: false', () => {
  const schema = toSchema(z.object({ attribution: z.string().meta({ multiline: false }) }));
  const form = render(schema, { attribution: 'Photo: A. Person\nCourtesy of the archive' });
  assert.equal(control(form, 'attribution').tagName, 'TEXTAREA');
  assert.equal(extractFormData(form, schema).attribution, 'Photo: A. Person\nCourtesy of the archive');
});

console.log(`\n📊 ${passed} checks passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
