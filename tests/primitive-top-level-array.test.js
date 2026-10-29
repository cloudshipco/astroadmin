/**
 * A collection whose entry is one list of primitives (`z.array(z.string())`,
 * `z.array(z.number())`) is edited as an inline list, item by item (#34).
 *
 * It used to be drawn as object cards: the item modal had no fields to show
 * for a string, and saving it spread the string into an object
 * ("foo" -> {"0": "f", "1": "o", "2": "o"}, a number -> {}). The rule pinned
 * here: each item is a control of the item's own type, an untouched list is
 * the stored one byte for byte, editing one item changes only that item (its
 * neighbours stay byte-identical on disk, numbers stay numbers, a string
 * "2024" stays a string), and adding and deleting items work.
 *
 * Fixtures come from the real converters (a throwaway site's content config
 * read by the real schema parser, zod 4 and zod 3, served by the real
 * createServer() app); the editor side is the real renderer and handlers in
 * happy-dom, bound to the stored entry as the dashboard binds it.
 *
 *   bun tests/primitive-top-level-array.test.js
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
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-primitive-list-')));
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
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { z as z3 } from 'zod/v3';

const words = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/words' }),
  schema: z.array(z.string()),
});

const scores = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/scores' }),
  schema: z.array(z.number()),
});

const legacyScores = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/legacy-scores' }),
  schema: z3.array(z3.number().int()),
});

export const collections = { words, scores, legacyScores };
`);

const WORDS_FILE = 'src/content/words/main.json';
const WORDS_TEXT = `[
  "alpha",
  "2024",
  "it's \\"quoted\\""
]
`;
writeProjectFile(WORDS_FILE, WORDS_TEXT);

const SCORES_FILE = 'src/content/scores/main.json';
const SCORES_TEXT = `[
  1.50,
  2,
  3e2
]
`;
writeProjectFile(SCORES_FILE, SCORES_TEXT);

const LEGACY_FILE = 'src/content/legacy-scores/main.json';
const LEGACY_TEXT = `[
  4,
  5,
  6
]
`;
writeProjectFile(LEGACY_FILE, LEGACY_TEXT);

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

const { generateForm, extractFormData, setupFormHandlers, bindOriginalValues } = await import('../ui/form-generator.js');
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
  const readFile = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
  /** Save a payload, return the file it wrote and the save's validation; restore the file. */
  const saveThrough = async (collection, slug, file, originalText, data, type) => {
    writeProjectFile(file, originalText);
    const response = await fetch(`${base}/api/content/${collection}/${slug}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, type }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const text = readFile(file);
    writeProjectFile(file, originalText);
    return { text, validation: result.validation };
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));

  /** Render an entry as the dashboard does: render, set up handlers, bind. */
  function renderEntry(schema, data) {
    const form = document.createElement('form');
    form.innerHTML = generateForm(schema, data);
    document.body.appendChild(form);
    setupFormHandlers(form, () => {});
    bindOriginalValues(form, data);
    return form;
  }

  /** The list's item controls, in order. */
  const itemControls = (form) => [...form.querySelectorAll('.array-item input[name]')];

  /** Type into a control as an editor does. */
  function typeInto(control, value) {
    control.value = value;
    control.dispatchEvent(new window.Event('input', { bubbles: true }));
    control.dispatchEvent(new window.Event('change', { bubbles: true }));
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

  const fixtures = [
    {
      label: 'strings (zod 4)', collection: 'words', file: WORDS_FILE, text: WORDS_TEXT,
      stored: ['alpha', '2024', 'it\'s "quoted"'], inputType: 'text',
      editedText: 'beta', edited: 'beta', addedText: '42', added: '42',
    },
    {
      label: 'numbers (zod 4)', collection: 'scores', file: SCORES_FILE, text: SCORES_TEXT,
      stored: [1.5, 2, 300], inputType: 'number',
      editedText: '7.25', edited: 7.25, addedText: '9', added: 9,
    },
    {
      label: 'integers (zod 3)', collection: 'legacyScores', file: LEGACY_FILE, text: LEGACY_TEXT,
      stored: [4, 5, 6], inputType: 'number',
      editedText: '50', edited: 50, addedText: '7', added: 7,
    },
  ];

  console.log('\n🧪 Top-level lists of primitives\n' + '='.repeat(40));

  for (const fixture of fixtures) {
    const entry = await loadEntry(fixture.collection, 'main');
    const schema = await loadSchema(fixture.collection);

    await check(`${fixture.label}: control: the entry loads as a top-level list`, () => {
      assert.equal(schema.type, 'array');
      assert.deepStrictEqual(entry.data, fixture.stored);
    });

    await check(`${fixture.label}: each item is a control of the item's type, not an object card`, () => {
      const form = renderEntry(schema, clone(entry.data));
      const controls = itemControls(form);
      const cards = form.querySelectorAll('.array-card').length;
      form.remove();
      assert.equal(cards, 0, 'no object cards');
      assert.equal(controls.length, fixture.stored.length, 'one control per item');
      for (const control of controls) assert.equal(control.type, fixture.inputType, control.outerHTML);
      assert.deepStrictEqual(controls.map((control) => control.value), fixture.stored.map(String));
    });

    await check(`${fixture.label}: untouched, the stored list saves byte for byte`, async () => {
      const form = renderEntry(schema, clone(entry.data));
      const payload = extractFormData(form, schema);
      form.remove();
      assert.deepStrictEqual(payload, fixture.stored);
      const { text } = await saveThrough(fixture.collection, 'main', fixture.file, fixture.text, payload, entry.type);
      assert.equal(text, fixture.text);
    });

    await check(`${fixture.label}: editing one item changes only that item`, async () => {
      const form = renderEntry(schema, clone(entry.data));
      typeInto(itemControls(form)[1], fixture.editedText);
      const payload = extractFormData(form, schema);
      form.remove();
      assert.deepStrictEqual(payload, [fixture.stored[0], fixture.edited, fixture.stored[2]]);
      const { text, validation } = await saveThrough(fixture.collection, 'main', fixture.file, fixture.text, payload, entry.type);
      assert.deepEqual(differingLines(fixture.text, text), [2], text);
      assert.deepStrictEqual(JSON.parse(text), payload);
      assert.equal(validation?.status, 'valid', JSON.stringify(validation));
    });

    await check(`${fixture.label}: an added item is saved after the others, with its type`, async () => {
      const form = renderEntry(schema, clone(entry.data));
      form.querySelector('.add-array-item').click();
      const controls = itemControls(form);
      assert.equal(controls.length, fixture.stored.length + 1, 'control: the add button added a row');
      assert.equal(controls.at(-1).type, fixture.inputType);
      typeInto(controls.at(-1), fixture.addedText);
      const payload = extractFormData(form, schema);
      form.remove();
      assert.deepStrictEqual(payload, [...fixture.stored, fixture.added]);
      const { text, validation } = await saveThrough(fixture.collection, 'main', fixture.file, fixture.text, payload, entry.type);
      assert.deepStrictEqual(JSON.parse(text), payload);
      assert.equal(validation?.status, 'valid', JSON.stringify(validation));
    });

    await check(`${fixture.label}: a deleted item is gone and the rest keep their values`, async () => {
      const form = renderEntry(schema, clone(entry.data));
      form.querySelectorAll('.remove-array-item')[0].click();
      const payload = extractFormData(form, schema);
      form.remove();
      assert.deepStrictEqual(payload, fixture.stored.slice(1));
      const { text, validation } = await saveThrough(fixture.collection, 'main', fixture.file, fixture.text, payload, entry.type);
      assert.deepStrictEqual(JSON.parse(text), payload);
      assert.equal(validation?.status, 'valid', JSON.stringify(validation));
    });

    await check(`${fixture.label}: deleting every item saves an empty list`, async () => {
      const form = renderEntry(schema, clone(entry.data));
      while (form.querySelector('.remove-array-item')) form.querySelector('.remove-array-item').click();
      const payload = extractFormData(form, schema);
      form.remove();
      assert.deepStrictEqual(payload, []);
    });
  }

  await check('a new entry (unbound, no data) starts as an empty list and saves what was added', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    const form = document.createElement('form');
    form.innerHTML = generateForm(schema, {});
    document.body.appendChild(form);
    setupFormHandlers(form, () => {});
    assert.deepStrictEqual(extractFormData(form, schema), [], 'control: empty');
    form.querySelector('.add-array-item').click();
    typeInto(itemControls(form)[0], 'first');
    const payload = extractFormData(form, schema);
    form.remove();
    assert.deepStrictEqual(payload, ['first']);
  });
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}.\n`);
if (failures.length) process.exitCode = 1;
