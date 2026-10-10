/**
 * The editor half of image() support (happy-dom): an Astro image() field's
 * picker is marked, stores the entry-relative value the server resolves
 * (POST /api/images/:filename/entry-value) instead of the library URL, keeps
 * its old value when that fails, and previews entry-relative paths. A plain
 * image field still stores the library URL and makes no request.
 * The server half, and a real `astro build`, are in image-field-astro.test.js.
 *
 *   bun tests/image-picker-astro.test.js
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.FormData = window.FormData;
globalThis.CSS = window.CSS;
globalThis.HTMLElement = window.HTMLElement;
let alerts = [];
globalThis.alert = (message) => alerts.push(message);

const { generateForm } = await import('../ui/form-generator.js');
const { applyPickedImage, registerEntryContext, resolveImageUrl } = await import('../ui/field-widgets.js');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}\n   ${String(error.message).split('\n').join('\n   ')}`);
    failures.push(name);
  }
}

const schema = {
  type: 'object',
  properties: {
    cover: { type: 'string', 'x-astroadmin-image': true }, // image()
    banner: { type: 'string' }, // a plain string image field, by name
  },
};

function render(data) {
  const form = document.createElement('form');
  form.innerHTML = generateForm(schema, data);
  document.body.appendChild(form);
  return form;
}
const pickerFor = (form, field) => form.querySelector(`.image-picker[data-field="${field}"]`);

/** Replace fetch with one recorded, canned response. */
function stubFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}

console.log('\n🧪 image() picker\n' + '='.repeat(40));

await check('only the image() field is marked data-astro-image', () => {
  const form = render({});
  assert.ok(pickerFor(form, 'cover')?.hasAttribute('data-astro-image'), 'cover');
  assert.ok(pickerFor(form, 'banner'), 'control: banner is an image picker too');
  assert.equal(pickerFor(form, 'banner').hasAttribute('data-astro-image'), false, 'banner');
});

await check('a plain image field stores the library URL and makes no request', async () => {
  const calls = stubFetch(500, {});
  const form = render({});
  const changed = await applyPickedImage(pickerFor(form, 'banner'), '/images/x-1.png', { filename: 'x-1.png', source: 'uploads' });
  assert.equal(changed, true);
  assert.equal(form.querySelector('[name="banner"]').value, '/images/x-1.png');
  assert.equal(calls.length, 0);
});

await check('an image() field stores the entry-relative value the server resolves', async () => {
  registerEntryContext(() => ({ collection: 'posts', slug: '2024/first' }));
  const calls = stubFetch(200, { success: true, value: '../../assets/images/x-1.png', previewUrl: '/assets/images/x-1.png' });
  const form = render({});
  const changed = await applyPickedImage(pickerFor(form, 'cover'), '/images/x-1.png', { filename: 'x-1.png', source: 'uploads' });
  assert.equal(changed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/images/x-1.png/entry-value');
  assert.deepEqual(JSON.parse(calls[0].init.body), { collection: 'posts', slug: '2024/first', source: 'uploads' });
  assert.equal(form.querySelector('[name="cover"]').value, '../../assets/images/x-1.png');
  assert.equal(pickerFor(form, 'cover').querySelector('[data-preview-img]').getAttribute('src'), '/assets/images/x-1.png');
});

await check('when the server refuses, the image() field keeps its value and the editor is told', async () => {
  registerEntryContext(() => ({ collection: 'posts', slug: 'a' }));
  stubFetch(404, { success: false, error: 'Image not found' });
  alerts = [];
  const form = render({ cover: '../assets/images/old.png' });
  const changed = await applyPickedImage(pickerFor(form, 'cover'), '/images/gone.png', { filename: 'gone.png' });
  assert.equal(changed, false);
  assert.equal(form.querySelector('[name="cover"]').value, '../assets/images/old.png');
  assert.equal(alerts.length, 1, 'one message');
  assert.match(alerts[0], /Image not found/);
});

await check('with no entry open, entry-relative image() values preview from /assets', () => {
  registerEntryContext(() => null);
  assert.equal(resolveImageUrl('../assets/images/x.png'), '/assets/images/x.png');
  assert.equal(resolveImageUrl('../../assets/images/x.png'), '/assets/images/x.png');
  assert.equal(resolveImageUrl('./assets/x.png'), '/assets/x.png');
  assert.equal(resolveImageUrl('../content/assets/images/x.png'), '/assets/images/x.png');
  assert.equal(resolveImageUrl('../../src/content/assets/images/x.png'), '/assets/images/x.png');
  // Controls: public paths, URLs and bare names are unchanged.
  assert.equal(resolveImageUrl('/images/x.png'), '/images/x.png');
  assert.equal(resolveImageUrl('https://example.com/x.png'), 'https://example.com/x.png');
  assert.equal(resolveImageUrl('x.png'), '/images/x.png');
  assert.equal(resolveImageUrl('../photos/x.png'), '../photos/x.png');
});

await check('with an entry open, they preview through the server, resolved against that entry', () => {
  // src/assets/images/x.png and src/content/assets/images/x.png would both be
  // /assets/images/x.png; only the entry's directory tells them apart
  // (GET /api/images/entry-file, tests/image-astro-fields.test.js).
  registerEntryContext(() => ({ collection: 'posts', slug: '2024/first' }));
  const url = new URL(resolveImageUrl('../../assets/images/x.png'), 'http://localhost');
  assert.equal(url.pathname, '/api/images/entry-file');
  assert.deepEqual(Object.fromEntries(url.searchParams), { collection: 'posts', slug: '2024/first', path: '../../assets/images/x.png' });
  assert.equal(resolveImageUrl('/images/x.png'), '/images/x.png', 'control: a public path is unchanged');
});

await check('an existing image() value renders its thumbnail on first load', () => {
  registerEntryContext(() => ({ collection: 'posts', slug: 'a' }));
  const form = render({ cover: '../../assets/images/x.png' });
  assert.equal(pickerFor(form, 'cover').querySelector('[data-preview-img]').getAttribute('src'), resolveImageUrl('../../assets/images/x.png'));
  registerEntryContext(() => null);
  const unopened = render({ cover: '../../assets/images/x.png' });
  assert.equal(pickerFor(unopened, 'cover').querySelector('[data-preview-img]').getAttribute('src'), '/assets/images/x.png');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failures.length} failed.\n`);
if (failures.length) process.exit(1);
