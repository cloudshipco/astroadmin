/**
 * Untouched fields keep their stored values: lists, cleanup and clearing.
 *
 * The companion to untouched-fields.test.js, for what that rule needs beyond
 * single controls:
 *
 * - Cleanup (cleanEmptyValues) touches only values the DOM produced. An
 *   untouched card in a JSON-backed list (an array of objects edited in the item
 *   modal) is its stored value byte for byte, '' and [] included, while a value
 *   the editor emptied is still dropped when the schema makes it optional.
 * - A list is changed when rows are added, removed or moved, even rows with no
 *   editable control (an object holding only a z.literal), and even when the
 *   rows end up as they were: a stored invalid `[]` on an optional key can be
 *   left unset by adding an item and removing it.
 * - A cleared nullable saves null: a primitive list item, and a widget-held
 *   control (an image, a reference) in a new, unbound entry.
 *
 * Fixtures come from the real converters (a throwaway site's content config
 * read by the real schema parser, served by the real createServer() app); the
 * editor side is the real renderer and handlers in happy-dom.
 *
 *   bun tests/untouched-structure.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-untouched-structure-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('src/content.config.ts', `import { defineCollection, reference, z } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z as z3 } from 'zod/v3';

const team = defineCollection({ loader: file('src/data/team.json'), schema: z.object({ id: z.string(), name: z.string() }) });

const card = z.object({ label: z.string(), note: z.string().optional(), tags: z.array(z.string()).optional() });
const line = z.object({ kind: z.literal('line') });

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: ({ image }) => z.object({
    title: z.string(),
    cards: z.array(card),
    extras: z.array(card).min(1).optional(),
    lines: z.array(line),
    steps: z.array(line),
    group: z.object({ caption: z.string(), lines: z.array(line) }),
    tags: z.array(z.string()).min(1).optional(),
    points: z.array(z.number().nullable()),
    flags: z.array(z.boolean().nullable()),
    image: z.string().nullable(),
    reviewer: reference('team').nullable(),
  }),
});

const legacy = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/legacy' }),
  schema: z3.object({
    title: z3.string(),
    points: z3.array(z3.number().nullable()),
    tags: z3.array(z3.string()).min(1).optional(),
  }),
});

// A JSON entry that is one list: the editor's top-level array form.
const menus = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/menus' }),
  schema: z.array(card),
});

export const collections = { team, pages, legacy, menus };
`);
writeProjectFile('src/data/team.json', `${JSON.stringify([{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }], null, 2)}\n`);

const PAGE_FILE = 'src/content/pages/home.md';
const PAGE_TEXT = `---
title: Home
cards:
  - label: First
    note: ''
    tags: []
  - label: Second
    note: ''
    tags: []
  - label: Third
    note: kept
    tags:
      - a
extras: []
lines: []
steps:
  - kind: line
  - kind: line
group:
  caption: Lines
  lines: []
tags: []
points:
  - 4
  - 2
flags:
  - true
  - null
image: null
reviewer: null
---
Body.
`;
writeProjectFile(PAGE_FILE, PAGE_TEXT);

const LEGACY_FILE = 'src/content/legacy/old.md';
const LEGACY_TEXT = `---
title: Old
points:
  - 4
  - 2
tags: []
---
Old body.
`;
writeProjectFile(LEGACY_FILE, LEGACY_TEXT);

const MENU_FILE = 'src/content/menus/main.json';
const MENU_TEXT = `[
  {
    "label": "A",
    "note": "",
    "tags": []
  },
  {
    "label": "B",
    "note": "",
    "tags": []
  }
]
`;
writeProjectFile(MENU_FILE, MENU_TEXT);

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`❌ ${name}\n   ${String(error.stack || error.message).split('\n').join('\n   ')}`);
  }
}

const { generateForm, extractFormData, setupFormHandlers, bindOriginalValues, setReferenceInputValue } =
  await import('../ui/form-generator.js');
const { updateImagePicker } = await import('../ui/field-widgets.js');
const { showEntryProblems } = await import('../ui/content-problems.js');
const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const loginResponse = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(loginResponse.status, 200, 'login');
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];

  const getJson = async (url) => {
    const response = await fetch(`${base}${url}`, { headers: { cookie } });
    assert.equal(response.status, 200, `${url}: ${await response.clone().text()}`);
    return response.json();
  };
  const loadEntry = (collection, slug) => getJson(`/api/content/${collection}/${slug}`);
  const loadSchema = async (collection) => (await getJson(`/api/collections/${collection}`)).collection.schema;
  const saveEntry = async (collection, slug, data, type) => {
    const response = await fetch(`${base}/api/content/${collection}/${slug}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, type }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const readFile = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
  /** Save a payload, return the file it wrote and the save's validation; restore the file. */
  const saveThrough = async (collection, slug, file, originalText, data, type) => {
    writeProjectFile(file, originalText);
    const result = await saveEntry(collection, slug, data, type);
    const text = readFile(file);
    writeProjectFile(file, originalText);
    return { text, validation: result.validation };
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));

  /** Render an entry as the dashboard does; `bound` false renders a new entry. */
  function renderEntry(schema, data, { bound = true } = {}) {
    const form = document.createElement('form');
    form.innerHTML = generateForm(schema, data);
    document.body.appendChild(form);
    for (const select of form.querySelectorAll('select')) {
      const marked = [...select.options].findIndex((option) => option.hasAttribute('selected'));
      if (marked >= 0) select.selectedIndex = marked;
    }
    setupFormHandlers(form, () => {});
    if (bound) bindOriginalValues(form, data);
    return form;
  }

  async function waitFor(find) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = find();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timed out waiting for the element');
  }

  /** The line numbers at which two texts differ. */
  function differingLines(before, after) {
    const a = before.split('\n');
    const b = after.split('\n');
    const lines = [];
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      if (a[index] !== b[index]) lines.push(index);
    }
    return lines;
  }

  /** Open a card of a JSON-backed list in the real item modal, edit it, press Done. */
  async function editCard(form, field, index, edit) {
    form.querySelector(`[data-array-cards][data-field="${field}"] .array-card-edit[data-edit-card="${index}"]`).click();
    const overlay = await waitFor(() => document.querySelector('.array-item-edit-overlay'));
    edit(overlay);
    overlay.querySelector('[data-save]').click();
    assert.equal(document.querySelector('.array-item-edit-overlay'), null, 'control: Done closed the modal');
  }

  const page = await loadEntry('pages', 'home');
  const pageSchema = await loadSchema('pages');
  const legacy = await loadEntry('legacy', 'old');
  const legacySchema = await loadSchema('legacy');
  const menu = await loadEntry('menus', 'main');
  const menuSchema = await loadSchema('menus');

  console.log('\n🧪 Untouched lists, cleanup and clearing\n' + '='.repeat(40));

  await check('control: the fixture loads as written', () => {
    assert.deepStrictEqual(page.data.cards[0], { label: 'First', note: '', tags: [] });
    assert.deepStrictEqual(page.data.tags, []);
    assert.deepStrictEqual(page.data.lines, []);
    assert.ok(pageSchema.properties.cards.items.properties.note, 'the card schema came through');
    assert.ok(!pageSchema.required.includes('tags'), 'tags is optional');
  });

  // --- 1. Cleanup touches only what the DOM produced ----------------------------

  await check('editing one card in the item modal leaves every other card, and the edited card\'s untouched fields, as stored', async () => {
    const form = renderEntry(pageSchema, clone(page.data));
    await editCard(form, 'cards', 1, (overlay) => { overlay.querySelector('[name="label"]').value = 'Second edited'; });
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.deepStrictEqual(payload.cards, [
      page.data.cards[0],
      { ...page.data.cards[1], label: 'Second edited' },
      page.data.cards[2],
    ]);
    const { text } = await saveThrough('pages', 'home', PAGE_FILE, PAGE_TEXT, payload, page.type);
    assert.deepEqual(differingLines(PAGE_TEXT, text), [6], text);
  });

  await check('a card field the editor emptied is still cleaned away (optional)', async () => {
    const form = renderEntry(pageSchema, clone(page.data));
    await editCard(form, 'cards', 2, (overlay) => { overlay.querySelector('[name="note"]').value = ''; });
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.deepStrictEqual(payload.cards[2], { label: 'Third', tags: ['a'] }, 'the emptied optional note is dropped');
    assert.deepStrictEqual(payload.cards[0], page.data.cards[0], 'its neighbour keeps its stored empties');
  });

  await check('a new card saves without the empty placeholders it was created with', async () => {
    const form = renderEntry(pageSchema, clone(page.data));
    form.querySelector('[data-array-cards][data-field="cards"]').closest('.form-group').querySelector('[data-add-array-card]').click();
    const overlay = await waitFor(() => document.querySelector('.array-item-edit-overlay'));
    overlay.querySelector('[name="label"]').value = 'Fourth';
    overlay.querySelector('[data-save]').click();
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.deepStrictEqual(payload.cards.slice(0, 3), page.data.cards);
    assert.deepStrictEqual(payload.cards[3], { label: 'Fourth' });
  });

  await check('reordering cards moves them unchanged', () => {
    const form = renderEntry(pageSchema, clone(page.data));
    const cards = form.querySelectorAll('[data-array-cards][data-field="cards"] .array-card');
    const drag = (type, target) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      event.dataTransfer = { effectAllowed: '', dropEffect: '' };
      event.clientY = -1;
      target.dispatchEvent(event);
    };
    drag('dragstart', cards[1]);
    drag('dragover', cards[0]);
    drag('drop', cards[0]);
    drag('dragend', cards[1]);
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.deepStrictEqual(payload.cards, [page.data.cards[1], page.data.cards[0], page.data.cards[2]]);
  });

  await check('a top-level list: editing one item leaves the other, and the edited item\'s untouched fields, as stored', async () => {
    assert.equal(menuSchema.type, 'array', 'control: the entry is a top-level array');
    const form = renderEntry(menuSchema, clone(menu.data));
    assert.deepStrictEqual(extractFormData(form, menuSchema), menu.data, 'untouched: the stored list');
    await editCard(form, '_root', 1, (overlay) => { overlay.querySelector('[name="label"]').value = 'B2'; });
    const payload = extractFormData(form, menuSchema);
    form.remove();
    assert.deepStrictEqual(payload, [menu.data[0], { ...menu.data[1], label: 'B2' }]);
    const { text } = await saveThrough('menus', 'main', MENU_FILE, MENU_TEXT, payload, menu.type);
    assert.deepEqual(differingLines(MENU_TEXT, text), [7], text);
  });

  await check('a top-level list: a new item saves without its empty placeholders', async () => {
    const form = renderEntry(menuSchema, clone(menu.data));
    form.querySelector('[data-add-array-card]').click();
    const overlay = await waitFor(() => document.querySelector('.array-item-edit-overlay'));
    overlay.querySelector('[name="label"]').value = 'C';
    overlay.querySelector('[data-save]').click();
    const payload = extractFormData(form, menuSchema);
    form.remove();
    assert.deepStrictEqual(payload, [...menu.data, { label: 'C' }]);
  });

  // --- 2. Rows with no editable control -----------------------------------------

  await check('adding a row that holds only a constant saves it', () => {
    const form = renderEntry(pageSchema, clone(page.data));
    form.querySelector('.array-field[data-field="lines"] > .add-array-item').click();
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.deepStrictEqual(payload.lines, [{ kind: 'line' }]);
  });

  await check('deleting a row that holds only a constant removes it', () => {
    const form = renderEntry(pageSchema, clone(page.data));
    form.querySelector('.array-field[data-field="steps"] .remove-array-item').click();
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.deepStrictEqual(payload.steps, [{ kind: 'line' }]);
  });

  await check('a constant-only row added inside an untouched object is saved, and the object\'s other values kept', () => {
    const form = renderEntry(pageSchema, clone(page.data));
    form.querySelector('.array-field[data-field="group.lines"] > .add-array-item').click();
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.deepStrictEqual(payload.group, { caption: 'Lines', lines: [{ kind: 'line' }] });
  });

  // --- 3. Clearing a nullable ---------------------------------------------------

  for (const [label, entry, schema] of [['zod 4', page, pageSchema], ['zod 3', legacy, legacySchema]]) {
    await check(`${label}: clearing a nullable number in a list saves null`, () => {
      const form = renderEntry(schema, clone(entry.data));
      form.querySelector('[name="points[0]"]').value = '';
      const payload = extractFormData(form, schema);
      form.remove();
      assert.deepStrictEqual(payload.points, [null, 2]);
    });
  }

  await check('a nullable boolean list item is three-state: untouched null kept, "Not set" saves null', () => {
    const form = renderEntry(pageSchema, clone(page.data));
    const first = form.querySelector('[name="flags[0]"]');
    assert.equal(first.tagName, 'SELECT', 'a nullable boolean item is a select, not a checkbox');
    first.value = '';
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.deepStrictEqual(payload.flags, [null, null]);
  });

  await check('a new entry: choosing then clearing an image or a reference saves null', () => {
    const form = renderEntry(pageSchema, {}, { bound: false });
    const picker = form.querySelector('.image-picker[data-field="image"]');
    updateImagePicker(picker, '/images/a.png');
    picker.querySelector('[data-clear]').click();
    const reviewer = form.querySelector('[data-reference-value][name="reviewer"]');
    setReferenceInputValue(reviewer, 'grace');
    setReferenceInputValue(reviewer, '');
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.strictEqual(payload.image, null, 'image');
    assert.strictEqual(payload.reviewer, null, 'reviewer');
  });

  await check('control: a new entry\'s image never touched stays empty (no clear, no null)', () => {
    const form = renderEntry(pageSchema, {}, { bound: false });
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.strictEqual(payload.image, '');
  });

  // --- 5. Leaving a stored invalid [] unset ---------------------------------------

  await check('control: an untouched stored [] on an optional key is kept, and the save warns', async () => {
    const form = renderEntry(pageSchema, clone(page.data));
    form.querySelector('[name="title"]').value = 'Home edited';
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.deepStrictEqual(payload.tags, []);
    assert.deepStrictEqual(payload.extras, []);
    const { validation } = await saveThrough('pages', 'home', PAGE_FILE, PAGE_TEXT, payload, page.type);
    assert.equal(validation?.status, 'invalid', JSON.stringify(validation));
    assert.ok(validation.issues.some((issue) => issue.path === 'tags'), JSON.stringify(validation.issues));
  });

  await check('adding an item to a stored invalid optional [] and removing it leaves the key unset, and the save is valid', async () => {
    const form = renderEntry(pageSchema, clone(page.data));
    const tags = form.querySelector('.array-field[data-field="tags"]');
    tags.querySelector(':scope > .add-array-item').click();
    tags.querySelector('.remove-array-item').click();
    assert.equal(tags.querySelectorAll('.array-item').length, 0, 'control: back to no rows');
    // The same for a list of cards.
    const extrasGroup = form.querySelector('[data-array-cards][data-field="extras"]').closest('.form-group');
    extrasGroup.querySelector('[data-add-array-card]').click();
    const overlay = await waitFor(() => document.querySelector('.array-item-edit-overlay'));
    overlay.querySelector('[name="label"]').value = 'Extra';
    overlay.querySelector('[data-save]').click();
    extrasGroup.querySelector('[data-delete-card="0"]').click();
    const payload = extractFormData(form, pageSchema);
    form.remove();
    assert.equal('tags' in payload, false, `tags: ${JSON.stringify(payload.tags)}`);
    assert.equal('extras' in payload, false, `extras: ${JSON.stringify(payload.extras)}`);
    assert.deepStrictEqual(payload.cards, page.data.cards, 'positive control: the rest is as stored');
    const { text, validation } = await saveThrough('pages', 'home', PAGE_FILE, PAGE_TEXT, payload, page.type);
    assert.doesNotMatch(text, /^tags:/m, text);
    assert.doesNotMatch(text, /^extras:/m, text);
    assert.equal(validation?.status, 'valid', JSON.stringify(validation));
  });
  await check('the warning for a too-short list says what to do, and offers leaving it out only when the key is optional', async () => {
    for (const [label, entry, schema, file, text] of [
      ['zod 4', page, pageSchema, PAGE_FILE, PAGE_TEXT],
      ['zod 3', legacy, legacySchema, LEGACY_FILE, LEGACY_TEXT],
    ]) {
      const { validation } = await saveThrough(entry.collection, entry.slug, file, text, clone(entry.data), entry.type);
      const tagsIssue = validation.issues.find((issue) => issue.path === 'tags');
      assert.ok(tagsIssue, `${label}: control: the stored [] is reported (${JSON.stringify(validation.issues)})`);
      const form = renderEntry(schema, clone(entry.data));
      // A required list with the same complaint gets no "leave it out".
      showEntryProblems(form, { ...validation, issues: [...validation.issues, { ...tagsIssue, path: 'points' }] }, schema);
      const messages = [...form.querySelectorAll('.field-problem')].map((element) => element.textContent);
      form.remove();
      assert.ok(messages.includes('Needs at least 1 item. Or leave it out: add an item and delete it, and it is saved as not set.'), `${label}: ${JSON.stringify(messages)}`);
      assert.ok(messages.includes('Needs at least 1 item.'), `${label}: the required list: ${JSON.stringify(messages)}`);
    }
  });
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}.\n`);
if (failures.length) process.exitCode = 1;
