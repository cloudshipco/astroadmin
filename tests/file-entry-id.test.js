/**
 * A file() entry's `id` is shown, but cannot be edited (#72).
 *
 * The files store writes a file() entry under the id it was opened (or
 * created) with: `writeFileCollectionEntry` sets `id: entryId` over whatever
 * the form sent, because a renamed id would orphan the entry and break every
 * reference to it. A schema that declares `id: z.string()` used to get an
 * ordinary text box: an edit autosaved with a 200, the file kept the old id,
 * and the editor was never told. The schema parser now marks a file()
 * collection's top-level `id` (`x-astroadmin-entry-id`), and the renderer
 * shows it read-only with a line saying why. A new entry's id is the name
 * chosen in the "Create New" dialog, so the new-entry form shows that name.
 *
 * Through the real parser (a throwaway site, real zod 4), the real
 * createServer() app, the real renderer in happy-dom and the dashboard's own
 * renderEditorForNewEntry. Control: a glob() collection's `id`-named field is
 * an ordinary field and its edit is saved.
 *
 *   bun tests/file-entry-id.test.js
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
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-file-entry-id-')));
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
import { file, glob } from 'astro/loaders';
export const collections = {
  settings: defineCollection({
    loader: file('src/content/settings.json'),
    schema: z.object({ id: z.string(), siteName: z.string() }),
  }),
  people: defineCollection({
    loader: glob({ pattern: '**/*.json', base: './src/content/people' }),
    schema: z.object({ id: z.string(), name: z.string() }),
  }),
};
`);
const SETTINGS_JSON = `[
  {
    "id": "main",
    "siteName": "Site A"
  }
]
`;
const settingsPath = path.join(projectRoot, 'src/content/settings.json');
writeProjectFile('src/content/settings.json', SETTINGS_JSON);
const personPath = path.join(projectRoot, 'src/content/people/ada.json');
writeProjectFile('src/content/people/ada.json', `${JSON.stringify({ id: 'person-1', name: 'Ada' }, null, 2)}\n`);

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

const formGenerator = await import('../ui/form-generator.js');
const { generateForm, extractFormData, setupFormHandlers, bindOriginalValues } = formGenerator;
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
  const loadSchema = async (collection) => (await getJson(`/api/collections/${collection}`)).collection.schema;
  const saveEntry = async (collection, slug, data) => {
    const response = await fetch(`${base}/api/content/${collection}/${slug}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, type: 'data' }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };

  /** A loaded entry, rendered and bound as the dashboard does. */
  function renderEntry(schema, data) {
    const form = document.createElement('form');
    form.innerHTML = generateForm(schema, data);
    document.body.appendChild(form);
    setupFormHandlers(form, () => {});
    bindOriginalValues(form, data);
    return form;
  }

  /** What an editor typing into a control can do: nothing to a read-only one. */
  function typeInto(control, text) {
    if (control.readOnly || control.disabled) return false;
    control.value = text;
    control.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  const settingsSchema = await loadSchema('settings');
  const peopleSchema = await loadSchema('people');

  await check('file(): the id control is read-only and says why', async () => {
    const entry = await getJson('/api/content/settings/main');
    const form = renderEntry(settingsSchema, entry.data);
    const idControl = form.querySelector('[name="id"]');
    assert.ok(idControl, 'the id is still in the form (it is shown, and read back)');
    assert.equal(idControl.value, 'main', 'it shows the stored id');
    assert.equal(idControl.readOnly, true, 'the id control is editable');
    assert.equal(form.querySelectorAll('textarea[name="id"], select[name="id"]').length, 0);
    const describedBy = idControl.getAttribute('aria-describedby');
    assert.ok(describedBy && form.querySelector(`#${describedBy}`)?.textContent.trim(), 'no explanation is attached');
    const otherControl = form.querySelector('[name="siteName"]');
    assert.equal(otherControl.readOnly, false, 'control: the other field is editable');
  });

  await check('file(): an edit next to the id saves, and the form never shows an id that was not saved', async () => {
    fs.writeFileSync(settingsPath, SETTINGS_JSON);
    const entry = await getJson('/api/content/settings/main');
    const form = renderEntry(settingsSchema, entry.data);
    const idTyped = typeInto(form.querySelector('[name="id"]'), 'renamed');
    assert.ok(typeInto(form.querySelector('[name="siteName"]'), 'Site B'), 'control: siteName takes typing');
    const shownId = form.querySelector('[name="id"]').value;
    await saveEntry('settings', 'main', extractFormData(form, settingsSchema));
    const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(stored[0].siteName, 'Site B', 'positive control: the edit was saved');
    assert.equal(stored.length, 1);
    // Either the id edit is saved, or the editor could not make it.
    assert.equal(stored[0].id, shownId, `the form shows id "${shownId}" (typing ${idTyped ? 'was' : 'was not'} possible), the file has "${stored[0].id}"`);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), SETTINGS_JSON.replace('Site A', 'Site B'), 'only siteName changed');
  });

  await check('glob() control: an `id`-named field is an ordinary field, and its edit is saved', async () => {
    const entry = await getJson('/api/content/people/ada');
    const form = renderEntry(peopleSchema, entry.data);
    const idControl = form.querySelector('[name="id"]');
    assert.equal(idControl.readOnly, false, 'a glob() id field became read-only');
    assert.ok(typeInto(idControl, 'person-2'));
    await saveEntry('people', 'ada', extractFormData(form, peopleSchema));
    assert.equal(JSON.parse(fs.readFileSync(personPath, 'utf8')).id, 'person-2');
  });

  await check('new file() entry: the form shows the chosen name as its id, and creating it saves that id', async () => {
    fs.writeFileSync(settingsPath, SETTINGS_JSON);
    // The dashboard's own renderEditorForNewEntry, its loaders stubbed (as save-body does).
    const dashboardSrc = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
    const fnSrc = dashboardSrc.match(/function renderEditorForNewEntry\(schema, contentType, ctx\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(fnSrc, 'renderEditorForNewEntry not found');
    const names = Object.keys(formGenerator);
    const render = new Function('document', ...names, 'installSaver', 'setupFieldWidgets', 'collapseAllBlocks',
      'setupBlockFocus', 'showEntryProblems', `${fnSrc}\nreturn renderEditorForNewEntry;`)(
      document, ...names.map((name) => formGenerator[name]), () => {}, () => {}, () => {}, () => {}, () => {});
    document.body.innerHTML = '<div id="editorForm"></div>';
    render(settingsSchema, 'data', { collection: 'settings', slug: 'footer', locale: null });
    const form = document.getElementById('contentForm');
    const idControl = form.querySelector('[name="id"]');
    assert.ok(idControl, 'no id control on the new-entry form');
    assert.equal(idControl.value, 'footer', 'the new entry does not show the id it will be saved under');
    assert.equal(idControl.readOnly, true);
    assert.ok(typeInto(form.querySelector('[name="siteName"]'), 'Footer'));
    await saveEntry('settings', 'footer', extractFormData(form, settingsSchema));
    const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(stored.map((item) => item.id), ['main', 'footer']);
    assert.deepEqual(stored[1], { id: 'footer', siteName: 'Footer' });
  });
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
