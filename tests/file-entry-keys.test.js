/**
 * A file() entry is found, and written back, by the identity Astro gives it.
 *
 * Astro's file() loader keys an array item by `(item.id ?? item.slug)
 * ?.toString()` (astro/dist/content/loaders/file.js). The files store
 * compared `item.id === entryId` with the slug from the URL, always a string,
 * so an entry `{id: 1}` was never found: a save appended a duplicate, and a
 * match would have rewritten 1 as "1".
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
};
`);

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
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
