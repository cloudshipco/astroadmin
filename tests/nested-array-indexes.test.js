/**
 * Lists inside list items (#56), in happy-dom through the real renderer, the
 * real handlers (setupFormHandlers, the item modal) and the real read-back.
 *
 * Pins:
 *   - "Add" on a list whose items hold lists of their own names the new item
 *     by the list's OWN item count: counting every `.array-item` below it
 *     counted the nested ones too, so the new item was `rows[3]` after one
 *     item holding two tags, and the save had holes.
 *   - every label points at its own control (`label.htmlFor` is the id of the
 *     control in its form group, and `getElementById` finds that control),
 *     on the form and in the item modal, before and after an item is deleted
 *     or added. A list inside the item modal used to drop the modal's id
 *     prefix, so its labels found same-named inputs on the form behind it; a
 *     deleted list item left its labels on the old ids; and the block reindex
 *     rewrote the first `_<n>_` in a label, which in `rows_0_blocks_1_x` is
 *     the row, not the block.
 *   - a reference list's reindex (dashboard.js) goes through the same
 *     reindexItems, so a removed card renumbers the rest.
 *
 *   bun tests/nested-array-indexes.test.js
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';
import fs from 'node:fs';
import path from 'node:path';
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

const { generateForm, extractFormData, setupFormHandlers, bindOriginalValues, reindexItems } = await import('../ui/form-generator.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${String(error.message).split('\n').join('\n   ')}`);
  }
}

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

async function waitFor(find) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting');
}

/** The list's own "Add" button and items, not a nested list's. */
const ownAddButton = (list) => Array.from(list.children).find((child) => child.classList.contains('add-array-item'));
const ownItems = (list) => Array.from(list.children).filter((child) => child.classList.contains('array-item'));

/**
 * Every label with a `for` in `scope`, described where it does not point at the
 * control in its own form group (or `getElementById` finds another element).
 */
function misdirectedLabels(scope) {
  const problems = [];
  const labels = scope.querySelectorAll('label[for]');
  assert.ok(labels.length > 0, 'control: there are labels to check');
  for (const label of labels) {
    const control = label.closest('.form-group')?.querySelector('input:not([type="hidden"]), textarea, select');
    if (!control) continue;
    const found = document.getElementById(label.htmlFor);
    if (label.htmlFor !== control.id || found !== control) {
      problems.push(`for="${label.htmlFor}" but its control is #${control.id} (${control.name})${found && found !== control ? `; getElementById finds ${found.name}` : ''}`);
    }
  }
  return problems;
}

function assertLabelsOwnControls(scope, when) {
  const problems = misdirectedLabels(scope);
  if (problems.length > 0) throw new Error(`${when}:\n${problems.join('\n')}`);
}

// --- New-item index --------------------------------------------------------

const rowsSchema = toSchema(z.object({ rows: z.array(z.object({ tags: z.array(z.string()) })) }));

await check('"Add" on a list of items holding lists names the new item by its own count', () => {
  const form = render(rowsSchema, { rows: [{ tags: ['a', 'b'] }] });
  const rows = form.querySelector('.array-field[data-field="rows"]');
  ownAddButton(rows).click();
  const newRow = ownItems(rows)[1];
  assert.ok(newRow, 'control: a second row was added');
  assert.equal(newRow.dataset.index, '1');
  const newTags = newRow.querySelector('.array-field');
  assert.equal(newTags.dataset.field, 'rows[1].tags');
  ownAddButton(newTags).click();
  const tagInput = ownItems(newTags)[0].querySelector('input');
  assert.equal(tagInput.name, 'rows[1].tags[0]');
  tagInput.value = 'c';
  assert.deepEqual(extractFormData(form, rowsSchema).rows, [{ tags: ['a', 'b'] }, { tags: ['c'] }]);
});

// --- Labels ---------------------------------------------------------------

const pointsItem = z.object({ label: z.string() });
const pageSchema = toSchema(z.object({
  points: z.array(pointsItem),
  cards: z.array(z.object({ title: z.string(), points: z.array(pointsItem) })),
}));
const pageData = {
  points: [{ label: 'Form 1' }, { label: 'Form 2' }],
  // Fewer points than the form's, so the point the modal adds takes an index
  // the form's list already has.
  cards: [{ title: 'Card', points: [{ label: 'Modal 1' }] }],
};

await check('a deleted list item leaves every label on its own control', () => {
  const form = render(pageSchema, pageData);
  assertLabelsOwnControls(form, 'before the delete');
  const points = form.querySelector('.array-field[data-field="points"]');
  ownItems(points)[0].querySelector('.remove-array-item').click();
  assert.equal(ownItems(points)[0].querySelector('input').name, 'points[0].label', 'control: the item was reindexed');
  assertLabelsOwnControls(form, 'after');
});

await check('in the item modal, a list\'s labels find the modal\'s controls, before and after an add and a delete', async () => {
  const form = render(pageSchema, pageData);
  form.querySelector('[data-array-cards][data-field="cards"] .array-card-edit[data-edit-card="0"]').click();
  const overlay = await waitFor(() => document.querySelector('.array-item-edit-overlay'));
  const points = overlay.querySelector('.array-field[data-field="points"]');
  assert.equal(ownItems(points).length, 1, 'control: the modal shows the card\'s points');
  assertLabelsOwnControls(overlay, 'on open');
  ownAddButton(points).click();
  assert.equal(ownItems(points)[1]?.querySelector('input')?.name, 'points[1].label', 'control: a point was added');
  assertLabelsOwnControls(overlay, 'after adding a point');
  ownItems(points)[0].querySelector('.remove-array-item').click();
  assert.equal(ownItems(points)[0].querySelector('input').name, 'points[0].label', 'control: the points were reindexed');
  assertLabelsOwnControls(overlay, 'after deleting the first point');
  assertLabelsOwnControls(form, 'the form behind is untouched');
});

await check('a block list inside a list item: deleting a block repoints its labels, not the row\'s', () => {
  // The shape the schema parser gives a block list (blockTypes) at rows[].blocks.
  const blockTypes = { text: { type: 'object', properties: { type: { type: 'string', const: 'text' }, heading: { type: 'string' } }, required: ['type', 'heading'] } };
  const schema = { type: 'object', properties: {
    rows: { type: 'array', items: { type: 'object', properties: {
      blocks: { type: 'array', blockTypes, items: { anyOf: Object.values(blockTypes) } },
    }, required: ['blocks'] } },
  }, required: ['rows'] };
  const form = render(schema, { rows: [{ blocks: [{ type: 'text', heading: 'One' }, { type: 'text', heading: 'Two' }] }] });
  const blocksList = form.querySelector('.blocks-list');
  assert.ok(blocksList, 'control: the row holds a block list');
  blocksList.querySelector('.block-item .remove-block').click();
  const heading = blocksList.querySelector('.block-item input[name$="heading"]');
  assert.equal(heading.name, 'rows[0].blocks[0].heading', 'control: the block was reindexed');
  assertLabelsOwnControls(form, 'after');
});

// --- Reference list reindex (pinning) -------------------------------------

await check('a reference list renumbers its cards after a delete', () => {
  const schema = toSchema(z.object({ related: z.array(z.string().meta({ referenceCollection: 'posts' })) }));
  const form = render(schema, { related: ['a', 'b', 'c'] });
  const inputs = () => Array.from(form.querySelectorAll('input[name^="related["]'));
  assert.deepEqual(inputs().map((input) => input.name), ['related[0]', 'related[1]', 'related[2]'], 'control: one input per reference');
  const referenceField = form.querySelector('.reference-field');
  // What the dashboard's remove button does (its wiring lives in dashboard.js).
  referenceField.querySelector('.reference-card').remove();
  reindexItems(referenceField.querySelectorAll('.reference-card'), referenceField.dataset.field);
  assert.deepEqual(inputs().map((input) => [input.name, input.value]), [['related[0]', 'b'], ['related[1]', 'c']]);
  assert.deepEqual(Array.from(referenceField.querySelectorAll('.reference-card')).map((card) => card.dataset.index), ['0', '1']);
  assert.deepEqual(extractFormData(form, schema).related, ['b', 'c']);
});

await check('the dashboard reindexes a reference list through reindexItems', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, '../ui/dashboard.js'), 'utf8');
  const body = source.match(/function reindexReferenceItems\([^)]*\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'reindexReferenceItems not found in dashboard.js');
  assert.ok(/reindexItems\(/.test(body), body);
});

console.log(`\n📊 ${passed} checks passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
