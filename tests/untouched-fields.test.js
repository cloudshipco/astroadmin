/**
 * Untouched fields keep their stored values on save.
 *
 * Every save rebuilds the entry from the form's DOM, so a control that reads
 * its value back must reproduce the stored value exactly, and many cannot: a
 * null shows as an empty box, a {collection, id} reference as its id, a
 * datetime with an offset and microseconds as UTC to the millisecond, a null
 * object as an object of empty strings. The rule (ui/form-generator.js
 * bindOriginalValues): a control or container the editor has not changed
 * saves the value the entry had when it was loaded, at the path it was
 * rendered from; only changed ones are read from the DOM.
 *
 * Fixtures come from the REAL converters: a throwaway site whose content config
 * declares zod 4 collections (markdown and a file() JSON collection) and a
 * zod 3 one (`zod/v3`), served by the real createServer() app. The editor side
 * is the real renderer and handlers in happy-dom, bound as the dashboard binds
 * a loaded entry.
 *
 * Every matrix case also runs with the form UNBOUND (the rule disabled), and
 * must then lose the value: a case a DOM round trip keeps proves nothing.
 *
 *   bun tests/untouched-fields.test.js
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
globalThis.confirm = () => true;
window.confirm = () => true;

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-untouched-')));
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

const hero = z.object({ type: z.literal('hero'), heading: z.string(), subheading: z.string().nullable(), count: z.number().nullable() });
const cta = z.object({ type: z.literal('cta'), label: z.string(), target: reference('team').nullable(), when: z.date().nullable() });
const link = z.object({ label: z.string(), href: z.string(), weight: z.number().nullable() });
const faq = z.object({ question: z.string(), answers: z.array(z.object({ text: z.string(), votes: z.number().nullable() })) });

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: ({ image }) => z.object({
    title: z.string(),
    summary: z.string().nullable(),
    label: z.string().nullable(),
    count: z.number().nullable(),
    rank: z.number().int().nullable(),
    flag: z.boolean().nullable(),
    featured: z.boolean().optional(),
    kind: z.enum(['a', 'b']).nullable(),
    when: z.date(),
    at: z.date(),
    stamp: z.string().datetime({ offset: true }),
    image: z.string().nullable(),
    heroVideo: z.string().nullable(),
    backgroundVideo: z.string(),
    cover: image().nullable().optional(),
    accentColor: z.string().nullable(),
    author: reference('team'),
    reviewer: reference('team').nullable(),
    coauthors: z.array(reference('team')),
    teamIds: z.array(z.string()).optional(),
    photos: z.array(z.object({ src: z.string(), alt: z.string().optional() })).nullable(),
    seo: z.object({ title: z.string(), description: z.string() }).nullable(),
    meta: z.object({ score: z.number().nullable(), note: z.string().optional() }),
    links: z.array(link),
    sponsors: z.array(link).nullable(),
    faqs: z.array(faq).optional(),
    points: z.array(z.number().nullable()),
    blocks: z.array(z.discriminatedUnion('type', [hero, cta])),
  }),
});

const events = defineCollection({
  loader: file('src/data/events.json'),
  schema: z.object({
    id: z.string(),
    title: z.string(),
    count: z.number().nullable(),
    flag: z.boolean().nullable(),
    at: z.coerce.date(),
    author: reference('team'),
    reviewer: reference('team').nullable(),
    seo: z.object({ title: z.string() }).nullable(),
    points: z.array(z.number().nullable()),
    links: z.array(link),
  }),
});

const legacy = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/legacy' }),
  schema: z3.object({
    title: z3.string(),
    count: z3.number().nullable(),
    flag: z3.boolean().nullable(),
    label: z3.string().nullable(),
    when: z3.date(),
    at: z3.date(),
    seo: z3.object({ title: z3.string() }).nullable(),
    items: z3.array(z3.object({ a: z3.string(), b: z3.number().nullable() })).nullable(),
    points: z3.array(z3.number().nullable()),
  }),
});

export const collections = { team, posts, events, legacy };
`);
writeProjectFile('src/data/team.json', `${JSON.stringify([{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }], null, 2)}\n`);

const POST_FILE = 'src/content/posts/hello.md';
const POST_TEXT = `---
title: Hello
summary: null
label: null
count: null
rank: null
flag: null
kind: null
when: 2026-07-01
at: 2026-07-01T12:30:00.100+05:00
stamp: '2026-07-01T12:30:00.100123+05:00'
image: null
heroVideo: null
backgroundVideo: /images/loop.mp4
cover: null
accentColor: null
author:
  collection: team
  id: ada
reviewer: null
coauthors:
  - collection: team
    id: grace
  - ada
teamIds:
  - ''
  - ada
photos: null
seo: null
meta:
  score: null
links:
  - label: Docs
    href: /docs
    weight: null
  - label: Blog
    href: /blog
    weight: 3
sponsors: null
faqs:
  - question: Why?
    answers:
      - text: Because
        votes: null
      - text: Just because
        votes: 2
points:
  - null
  - 2
blocks:
  - type: hero
    heading: Welcome
    subheading: null
    count: null
  - type: cta
    label: Join
    target:
      collection: team
      id: ada
    when: null
---
Body text.
`;
writeProjectFile(POST_FILE, POST_TEXT);

const EVENTS_FILE = 'src/data/events.json';
const EVENTS_TEXT = `[
  {
    "id": "launch",
    "title": "Launch",
    "count": null,
    "flag": null,
    "at": "2026-07-01T12:30:00.100123+05:00",
    "author": {
      "collection": "team",
      "id": "ada"
    },
    "reviewer": null,
    "seo": null,
    "points": [null, 2],
    "links": [
      {
        "label": "Docs",
        "href": "/docs",
        "weight": null
      }
    ]
  }
]
`;
// Laid out as the serialiser writes JSON (objects expanded, short arrays of
// primitives inline), so a title-only save changes one line.
writeProjectFile(EVENTS_FILE, EVENTS_TEXT);

const LEGACY_FILE = 'src/content/legacy/old.md';
const LEGACY_TEXT = `---
title: Old
count: null
flag: null
label: null
when: 2026-07-01
at: 2026-07-01T12:30:00.100+05:00
seo: null
items: null
points:
  - null
  - 2
---
Old body.
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

const { generateForm, extractFormData, setupFormHandlers, bindOriginalValues, setReferenceInputValue } =
  await import('../ui/form-generator.js');
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

  /**
   * Render an entry as the dashboard does. `bound` false is the rule disabled:
   * every value read back from the DOM.
   */
  function renderEntry(schema, data, { bound = true } = {}) {
    const form = document.createElement('form');
    form.innerHTML = generateForm(schema, data);
    document.body.appendChild(form);
    // happy-dom 20 mis-selects a <select> parsed from HTML (see extract-fields).
    for (const select of form.querySelectorAll('select')) {
      const marked = [...select.options].findIndex((option) => option.hasAttribute('selected'));
      if (marked >= 0) select.selectedIndex = marked;
    }
    setupFormHandlers(form, () => {});
    if (bound) bindOriginalValues(form, data);
    return form;
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

  const clone = (value) => JSON.parse(JSON.stringify(value));

  /**
   * One collection's matrix: edit only the title, in the editor bound and
   * unbound, and against a direct save of the loaded data with the title
   * changed (what an editor that changed nothing else must send).
   */
  async function titleOnlyMatrix({ label, collection, slug, file, originalText, titleLine, lossyKeys }) {
    const entry = await loadEntry(collection, slug);
    const schema = await loadSchema(collection);
    const edited = `${entry.data.title} edited`;

    const saveThrough = async (data) => {
      writeProjectFile(file, originalText);
      await saveEntry(collection, slug, data, entry.type);
      const text = readFile(file);
      writeProjectFile(file, originalText);
      return text;
    };
    const editorPayload = (bound) => {
      const form = renderEntry(schema, clone(entry.data), { bound });
      form.querySelector('[name="title"]').value = edited;
      const payload = extractFormData(form, schema);
      form.remove();
      return payload;
    };

    const direct = await saveThrough({ ...clone(entry.data), title: edited });
    const boundPayload = editorPayload(true);
    const unboundPayload = editorPayload(false);

    await check(`${label}: control: a direct title-only save changes only the title line`, () => {
      assert.notEqual(direct, originalText, 'the title was saved');
      assert.deepEqual(differingLines(originalText, direct), [titleLine], direct);
    });

    await check(`${label}: an unrelated edit leaves every untouched value as loaded`, () => {
      assert.equal(boundPayload.title, edited, 'positive control: the edit itself was read');
      for (const key of Object.keys(entry.data)) {
        if (key === 'title') continue;
        assert.deepStrictEqual(boundPayload[key], entry.data[key], `${key}`);
      }
      assert.deepStrictEqual(Object.keys(boundPayload).sort(), Object.keys(entry.data).sort(), 'no key added or lost');
    });

    await check(`${label}: rule disabled, each matrix value is changed by the DOM round trip`, () => {
      const changed = [...new Set([...Object.keys(entry.data), ...Object.keys(unboundPayload)])]
        .filter((key) => JSON.stringify(unboundPayload[key]) !== JSON.stringify(entry.data[key]));
      for (const key of lossyKeys) assert.ok(changed.includes(key), `${key} survives the DOM, so it proves nothing (unbound: ${JSON.stringify(unboundPayload[key])})`);
    });

    const viaEditor = await saveThrough(boundPayload);
    const viaDom = await saveThrough(unboundPayload);
    await check(`${label}: the saved file is byte-identical to the direct save`, () => {
      assert.equal(viaEditor, direct);
    });
    await check(`${label}: rule disabled, the saved file differs (mutation)`, () => {
      assert.notEqual(viaDom, direct);
    });
    return { entry, schema };
  }

  console.log('\n🧪 Untouched fields keep their stored values\n' + '='.repeat(40));

  // --- The matrix ------------------------------------------------------------

  const { entry: post, schema: postSchema } = await titleOnlyMatrix({
    label: 'zod 4 markdown',
    collection: 'posts',
    slug: 'hello',
    file: POST_FILE,
    originalText: POST_TEXT,
    titleLine: 1,
    // DELIBERATE (review round 2): no `count`, `rank` or `meta` (required
    // nullable numbers holding null, `meta.score` too), see the file() JSON
    // matrix below.
    lossyKeys: [
      'summary', 'label', 'flag', 'featured' /* absent */, 'kind', 'stamp', 'image', 'heroVideo', 'cover',
      'accentColor', 'author', 'reviewer', 'coauthors', 'teamIds', 'photos', 'seo', 'sponsors',
      'points', 'blocks', 'when',
    ],
  });

  await check('zod 4 markdown: the fixture renders each control kind it is meant to', () => {
    const form = renderEntry(postSchema, clone(post.data));
    const has = (selector, what) => assert.ok(form.querySelector(selector), `${what}: ${selector}`);
    has('textarea[name="summary"]', 'textarea');
    has('input[type="text"][name="label"]', 'one-line string');
    has('input[type="number"][name="count"]', 'number (type [number, null])');
    has('input[type="number"][name="rank"][step="1"]', 'integer (anyOf)');
    has('select[name="flag"][data-value-type="boolean"]', 'nullable boolean');
    has('input[type="checkbox"][name="featured"]', 'boolean');
    has('select[name="kind"]', 'enum');
    has('input[type="date"][name="when"]', 'date');
    has('input[type="datetime-local"][name="at"]', 'datetime');
    has('input[type="datetime-local"][name="stamp"]', 'datetime string');
    has('.image-picker[data-field="image"] input[name="image"]', 'image');
    has('.image-picker[data-video][data-field="heroVideo"] input[name="heroVideo"]', 'video (nullable)');
    has('.image-picker[data-video][data-field="backgroundVideo"] input[name="backgroundVideo"]', 'video');
    has('.image-picker[data-field="cover"][data-astro-image]', 'image()');
    has('input.color-picker-text[name="accentColor"]', 'colour');
    has('.reference-field[data-reference-single][data-field="author"]', 'single reference');
    has('.reference-field[data-array-items][data-field="coauthors"]', 'reference list');
    has('.reference-field[data-array-items][data-field="teamIds"]', '<x>Ids list');
    has('.gallery-field[data-field="photos"]', 'gallery');
    has('[data-object-field="seo"]', 'object');
    has('[data-array-cards][data-field="links"]', 'array of objects');
    has('.array-field[data-field="points"]', 'primitive array');
    has('.blocks-list[data-field="blocks"]', 'block list');
    form.remove();
  });

  await titleOnlyMatrix({
    label: 'zod 4 file() JSON',
    collection: 'events',
    slug: 'launch',
    file: EVENTS_FILE,
    originalText: EVENTS_TEXT,
    titleLine: 3,
    // DELIBERATE (review round 2): `count` (a required z.number().nullable()
    // holding null) is no longer lossy unbound. An empty nullable number box
    // nobody cleared now saves null where the key is required (it saved '',
    // which no number accepts), so the DOM reproduces this null by itself.
    lossyKeys: ['flag', 'at', 'author', 'reviewer', 'seo', 'points'],
  });

  const { entry: legacy, schema: legacySchema } = await titleOnlyMatrix({
    label: 'zod 3 markdown',
    collection: 'legacy',
    slug: 'old',
    file: LEGACY_FILE,
    originalText: LEGACY_TEXT,
    titleLine: 1,
    // DELIBERATE (review round 2): `count` dropped, as for file() JSON.
    lossyKeys: ['flag', 'label', 'seo', 'items', 'points'],
  });

  // --- Edited controls ---------------------------------------------------------

  await check('zod 3: a real z.date() with a date-only value is a date input, and changing the day keeps it date-only', async () => {
    assert.equal(legacySchema.properties.when.format, 'date-time', 'control: zod 3 serialises z.date() as date-time');
    const form = renderEntry(legacySchema, clone(legacy.data));
    const when = form.querySelector('[name="when"]');
    assert.equal(when.type, 'date');
    assert.equal(form.querySelector('[name="at"]').type, 'datetime-local', 'a date with a time keeps its time');
    when.value = '2026-07-02';
    const payload = extractFormData(form, legacySchema);
    form.remove();
    writeProjectFile(LEGACY_FILE, LEGACY_TEXT);
    const result = await saveEntry('legacy', 'old', payload, legacy.type);
    const text = readFile(LEGACY_FILE);
    writeProjectFile(LEGACY_FILE, LEGACY_TEXT);
    assert.match(text, /^when: 2026-07-02$/m, text);
    assert.deepEqual(differingLines(LEGACY_TEXT, text), [5], text);
    assert.equal(result.validation?.status, 'valid', JSON.stringify(result.validation));
  });

  await check('a cleared nullable control saves null (number, string, image, video, colour, single reference)', () => {
    const data = { ...clone(post.data), count: 4, label: 'x', image: '/images/a.png', heroVideo: '/images/a.mp4', accentColor: '#fff', reviewer: 'grace' };
    const form = renderEntry(postSchema, data);
    for (const name of ['count', 'label', 'image', 'heroVideo', 'accentColor']) form.querySelector(`[name="${name}"]`).value = '';
    setReferenceInputValue(form.querySelector('[data-reference-value][name="reviewer"]'), '');
    const payload = extractFormData(form, postSchema);
    form.remove();
    for (const name of ['count', 'label', 'image', 'heroVideo', 'accentColor', 'reviewer']) assert.strictEqual(payload[name], null, name);
  });

  await check('an edited reference saves the chosen id; its untouched neighbours keep their shape', () => {
    const form = renderEntry(postSchema, clone(post.data));
    setReferenceInputValue(form.querySelector('[data-reference-value][name="author"]'), 'grace');
    setReferenceInputValue(form.querySelector('[name="coauthors[1]"]'), 'grace');
    const payload = extractFormData(form, postSchema);
    form.remove();
    assert.equal(payload.author, 'grace');
    assert.deepStrictEqual(payload.coauthors, [post.data.coauthors[0], 'grace']);
  });

  await check('a list item with no id before others: removing a card keeps the right stored items', () => {
    // A lookup object after the empty item: read back from the DOM it would be
    // the id 'ada', and read from the card's index it would be the ''.
    const data = { ...clone(post.data), coauthors: ['', { collection: 'team', id: 'ada' }, 'grace'] };
    const form = renderEntry(postSchema, data);
    const cards = form.querySelectorAll('.reference-field[data-field="coauthors"] .reference-card');
    assert.equal(cards.length, 2, 'control: the item with no id is not shown');
    cards[1].remove();
    const payload = extractFormData(form, postSchema);
    form.remove();
    assert.deepStrictEqual(payload.coauthors, [{ collection: 'team', id: 'ada' }]);
  });

  await check('an unknown block type is kept as stored', () => {
    const data = { ...clone(post.data), blocks: [{ type: 'mystery', anything: [1, { x: null }] }, ...clone(post.data.blocks)] };
    const form = renderEntry(postSchema, data);
    form.querySelector('[name="title"]').value = 'Changed';
    const payload = extractFormData(form, postSchema);
    form.remove();
    assert.deepStrictEqual(payload.blocks, data.blocks);
  });

  // --- Reordering ----------------------------------------------------------------

  /** A drag event the handlers accept (happy-dom has no DataTransfer). */
  function dragEvent(type, clientY = 0) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    event.dataTransfer = { effectAllowed: '', dropEffect: '' };
    event.clientY = clientY;
    return event;
  }
  /** Drag `moving` onto `target`, dropping before it (happy-dom rects are 0). */
  function dragBefore(moving, target) {
    moving.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragover', -1));
    target.dispatchEvent(dragEvent('drop', -1));
    moving.dispatchEvent(dragEvent('dragend'));
  }
  async function waitFor(find) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = find();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timed out waiting for the element');
  }

  await check('reordering a block list: blocks move unchanged; editing one field changes only that', () => {
    const form = renderEntry(postSchema, clone(post.data));
    const blocks = form.querySelectorAll('.blocks-list > .block-item');
    dragBefore(blocks[1], blocks[0]);
    const moved = form.querySelectorAll('.blocks-list > .block-item');
    assert.equal(moved[0].dataset.type, 'cta', 'control: the drag reordered the blocks');
    assert.ok(form.querySelector('[name="blocks[0].label"]'), 'control: the moved block was reindexed');
    let payload = extractFormData(form, postSchema);
    assert.deepStrictEqual(payload.blocks, [post.data.blocks[1], post.data.blocks[0]]);
    form.querySelector('[name="blocks[1].heading"]').value = 'Hi';
    payload = extractFormData(form, postSchema);
    form.remove();
    assert.deepStrictEqual(payload.blocks, [post.data.blocks[1], { ...post.data.blocks[0], heading: 'Hi' }]);
  });

  await check('rule disabled, the reordered blocks lose their stored values (mutation)', () => {
    const form = renderEntry(postSchema, clone(post.data), { bound: false });
    const blocks = form.querySelectorAll('.blocks-list > .block-item');
    dragBefore(blocks[1], blocks[0]);
    const payload = extractFormData(form, postSchema);
    form.remove();
    assert.notDeepStrictEqual(payload.blocks, [post.data.blocks[1], post.data.blocks[0]]);
  });

  await check('reordering an array of objects, then editing one item in the item modal: the rest unchanged', async () => {
    const form = renderEntry(postSchema, clone(post.data));
    const cards = form.querySelectorAll('[data-array-cards][data-field="links"] .array-card');
    dragBefore(cards[1], cards[0]);
    let payload = extractFormData(form, postSchema);
    assert.deepStrictEqual(payload.links, [post.data.links[1], post.data.links[0]], 'reordered');
    // Edit the item now second (Docs, weight null) through the real modal.
    form.querySelector('[data-array-cards][data-field="links"] .array-card-edit[data-edit-card="1"]').click();
    const overlay = await waitFor(() => document.querySelector('.array-item-edit-overlay'));
    overlay.querySelector('[name="label"]').value = 'Documentation';
    overlay.querySelector('[data-save]').click();
    assert.equal(document.querySelector('.array-item-edit-overlay'), null, 'control: Done closed the modal');
    payload = extractFormData(form, postSchema);
    form.remove();
    assert.deepStrictEqual(payload.links, [post.data.links[1], { ...post.data.links[0], label: 'Documentation' }]);
    assert.deepStrictEqual(Object.keys(payload).sort(), Object.keys(post.data).sort());
  });

  await check('the item modal: open, edit one field, Done; the item\'s untouched values unchanged', async () => {
    const form = renderEntry(postSchema, clone(post.data));
    form.querySelector('[data-array-cards][data-field="links"] .array-card-edit[data-edit-card="0"]').click();
    const overlay = await waitFor(() => document.querySelector('.array-item-edit-overlay'));
    const weight = overlay.querySelector('[name="weight"]');
    assert.equal(weight.type, 'number', 'control: a nullable number in the modal is a number input');
    overlay.querySelector('[name="href"]').value = '/documentation';
    overlay.querySelector('[data-save]').click();
    const payload = extractFormData(form, postSchema);
    form.remove();
    assert.deepStrictEqual(payload.links[0], { ...post.data.links[0], href: '/documentation' });
    assert.strictEqual(payload.links[0].weight, null);
  });

  await check('nested item modals: an item inside an item keeps its untouched values', async () => {
    const form = renderEntry(postSchema, clone(post.data));
    form.querySelector('[data-array-cards][data-field="faqs"] .array-card-edit[data-edit-card="0"]').click();
    const outer = await waitFor(() => document.querySelector('.array-item-edit-overlay'));
    outer.querySelector('[data-array-cards][data-field="answers"] .array-card-edit[data-edit-card="0"]').click();
    const inner = await waitFor(() => document.querySelectorAll('.array-item-edit-overlay')[1]);
    inner.querySelector('[name="text"]').value = 'Because it is';
    inner.querySelector('[data-save]').click();
    outer.querySelector('[name="question"]').value = 'Why not?';
    outer.querySelector('[data-save]').click();
    const payload = extractFormData(form, postSchema);
    form.remove();
    const [stored] = post.data.faqs;
    assert.deepStrictEqual(payload.faqs, [{
      question: 'Why not?',
      answers: [{ ...stored.answers[0], text: 'Because it is' }, stored.answers[1]],
    }]);
    assert.strictEqual(payload.faqs[0].answers[0].votes, null);
  });
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}.\n`);
if (failures.length) process.exitCode = 1;
