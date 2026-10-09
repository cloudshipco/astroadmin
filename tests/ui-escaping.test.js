/**
 * Server data rendered into the admin UI as markup must stay data.
 *
 * File names, slugs, commit messages, image names and stored values come from
 * the site's repository and its editors, so a name such as
 * `a"><img src=x onerror=alert(1)>.md` must render as that literal text (or
 * attribute value) and inject no element. Each module is driven through its real
 * entry point in happy-dom with `fetch` stubbed to return hostile names, then the
 * DOM is checked for the literal name AND for the absence of an injected <img>.
 *
 *   bun tests/ui-escaping.test.js
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
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
globalThis.confirm = () => false;
globalThis.alert = () => {};

const HOSTILE = 'a"><img src=x onerror=alert(1)>.md';
const HOSTILE_IMAGE = 'b"><img src=x onerror=alert(2)>.png';
const HOSTILE_MESSAGE = 'Fix </span><img src=x onerror=alert(3)> & "quotes"';

const routes = new Map();
globalThis.fetch = async (url) => {
  const key = String(url).split('?')[0];
  if (!routes.has(key)) throw new Error(`unstubbed fetch ${url}`);
  return { ok: true, status: 200, json: async () => routes.get(key) };
};

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.message}`);
    failures.push(name);
  }
}

/** No element was injected: the only <img> elements are the ones we expect. */
function assertNoInjectedImg(root, label, allowedSrcs = []) {
  const injected = [...root.querySelectorAll('img')].filter((img) => !allowedSrcs.includes(img.getAttribute('src')));
  assert.equal(injected.length, 0, `${label}: injected <img> (${injected.map((i) => i.outerHTML).join(' ')})`);
  assert.equal(root.querySelectorAll('[onerror]').length, 0, `${label}: element with onerror`);
}

const changesPanel = await import('../ui/changes-panel.js');
const { generateForm } = await import('../ui/form-generator.js');
const { openImageLibrary } = await import('../ui/image-library.js');
const { openReferencePicker } = await import('../ui/reference-picker.js');

console.log('\n🧪 server data stays data in the admin UI\n' + '='.repeat(40));

routes.set('/api/git/status', { success: true, status: { modified: [HOSTILE], created: [`dir/${HOSTILE}`], deleted: [] } });
routes.set('/api/git/log', { success: true, commits: [{ hashShort: 'abc1234', message: HOSTILE_MESSAGE, date: new Date().toISOString() }] });
routes.set('/api/git/diff', { success: true, diff: `+++ b/${HOSTILE}\n+line` });

await check('changes panel: a hostile file name is one change row, as text and attributes', async () => {
  await changesPanel.toggleChangesPanel();
  const panel = document.getElementById('changesPanel');
  const rows = panel.querySelectorAll('.change-item');
  assert.equal(rows.length, 2, `expected 2 change rows, got ${rows.length}`);
  assertNoInjectedImg(panel, 'changes list');
  const revert = rows[0].querySelector('[data-revert-file]');
  assert.equal(revert.dataset.revertFile, HOSTILE, 'revert button carries the literal name');
  assert.equal(rows[0].querySelector('[data-view-diff]').dataset.viewDiff, HOSTILE, 'diff button carries the literal name');
  assert.equal(rows[0].querySelector('.change-file').getAttribute('title'), HOSTILE);
  assert.equal(rows[0].querySelector('.change-file').textContent, HOSTILE);
  assert.equal(rows[1].querySelector('[data-revert-file]').dataset.revertFile, `dir/${HOSTILE}`);
});

await check('changes panel: a hostile commit message is text', async () => {
  const panel = document.getElementById('changesPanel');
  const message = panel.querySelector('.commit-message');
  assert.ok(message, 'commit row rendered');
  assert.equal(message.getAttribute('title'), HOSTILE_MESSAGE);
  assert.equal(message.textContent, HOSTILE_MESSAGE.slice(0, 40) + '...');
  assertNoInjectedImg(panel, 'commit list');
});

await check('diff modal: the heading and Revert File button carry the literal name', async () => {
  const panel = document.getElementById('changesPanel');
  panel.querySelector('[data-view-diff]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const modal = document.getElementById('diffModal');
  assert.ok(modal, 'diff modal opened');
  assertNoInjectedImg(modal, 'diff modal');
  assert.equal(modal.querySelector('h3').textContent, `Changes: ${HOSTILE}`);
  assert.equal(modal.querySelector('[data-revert-file]').dataset.revertFile, HOSTILE);
  assert.ok(modal.querySelector('.diff-content').textContent.includes(HOSTILE), 'diff text shown verbatim');
  modal.remove();
});

routes.set('/api/images', {
  success: true,
  images: [{ url: `/images/${HOSTILE_IMAGE}`, filename: HOSTILE_IMAGE, source: 'uploads' }],
});

await check('image library: a hostile image file name stays in its attributes', async () => {
  await openImageLibrary(() => {});
  const grid = document.querySelector('#imageLibraryModal [data-grid]');
  const items = grid.querySelectorAll('.image-library-item');
  assert.equal(items.length, 1, `expected 1 item, got ${items.length}`);
  assertNoInjectedImg(grid, 'image grid', [`/images/${HOSTILE_IMAGE}`]);
  assert.equal(items[0].dataset.url, `/images/${HOSTILE_IMAGE}`);
  const img = items[0].querySelector('img');
  assert.equal(img.getAttribute('src'), `/images/${HOSTILE_IMAGE}`);
  assert.equal(img.getAttribute('alt'), HOSTILE_IMAGE);
  assert.equal(items[0].querySelector('[data-delete]').dataset.delete, HOSTILE_IMAGE);
});

routes.set('/api/collections/people/entries', {
  success: true,
  entries: [{ slug: HOSTILE, title: 'Person', data: { name: HOSTILE } }],
});

await check('reference picker: a hostile slug stays in data-id', async () => {
  await openReferencePicker('people', () => {});
  const modal = document.getElementById('referencePickerModal');
  const cards = modal.querySelectorAll('.reference-list-item');
  assert.equal(cards.length, 1, `expected 1 card, got ${cards.length}`);
  assertNoInjectedImg(modal, 'reference picker');
  assert.equal(cards[0].dataset.id, HOSTILE);
});

await check('number field: a non-numeric stored value cannot leave the value attribute', () => {
  const html = generateForm(
    { type: 'object', properties: { rating: { type: 'number' } } },
    { rating: HOSTILE },
  );
  const host = document.createElement('div');
  host.innerHTML = html;
  assertNoInjectedImg(host, 'number field');
  const input = host.querySelector('input[name="rating"]');
  assert.ok(input, 'number input rendered');
  assert.equal(input.getAttribute('value'), HOSTILE);
});

// The dashboard builds these from loaded entries and pages but has no DOM
// harness (it boots on import), so its render code is run directly, extracted
// from the source like tests/focus-editor-field.test.js does.
const dashboardSrc = readFileSync(path.join(import.meta.dir, '../ui/dashboard.js'), 'utf8');
const escapeSrc = readFileSync(path.join(import.meta.dir, '../ui/escape-html.js'), 'utf8').replace('export function', 'function');

await check('dashboard: a virtual page with a hostile file name renders it as text', () => {
  const fnSrc = dashboardSrc.match(/function renderVirtualPagePanel\(page\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fnSrc, 'renderVirtualPagePanel not found');
  document.body.innerHTML = '<div id="editorForm"></div>';
  const render = new Function('document', 'allCollections', 'navigateToCollection',
    `${escapeSrc}\n${fnSrc}\nreturn renderVirtualPagePanel;`)(document, [], () => {});
  render({ path: `src/pages/${HOSTILE.replace('.md', '.astro')}`, url: `/${HOSTILE}`, collections: [] });
  const form = document.getElementById('editorForm');
  assertNoInjectedImg(form, 'virtual page panel');
  const codes = [...form.querySelectorAll('code')].map((c) => c.textContent);
  assert.deepEqual(codes, [`src/pages/${HOSTILE.replace('.md', '.astro')}`, `/${HOSTILE}`]);
});

await check('dashboard: no error message or markdown body is interpolated unescaped', () => {
  // Source-level: these sit inside the big async loaders. An error message can
  // echo a slug or a server path; the body is the editor's own markdown, which in
  // an RCDATA <textarea> would also lose `&lt;` (decoded to `<`) on the next save.
  const offenders = [...dashboardSrc.matchAll(/\$\{(error\.message|bodyContent)\}/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [], `unescaped: ${offenders.join(', ')}`);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exit(1);
