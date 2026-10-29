/**
 * The colour field (#81) and field labels, in happy-dom through the real
 * renderer (generateForm), the real widget wiring (setupFormHandlers ->
 * setupFieldWidgets) and the real read-back (extractFormData).
 *
 * Pins:
 *   - a blank colour shows a "no colour" swatch (`data-no-colour`), never a
 *     colour: it used to show white, which an editor reads as "white is in
 *     use" when blank means the site's default. A value the swatch cannot
 *     show (`var(--brand)`, an unknown name) is not drawn as white either.
 *   - the text box invites a hex code, not colour names (a hex-only schema
 *     refuses `navy`); a site's own `placeholder` wins.
 *   - an untouched blank saves as it was stored (absent, null or '').
 *   - picking a colour saves its hex, shows it, and offers the clear button;
 *     clearing (the button, or emptying the box) behaves like other widget
 *     clears: a nullable saves null, even in a new (unbound) entry.
 *   - a zod 4 `.meta({ label })` labels every kind of field, escaped.
 *
 *   bun tests/colour-field.test.js
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';
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

const { generateForm, extractFormData, setupFormHandlers, bindOriginalValues } = await import('../ui/form-generator.js');

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

// The same serializer the schema parser uses for a zod 4 site.
const toSchema = (zodSchema) => z.toJSONSchema(zodSchema, { reused: 'inline', unrepresentable: 'any', io: 'input' });

const schema = toSchema(z.object({
  title: z.string(),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().nullable().optional(),
  bandColour: z.string().optional(),
}));

/** Render as the dashboard does: a loaded entry is bound, a new one is not. */
function render(formSchema, data, { bound = true } = {}) {
  document.body.innerHTML = '';
  const form = document.createElement('form');
  form.innerHTML = generateForm(formSchema, data);
  document.body.appendChild(form);
  setupFormHandlers(form, () => {});
  if (bound) bindOriginalValues(form, data);
  return form;
}

const parts = (form, name) => {
  const text = form.querySelector(`input.color-picker-text[name="${name}"]`);
  assert.ok(text, `positive control: ${name} renders as a colour field`);
  const wrapper = text.closest('.color-picker-wrapper');
  return { text, wrapper, swatch: wrapper.querySelector('.color-picker-input') };
};
const fire = (element, type) => element.dispatchEvent(new window.Event(type, { bubbles: true }));
const click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// --- What a blank colour looks like -----------------------------------------

await check('a blank colour renders a no-colour swatch, not white', () => {
  const html = generateForm(schema, { title: 'T' });
  const swatch = html.match(/<input[^>]*color-picker-input[^>]*>/)?.[0] || '';
  assert.ok(swatch, 'positive control: a swatch is rendered');
  assert.ok(/data-no-colour/.test(swatch), `the blank swatch must be marked as no colour: ${swatch}`);
  assert.ok(!/value="#ffffff"/i.test(swatch), `the blank swatch must not claim white: ${swatch}`);
});

await check('a set colour renders its own swatch (positive control)', () => {
  const html = generateForm(schema, { title: 'T', textColor: '#1b2a4a' });
  const swatch = html.match(/<input[^>]*color-picker-input[^>]*>/)?.[0] || '';
  assert.ok(/value="#1b2a4a"/.test(swatch), swatch);
  assert.ok(!/data-no-colour/.test(swatch), swatch);
});

await check('a null colour, and one the swatch cannot show, are not drawn as white', () => {
  for (const value of [null, 'var(--brand)', 'rebeccapurple', 'transparent']) {
    const html = generateForm(schema, { title: 'T', accentColor: value });
    const swatch = html.match(/<input[^>]*color-picker-input[^>]*>/)?.[0] || '';
    assert.ok(/data-no-colour/.test(swatch), `${value}: ${swatch}`);
    assert.ok(!/value="#ffffff"/i.test(swatch), `${value}: ${swatch}`);
  }
});

await check('the text box invites a hex code, not colour names', () => {
  const form = render(schema, { title: 'T' });
  const { text } = parts(form, 'textColor');
  assert.ok(!/name/i.test(text.placeholder), `placeholder: ${text.placeholder}`);
  assert.match(text.placeholder, /#[0-9a-f]{6}/i);
});

await check("a site's own placeholder (.meta) wins", () => {
  const own = toSchema(z.object({ brandColor: z.string().meta({ placeholder: 'navy, or #1b2a4a' }).optional() }));
  const form = render(own, {});
  assert.equal(parts(form, 'brandColor').text.placeholder, 'navy, or #1b2a4a');
});

// --- Saving -----------------------------------------------------------------

await check('an untouched blank saves as stored: absent, null and empty string', () => {
  const stored = { title: 'T', accentColor: null, bandColour: '' };
  const form = render(schema, stored);
  form.querySelector('[name="title"]').value = 'Edited';
  fire(form.querySelector('[name="title"]'), 'input');
  const data = extractFormData(form, schema);
  assert.equal(data.title, 'Edited', 'positive control: the edit is saved');
  assert.ok(!('textColor' in data), `absent stays absent: ${JSON.stringify(data)}`);
  assert.strictEqual(data.accentColor, null);
  assert.strictEqual(data.bandColour, '');
});

await check('picking a colour saves its hex, shows it and offers the clear button', () => {
  const form = render(schema, { title: 'T' });
  const { text, swatch, wrapper } = parts(form, 'textColor');
  assert.ok(!wrapper.querySelector('[data-clear-color]'), 'positive control: a blank field has no clear button');
  swatch.value = '#1b2a4a';
  fire(swatch, 'input');
  assert.equal(text.value, '#1b2a4a');
  assert.ok(!swatch.hasAttribute('data-no-colour'), 'the swatch shows the picked colour');
  assert.ok(wrapper.querySelector('[data-clear-color]'), 'a picked colour can be cleared');
  assert.equal(extractFormData(form, schema).textColor, '#1b2a4a');
});

await check('typing a hex shows it; emptying the box shows no colour again', () => {
  const form = render(schema, { title: 'T' });
  const { text, swatch } = parts(form, 'textColor');
  text.value = '#123456';
  fire(text, 'input');
  assert.equal(swatch.value, '#123456');
  assert.ok(!swatch.hasAttribute('data-no-colour'));
  text.value = '';
  fire(text, 'input');
  assert.ok(swatch.hasAttribute('data-no-colour'));
});

await check('the clear button: no colour shown, and a nullable saves null (stored colour, and a new entry)', () => {
  // A loaded entry clears its stored colour; a new one clears a colour just
  // picked. (A loaded entry whose colour was ABSENT, picked then cleared, is
  // back at its stored state, so it saves absent: the untouched-fields rule.)
  for (const bound of [true, false]) {
    const form = render(schema, bound ? { title: 'T', accentColor: '#abcdef' } : { title: 'T' }, { bound });
    const { text, swatch, wrapper } = parts(form, 'accentColor');
    if (!bound) {
      swatch.value = '#1b2a4a';
      fire(swatch, 'input');
    }
    click(wrapper.querySelector('[data-clear-color]'));
    assert.equal(text.value, '');
    assert.ok(swatch.hasAttribute('data-no-colour'), `bound=${bound}: the swatch shows no colour`);
    assert.ok(!wrapper.querySelector('[data-clear-color]'), `bound=${bound}: nothing left to clear`);
    assert.strictEqual(extractFormData(form, schema).accentColor, null, `bound=${bound}`);
  }
});

await check('a picked colour emptied by typing saves null in a new entry too', () => {
  const form = render(schema, { title: 'T' }, { bound: false });
  const { text, swatch } = parts(form, 'accentColor');
  swatch.value = '#1b2a4a';
  fire(swatch, 'input');
  text.value = '';
  fire(text, 'input');
  assert.strictEqual(extractFormData(form, schema).accentColor, null);
});

// --- Labels -----------------------------------------------------------------

await check('.meta({ label }) labels every kind of field, escaped', () => {
  const label = (text) => ({ label: text });
  const labelled = toSchema(z.object({
    textColor: z.string().meta(label('Text colour & tone')).optional(),
    ctaHref: z.string().meta(label('Button link')),
    showBanner: z.boolean().meta(label('Show the banner')),
    seo: z.object({ title: z.string() }).meta(label('Search engines')),
    tags: z.array(z.string()).meta(label('Topics')),
    stats: z.array(z.object({ value: z.string(), caption: z.string() })).meta(label('Figures')),
    heroImage: z.string().meta(label('Banner picture')),
    maybe: z.string().meta(label('Inner label')).nullable(),
  }));
  const html = generateForm(labelled, {});
  for (const text of ['Text colour &amp; tone', 'Button link', 'Show the banner', 'Search engines', 'Topics', 'Figures', 'Banner picture', 'Inner label']) {
    assert.ok(html.includes(text), `${text} missing`);
  }
  assert.ok(!html.includes('Text colour & tone'), 'a label is escaped');
  for (const guess of ['Cta Href', 'Show Banner', '>Seo<', '>Tags<', '>Stats<', 'Hero Image']) {
    assert.ok(!html.includes(guess), `${guess} should be replaced by the label`);
  }
});

await check('a label also reaches a gallery, blocks and reference pickers (an <x>Ids list too)', () => {
  // The shapes the schema parser and block enrichment hand the renderer.
  const html = generateForm({
    type: 'object',
    properties: {
      gallery: { type: 'array', label: 'Photos', items: { type: 'object', properties: { src: { type: 'string' }, alt: { type: 'string' } } } },
      blocks: { type: 'array', label: 'Sections', blockTypes: { hero: { properties: {} } } },
      author: { type: 'string', referenceCollection: 'team', label: 'Written by' },
      teamIds: { type: 'array', items: { type: 'string' }, referenceCollection: 'team', label: 'People' },
      plainIds: { type: 'array', items: { type: 'string' }, referenceCollection: 'team' },
    },
  }, {});
  for (const text of ['Photos', 'Sections', 'Written by', 'People']) assert.ok(html.includes(text), `${text} missing`);
  assert.ok(html.includes('>Team '), 'positive control: an unlabelled <x>Ids list is still labelled by its collection');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
