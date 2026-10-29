/**
 * A file() entry is found, and written back, by the identity Astro gives it.
 *
 * Astro's file() loader keys an array item by `(item.id ?? item.slug)
 * ?.toString()` (astro/dist/content/loaders/file.js). The files store
 * compared `item.id === entryId` with the slug from the URL, always a string,
 * so an entry `{id: 1}` was never found: a save appended a duplicate, and a
 * match would have rewritten 1 as "1". An entry keyed by `slug` (no id) got
 * `id: <slug>` added on every save, which a `.strict()` schema refuses, and
 * its slug box took edits the store never honoured; it is now read-only, as
 * a file() id is (#72), while a slug beside an id stays ordinary data.
 *
 * Through the real parser (a throwaway site, real zod 4), the real
 * createServer() app and the real renderer in happy-dom: each entry is opened,
 * rendered and bound as the dashboard does, one field is edited, and the form
 * is saved through the API.
 *
 *   bun tests/file-entry-keys.test.js
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

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-file-entry-keys-')));
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
import { file } from 'astro/loaders';
export const collections = {
  numbered: defineCollection({
    loader: file('src/content/numbered.json'),
    schema: z.object({ id: z.number(), label: z.string() }),
  }),
  // Keyed by slug: strict, so an \`id\` key the store adds is refused.
  bySlug: defineCollection({
    loader: file('src/content/by-slug.json'),
    schema: z.object({ slug: z.string(), title: z.string() }).strict(),
  }),
  // Keyed by id, with a slug that is ordinary data (a URL part).
  linked: defineCollection({
    loader: file('src/content/linked.json'),
    schema: z.object({ id: z.string(), slug: z.string(), title: z.string() }),
  }),
};
`);
const BY_SLUG_JSON = `[
  {
    "slug": "first",
    "title": "First"
  },
  {
    "slug": "second",
    "title": "Second"
  }
]
`;
const bySlugPath = path.join(projectRoot, 'src/content/by-slug.json');
writeProjectFile('src/content/by-slug.json', BY_SLUG_JSON);
const LINKED_JSON = `[
  {
    "id": "about",
    "slug": "about-us",
    "title": "About"
  }
]
`;
const linkedPath = path.join(projectRoot, 'src/content/linked.json');
writeProjectFile('src/content/linked.json', LINKED_JSON);

// Indented by hand (four spaces, one entry inline): an untouched entry keeps
// its own text only if the save leaves it alone.
const NUMBERED_JSON = `[
    { "id": 1, "label": "One" },
    {
        "id": 2,
        "label": "Two"
    },
    {
        "id": 3,
        "label": "Three"
    }
]
`;
const numberedPath = path.join(projectRoot, 'src/content/numbered.json');
writeProjectFile('src/content/numbered.json', NUMBERED_JSON);

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

const { generateForm, extractFormData, setupFormHandlers, bindOriginalValues, newEntryValues } = await import('../ui/form-generator.js');
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
  const loadCollection = async (collection) => (await getJson(`/api/collections/${collection}`)).collection;
  const saveEntry = async (collection, slug, data) => {
    const response = await fetch(`${base}/api/content/${collection}/${slug}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, type: 'data' }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };

  /** Open an entry as the dashboard does, edit one field, and return what the form saves. */
  async function editEntry(collection, slug, fieldName, text) {
    const schema = (await loadCollection(collection)).schema;
    const entry = await getJson(`/api/content/${collection}/${slug}`);
    const form = document.createElement('form');
    form.innerHTML = generateForm(schema, entry.data);
    document.body.appendChild(form);
    setupFormHandlers(form, () => {});
    bindOriginalValues(form, entry.data);
    const control = form.querySelector(`[name="${fieldName}"]`);
    assert.ok(control && !control.readOnly, `control: ${fieldName} is editable`);
    control.value = text;
    control.dispatchEvent(new Event('input', { bubbles: true }));
    const data = extractFormData(form, schema);
    form.remove();
    return { form, data };
  }

  await check('numeric ids: the collection lists each entry by its id as text, as Astro does', async () => {
    const collection = await loadCollection('numbered');
    assert.deepStrictEqual(collection.entries, ['1', '2', '3']);
  });

  await check('numeric ids: an entry opens by its id', async () => {
    const entry = await getJson('/api/content/numbered/2');
    assert.deepEqual(entry.data, { id: 2, label: 'Two' });
  });

  await check('numeric ids: a save edits the entry in place, its id stays a number, the others are untouched', async () => {
    fs.writeFileSync(numberedPath, NUMBERED_JSON);
    const { data } = await editEntry('numbered', '2', 'label', 'Deux');
    await saveEntry('numbered', '2', data);
    const text = fs.readFileSync(numberedPath, 'utf8');
    const stored = JSON.parse(text);
    assert.equal(stored.length, 3, `a save added an entry: ${JSON.stringify(stored)}`);
    assert.deepEqual(stored[1], { id: 2, label: 'Deux' }, 'positive control: the edit was saved, under a numeric id');
    assert.equal(text, NUMBERED_JSON.replace('"Two"', '"Deux"'), 'only the label changed');
  });

  await check('numeric ids: a save of an id sent as text still keeps the stored number', async () => {
    fs.writeFileSync(numberedPath, NUMBERED_JSON);
    await saveEntry('numbered', '3', { id: '3', label: 'Trois' });
    const stored = JSON.parse(fs.readFileSync(numberedPath, 'utf8'));
    assert.equal(stored.length, 3);
    assert.deepEqual(stored[2], { id: 3, label: 'Trois' });
  });

  // --- Entries keyed by slug ---------------------------------------------------
  // With no id, Astro keys an item by its slug. The save wrote `id: <slug>`
  // into it, a key the entry never had and a .strict() schema refuses, and
  // the slug box took edits the store never honoured as the entry's name.

  /** An entry rendered and bound as the dashboard does. */
  async function renderStoredEntry(collection, slug) {
    const schema = (await loadCollection(collection)).schema;
    const entry = await getJson(`/api/content/${collection}/${slug}`);
    const form = document.createElement('form');
    form.innerHTML = generateForm(schema, entry.data);
    document.body.appendChild(form);
    return form;
  }

  await check('slug-keyed: the slug is shown read-only, like a file() id', async () => {
    const form = await renderStoredEntry('bySlug', 'second');
    const slugControl = form.querySelector('[name="slug"]');
    assert.ok(slugControl, 'control: the slug is in the form');
    assert.equal(slugControl.value, 'second');
    assert.equal(slugControl.readOnly, true, 'the slug control is editable');
    assert.equal(form.querySelector('[name="title"]').readOnly, false, 'control: the title is editable');
    form.remove();
  });

  await check('slug-keyed: a save adds no id, keeps the entry where it was, and is valid', async () => {
    fs.writeFileSync(bySlugPath, BY_SLUG_JSON);
    const { data } = await editEntry('bySlug', 'second', 'title', 'Second edit');
    const result = await saveEntry('bySlug', 'second', data);
    const text = fs.readFileSync(bySlugPath, 'utf8');
    assert.equal(JSON.parse(text)[1].title, 'Second edit', 'positive control: the edit was saved');
    assert.equal(text, BY_SLUG_JSON.replace('"Second"', '"Second edit"'), 'only the title changed');
    assert.equal(result.validation?.status, 'valid', `the saved entry fails its schema: ${JSON.stringify(result.validation)}`);
  });

  await check('slug-keyed: a slug sent by another client does not rename the entry', async () => {
    fs.writeFileSync(bySlugPath, BY_SLUG_JSON);
    await saveEntry('bySlug', 'first', { slug: 'renamed', title: 'First' });
    assert.equal(fs.readFileSync(bySlugPath, 'utf8'), BY_SLUG_JSON);
  });

  await check('slug-keyed: a new entry is created under its slug, with no id', async () => {
    fs.writeFileSync(bySlugPath, BY_SLUG_JSON);
    const schema = (await loadCollection('bySlug')).schema;
    const startValues = newEntryValues(schema, 'third');
    assert.deepEqual(startValues, { slug: 'third' }, 'the new-entry form does not start with the chosen slug');
    const form = document.createElement('form');
    form.innerHTML = generateForm(schema, startValues);
    document.body.appendChild(form);
    setupFormHandlers(form, () => {});
    assert.equal(form.querySelector('[name="slug"]').readOnly, true, 'the new slug is editable');
    const titleControl = form.querySelector('[name="title"]');
    titleControl.value = 'Third';
    titleControl.dispatchEvent(new Event('input', { bubbles: true }));
    const result = await saveEntry('bySlug', 'third', extractFormData(form, schema));
    form.remove();
    const stored = JSON.parse(fs.readFileSync(bySlugPath, 'utf8'));
    assert.deepEqual(stored[2], { slug: 'third', title: 'Third' });
    assert.equal(result.validation?.status, 'valid', JSON.stringify(result.validation));
  });

  await check('id-keyed control: a slug beside an id is ordinary data, and its edit is saved', async () => {
    fs.writeFileSync(linkedPath, LINKED_JSON);
    const form = await renderStoredEntry('linked', 'about');
    assert.equal(form.querySelector('[name="id"]').readOnly, true, 'control: the id is read-only');
    assert.equal(form.querySelector('[name="slug"]').readOnly, false, 'a slug beside an id became read-only');
    form.remove();
    const schema = (await loadCollection('linked')).schema;
    assert.deepEqual(newEntryValues(schema, 'contact'), { id: 'contact' }, 'a new entry names its id, not its slug');
    const { data } = await editEntry('linked', 'about', 'slug', 'about-the-team');
    await saveEntry('linked', 'about', data);
    assert.equal(fs.readFileSync(linkedPath, 'utf8'), LINKED_JSON.replace('"about-us"', '"about-the-team"'));
  });
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
