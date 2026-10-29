/**
 * No two elements in the dashboard document share an id, through the real
 * renderer and handlers in happy-dom: the main form with blocks (a nested
 * list of blocks inside a block too), a colour field in each block, and an
 * item modal open on top of it, after blocks are added and deleted.
 *
 * Two ids used to repeat: every block list's "Add block" select was
 * `id="add-block-type"` (main form, a nested list, the item modal), and a
 * colour swatch's `<id>_picker` has no name, so a reindex after a delete did
 * not move it and the next added block made a second `blocks_1_..._picker`.
 * A duplicated id sends a `<label for>` (and any id lookup) to the first one.
 *
 *   bun tests/unique-ids.test.js
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';

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

function duplicateIds() {
  const counts = new Map();
  for (const element of document.querySelectorAll('[id]')) counts.set(element.id, (counts.get(element.id) || 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([id, count]) => `${id} x${count}`);
}

const note = {
  type: 'object',
  properties: { type: { type: 'string', const: 'note' }, heading: { type: 'string' }, accentColor: { type: 'string' } },
  required: ['type', 'heading'],
};
const row = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'row' },
    blocks: { type: 'array', blockTypes: { note }, items: { anyOf: [note] } },
  },
  required: ['type', 'blocks'],
};
const blockTypes = { note, row };
const schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    blocks: { type: 'array', blockTypes, items: { anyOf: [note, row] } },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          accentColor: { type: 'string' },
          blocks: { type: 'array', blockTypes: { note }, items: { anyOf: [note] } },
        },
      },
    },
  },
  required: ['title', 'blocks'],
};
const stored = {
  title: 'T',
  blocks: [
    { type: 'row', blocks: [{ type: 'note', heading: 'R', accentColor: '#0000ff' }] },
    { type: 'note', heading: 'A', accentColor: '#ff0000' },
    { type: 'note', heading: 'B', accentColor: '#00ff00' },
  ],
  cards: [{ label: 'C', accentColor: '#123456', blocks: [{ type: 'note', heading: 'N', accentColor: '#654321' }] }],
};

function render() {
  document.body.innerHTML = '';
  const form = document.createElement('form');
  form.innerHTML = fg.generateForm(schema, stored);
  document.body.appendChild(form);
  fg.setupFormHandlers(form, () => {});
  fg.bindOriginalValues(form, stored);
  return form;
}

/** The "Add block" control of a blocks list (its own, not a nested list's). */
function addBlock(form, listPath, type) {
  const container = [...form.querySelectorAll('.blocks-container')].find((element) => element.dataset.field === listPath);
  assert.ok(container, `a blocks list at ${listPath}`);
  const select = container.querySelector(':scope > .blocks-header select');
  select.value = type;
  container.querySelector(':scope > .blocks-header .add-block-btn').click();
}

function deleteBlock(form, index) {
  form.querySelectorAll('.blocks-list[data-field="blocks"] > .block-item')[index].querySelector(':scope > .block-body > .block-footer .remove-block').click();
}

await check('the rendered form has no duplicate id', () => {
  render();
  assert.deepEqual(duplicateIds(), []);
});

await check('after deleting a block and adding one, no id is duplicated', () => {
  const form = render();
  deleteBlock(form, 1);
  assert.equal(form.querySelector('[name="blocks[1].heading"]').value, 'B', 'positive control: the delete reindexed');
  addBlock(form, 'blocks', 'note');
  assert.ok(form.querySelector('[name="blocks[2].heading"]'), 'positive control: the new block is at index 2');
  addBlock(form, 'blocks[0].blocks', 'note');
  assert.ok(form.querySelector('[name="blocks[0].blocks[1].heading"]'), 'positive control: a nested block was added');
  assert.deepEqual(duplicateIds(), []);
});

await check('every label points at the control of its own block after the delete', () => {
  const form = render();
  deleteBlock(form, 1);
  addBlock(form, 'blocks', 'note');
  for (const label of form.querySelectorAll('label[for]')) {
    const target = document.getElementById(label.htmlFor);
    assert.ok(target, `label for ${label.htmlFor} finds a control`);
    assert.ok(label.closest('.form-group').contains(target), `label for ${label.htmlFor} is beside it`);
  }
});

await check('with the item modal open over the form, no id is duplicated', async () => {
  const form = render();
  form.querySelector('.array-card-edit[data-edit-card="0"]').click();
  for (let i = 0; i < 100 && !document.querySelector('.array-item-edit-overlay'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(document.querySelector('.array-item-edit-overlay [name="label"]'), 'positive control: the modal is open');
  assert.deepEqual(duplicateIds(), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
