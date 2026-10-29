/**
 * Form generator — reading fields back (extractFields / extractFormData)
 *
 * Run: bun tests/extract-fields.test.js
 *
 * extractFields rebuilds the entry from the DOM, not from the schema: whatever
 * named inputs are in the form become the saved object. So an array field that
 * renders one named input PER ITEM has nothing to submit when it has zero items,
 * and its key used to vanish from the saved file. A page saved with
 * `"blocks": []` came back with no `blocks` key at all, and a site whose schema
 * requires `blocks` then failed every build. These tests render through the real
 * generateForm into a real <form> (happy-dom), so the fixture is whatever the
 * renderer actually emits, never hand-written HTML.
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/' });
// extractFields uses the browser's FormData (Bun's own cannot read a <form>),
// CSS.escape, and the event loop of the handlers it shares with the dashboard.
globalThis.window = window;
globalThis.document = window.document;
globalThis.FormData = window.FormData;
globalThis.CSS = window.CSS;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.confirm = () => true;
window.confirm = () => true;

const { generateForm, extractFields, extractFormData, setupFormHandlers, bindOriginalValues } =
  await import('../ui/form-generator.js');

// Every check runs even after one fails, so a red run names every broken case
// instead of stopping at the first.
let passed = 0;
let assertions = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}\n   ${String(error.message).split('\n').join('\n   ')}`);
    failures.push(name);
  }
}
function equal(actual, expected, message) {
  assertions++;
  assert.deepStrictEqual(actual, expected, message);
}

/** Render a schema + data through the real renderer into a real <form>. */
function render(schema, data) {
  const form = document.createElement('form');
  form.innerHTML = generateForm(schema, data);
  document.body.appendChild(form);
  // happy-dom 20 (as of 2026-10) mis-selects a <select> parsed from HTML: with
  // `selected` on the third option it reports the second as selected. Browsers
  // select the option carrying the attribute, so put that state back.
  for (const select of form.querySelectorAll('select')) {
    const marked = [...select.options].findIndex((option) => option.hasAttribute('selected'));
    if (marked >= 0) select.selectedIndex = marked;
  }
  // As the dashboard does for a loaded entry: what it was rendered from is
  // what an untouched control saves.
  bindOriginalValues(form, data);
  return form;
}

// Positive control: prove the DOM harness can read a named input at all, so an
// empty or missing value below is the code's doing, not a dead instrument.
check('control: a plain string field reads back through happy-dom FormData', () => {
  const form = render({ type: 'object', properties: { title: { type: 'string' } } }, { title: 'Hello' });
  equal(extractFields(form), { title: 'Hello' });
});

// --- Blocks ----------------------------------------------------------------

const blockTypes = {
  hero: {
    type: 'object',
    properties: { type: { type: 'string', const: 'hero' }, heading: { type: 'string' } },
    required: ['type', 'heading'],
  },
  list: {
    type: 'object',
    properties: {
      type: { type: 'string', const: 'list' },
      heading: { type: 'string' },
      points: { type: 'array', items: { type: 'string' } },
    },
    required: ['type', 'heading', 'points'],
  },
};
const blocksSchema = { type: 'array', blockTypes, items: { anyOf: Object.values(blockTypes) } };

check('zero blocks extract as blocks: [] (not a missing key)', () => {
  const form = render({ type: 'object', properties: { blocks: blocksSchema } }, { blocks: [] });
  const data = extractFields(form);
  assert.ok('blocks' in data, 'blocks key must be present');
  assertions++;
  equal(data.blocks, []);
});

check('deleting the last block extracts blocks: []', () => {
  const form = render(
    { type: 'object', properties: { blocks: blocksSchema } },
    { blocks: [{ type: 'hero', heading: 'Welcome' }] },
  );
  equal(extractFields(form).blocks, [{ type: 'hero', heading: 'Welcome' }], 'control: block present before delete');
  form.querySelector('.block-item').remove();
  equal(extractFields(form).blocks, []);
});

check('deleting the last block through the real Delete button extracts blocks: []', () => {
  const form = render(
    { type: 'object', properties: { blocks: blocksSchema } },
    { blocks: [{ type: 'hero', heading: 'Welcome' }] },
  );
  setupFormHandlers(form, () => {});
  form.querySelector('.remove-block').click();
  equal(form.querySelectorAll('.block-item').length, 0, 'control: the handler removed the block');
  equal(extractFields(form).blocks, []);
});

check('populated blocks are unchanged', () => {
  const blocks = [
    { type: 'hero', heading: 'Welcome' },
    { type: 'list', heading: 'Why', points: ['Fast', 'Simple'] },
  ];
  const form = render({ type: 'object', properties: { blocks: blocksSchema } }, { blocks });
  equal(extractFields(form).blocks, blocks);
});

check('nested blocks path (section.blocks) with zero blocks extracts []', () => {
  const schema = {
    type: 'object',
    properties: {
      section: { type: 'object', properties: { label: { type: 'string' }, blocks: blocksSchema } },
    },
  };
  const form = render(schema, { section: { label: 'Main', blocks: [] } });
  equal(extractFields(form).section, { label: 'Main', blocks: [] });
});

check('an empty array inside a block item extracts [] on that block', () => {
  const form = render(
    { type: 'object', properties: { blocks: blocksSchema } },
    { blocks: [{ type: 'list', heading: 'Why', points: [] }] },
  );
  equal(extractFields(form).blocks, [{ type: 'list', heading: 'Why', points: [] }]);
});

check('after deleting an earlier block, a later block\'s empty nested array follows it to its new index', () => {
  const form = render(
    { type: 'object', properties: { blocks: blocksSchema } },
    { blocks: [{ type: 'hero', heading: 'Welcome' }, { type: 'list', heading: 'Why', points: [] }] },
  );
  setupFormHandlers(form, () => {});
  form.querySelector('.block-item[data-index="0"] .remove-block').click();
  // No phantom blocks[1] = { points: [] }, and the list block keeps its points.
  equal(extractFields(form).blocks, [{ type: 'list', heading: 'Why', points: [] }]);
});

check('after deleting an earlier block, a gallery inside a later block saves onto that block', () => {
  const photoTypes = {
    ...blockTypes,
    photos: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'photos' },
        images: { type: 'array', items: { type: 'object', properties: { src: { type: 'string' }, alt: { type: 'string' } } } },
      },
      required: ['type', 'images'],
    },
  };
  const schema = { type: 'object', properties: { blocks: { type: 'array', blockTypes: photoTypes } } };
  const images = [{ src: '/images/a.jpg', alt: 'A' }];
  const form = render(schema, { blocks: [{ type: 'hero', heading: 'Welcome' }, { type: 'photos', images }] });
  setupFormHandlers(form, () => {});
  form.querySelector('.block-item[data-index="0"] .remove-block').click();
  equal(extractFields(form).blocks, [{ type: 'photos', images }]);
});

// --- Other one-input-per-item array kinds ----------------------------------
// A reference list is marked `referenceCollection` by the schema parser
// (annotateReferences), which resolves it against the declared collections.

check('reference field with zero items extracts []', () => {
  const schema = { type: 'object', properties: { testimonialIds: { type: 'array', items: { type: 'string' }, referenceCollection: 'testimonials' } } };
  const form = render(schema, { testimonialIds: [] });
  assertions++;
  assert.ok(form.querySelector('.reference-field'), 'control: rendered as a reference field');
  equal(extractFields(form).testimonialIds, []);
});

check('reference field after removing its last card extracts []', () => {
  const schema = { type: 'object', properties: { testimonialIds: { type: 'array', items: { type: 'string' }, referenceCollection: 'testimonials' } } };
  const form = render(schema, { testimonialIds: ['t-1'] });
  equal(extractFields(form).testimonialIds, ['t-1'], 'control: populated before removal');
  form.querySelector('.reference-card').remove();
  equal(extractFields(form).testimonialIds, []);
});

check('populated reference field is unchanged', () => {
  const schema = { type: 'object', properties: { testimonialIds: { type: 'array', items: { type: 'string' }, referenceCollection: 'testimonials' } } };
  const form = render(schema, { testimonialIds: ['t-1', 't-2'] });
  equal(extractFields(form).testimonialIds, ['t-1', 't-2']);
});

check('simple string array with zero items extracts []', () => {
  const form = render({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }, { tags: [] });
  equal(extractFields(form).tags, []);
});

check('simple number array with zero items extracts []', () => {
  const form = render({ type: 'object', properties: { ratings: { type: 'array', items: { type: 'number' } } } }, { ratings: [] });
  equal(extractFields(form).ratings, []);
});

check('simple boolean array with zero items extracts []', () => {
  const form = render({ type: 'object', properties: { flags: { type: 'array', items: { type: 'boolean' } } } }, { flags: [] });
  equal(extractFields(form).flags, []);
});

check('single-property object array with zero items extracts []', () => {
  const schema = {
    type: 'object',
    properties: { links: { type: 'array', items: { type: 'object', properties: { href: { type: 'string' } } } } },
  };
  const form = render(schema, { links: [] });
  equal(extractFields(form).links, []);
});

check('simple array after deleting its last item extracts []', () => {
  const form = render({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }, { tags: ['oak'] });
  equal(extractFields(form).tags, ['oak'], 'control: populated before removal');
  form.querySelector('.array-item').remove();
  equal(extractFields(form).tags, []);
});

check('simple array: the real Delete button removes an item, reindexes, and saves', () => {
  const form = render({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }, { tags: ['oak', 'ash'] });
  let saves = 0;
  setupFormHandlers(form, () => { saves++; });
  form.querySelector('.array-item[data-index="0"] .remove-array-item').click();
  equal(saves, 1, 'deleting an item must fire the save callback');
  equal(extractFields(form).tags, ['ash']);
  form.querySelector('.remove-array-item').click();
  equal(saves, 2);
  equal(extractFields(form).tags, []);
});

check('populated simple array is unchanged', () => {
  const form = render({ type: 'object', properties: { ratings: { type: 'array', items: { type: 'number' } } } }, { ratings: [4, 5] });
  equal(extractFields(form).ratings, [4, 5]);
});

// These two already had a hidden carrier; kept as controls so a fix to the
// others cannot regress them.
check('control: gallery with zero images extracts []', () => {
  const schema = {
    type: 'object',
    properties: { gallery: { type: 'array', items: { type: 'object', properties: { src: { type: 'string' }, alt: { type: 'string' } } } } },
  };
  const form = render(schema, { gallery: [] });
  equal(extractFields(form).gallery, []);
});

check('control: object-card array with zero items extracts []', () => {
  const schema = {
    type: 'object',
    properties: { faqs: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } } } } },
  };
  const form = render(schema, { faqs: [] });
  equal(extractFields(form).faqs, []);
});

// --- Empty OPTIONAL arrays -------------------------------------------------
// The other half of the rule. An absent optional key is always valid, but `[]`
// is not when the schema says `.min(1)` — so filling `[]` for every empty array
// would break a site build in reverse. Through extractFormData (which applies
// cleanEmptyValues) an empty array survives only when the schema says its key is
// required. Shapes below are what z.toJSONSchema emits for
// `bullets: z.array(z.string()).min(1).optional()` (not in `required`, minItems 1).

const featureBlockTypes = {
  ...blockTypes,
  features: {
    type: 'object',
    properties: {
      type: { type: 'string', const: 'features' },
      heading: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    required: ['type', 'heading'],
  },
};
const pageSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    bullets: { type: 'array', items: { type: 'string' }, minItems: 1 },
    blocks: { type: 'array', blockTypes: featureBlockTypes, items: { anyOf: Object.values(featureBlockTypes) } },
  },
  required: ['title', 'blocks'],
};

check('optional min(1) array absent from the entry stays absent after save', () => {
  const entry = { title: 'Articles page', blocks: [] };
  const form = render(pageSchema, entry);
  equal(extractFormData(form, pageSchema), entry);
});

check('optional min(1) array emptied by deleting its last item saves as absent, not []', () => {
  const form = render(pageSchema, { title: 'Articles page', bullets: ['One'], blocks: [] });
  setupFormHandlers(form, () => {});
  form.querySelector('.array-field[data-field="bullets"] .remove-array-item').click();
  equal(form.querySelectorAll('.array-field[data-field="bullets"] .array-item').length, 0, 'control: item removed');
  equal(extractFormData(form, pageSchema), { title: 'Articles page', blocks: [] });
});

check('required blocks: [] still saves as blocks: []', () => {
  const form = render(pageSchema, { title: 'Articles page', blocks: [] });
  const saved = extractFormData(form, pageSchema);
  assertions++;
  assert.ok('blocks' in saved, 'required blocks key must survive cleanEmptyValues');
  equal(saved.blocks, []);
});

check('optional array with items is unchanged', () => {
  const entry = { title: 'Articles page', bullets: ['One', 'Two'], blocks: [] };
  const form = render(pageSchema, entry);
  equal(extractFormData(form, pageSchema), entry);
});

check('optional min(1) array inside a block item saves as absent, not []', () => {
  // The entry never had one: the empty list the editor renders is not saved.
  const entry = { title: 'Articles page', blocks: [{ type: 'features', heading: 'Why' }] };
  equal(extractFormData(render(pageSchema, entry), pageSchema), entry, 'never had one');
  // The editor emptied it: absent, as for any optional array.
  const form = render(pageSchema, { ...entry, blocks: [{ ...entry.blocks[0], tags: ['fast'] }] });
  form.querySelector('.array-item').remove();
  equal(extractFormData(form, pageSchema), entry, 'emptied by the editor');
  // A stored [] the editor leaves alone is left alone (untouched values keep
  // their stored value); the editor's validation warning reports it.
  const stored = { ...entry, blocks: [{ ...entry.blocks[0], tags: [] }] };
  equal(extractFormData(render(pageSchema, stored), pageSchema), stored, 'stored [] untouched');
});

check('optional array inside a block item with items is unchanged', () => {
  const entry = { title: 'Articles page', blocks: [{ type: 'features', heading: 'Why', tags: ['fast'] }] };
  const form = render(pageSchema, entry);
  equal(extractFormData(form, pageSchema), entry);
});

check('required array inside a block item still saves as []', () => {
  const entry = { title: 'Articles page', blocks: [{ type: 'list', heading: 'Why', points: [] }] };
  const form = render(pageSchema, entry);
  equal(extractFormData(form, pageSchema), entry);
});

// A constant (z.literal) renders as a hidden input carrying the schema's value
// and is not an editor's to change. A stored value at its path is kept when
// another field changes (it used to be re-read and, being an optional "",
// cleaned away); with nothing stored there, the schema's value is written.
const literalSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    marker: { type: 'string', const: '' },
    blocks: {
      type: 'array',
      blockTypes: {
        note: {
          type: 'object',
          properties: { type: { type: 'string', const: 'note' }, heading: { type: 'string' }, caption: { type: 'string', const: '' } },
          required: ['type', 'heading'],
        },
      },
    },
  },
  required: ['title', 'blocks'],
};

check('a stored optional literal "" is kept when a sibling field changes (top level)', () => {
  const form = render(literalSchema, { title: 'Before', marker: '', blocks: [] });
  form.querySelector('[name="title"]').value = 'After';
  equal(extractFormData(form, literalSchema), { title: 'After', marker: '', blocks: [] });
});

check('a stored optional literal "" in a block is kept when a sibling field in that block changes', () => {
  const form = render(literalSchema, { title: 'T', blocks: [{ type: 'note', heading: 'Before', caption: '' }] });
  form.querySelector('[name="blocks[0].heading"]').value = 'After';
  equal(extractFormData(form, literalSchema), { title: 'T', blocks: [{ type: 'note', heading: 'After', caption: '' }] });
});

check('an absent optional literal is saved as HEAD saved it when a sibling changes (absent at the top, "" in a block)', () => {
  // Unchanged by this rule, and pinned so a change to it is deliberate: the
  // const input carries '', which the top level drops as an optional '' and a
  // block keeps ('' is a valid value of z.literal('')). Whether an absent
  // optional key should ever be written is the open blank/absent question
  // (#69).
  const top = render(literalSchema, { title: 'T', blocks: [] });
  top.querySelector('[name="title"]').value = 'After';
  equal(extractFormData(top, literalSchema), { title: 'After', blocks: [] });
  const form = render(literalSchema, { title: 'T', blocks: [{ type: 'note', heading: 'Before' }] });
  form.querySelector('[name="blocks[0].heading"]').value = 'After';
  equal(extractFormData(form, literalSchema), { title: 'T', blocks: [{ type: 'note', heading: 'After', caption: '' }] });
});

check('control: a required literal missing from the stored entry is still written (an id is never lost)', () => {
  const schema = { type: 'object', properties: { id: { type: 'string', const: 'home' }, headline: { type: 'string' } }, required: ['id'] };
  const form = render(schema, { headline: 'Before' });
  form.querySelector('[name="headline"]').value = 'After';
  equal(extractFormData(form, schema), { id: 'home', headline: 'After' });
});

check('block items keep empty-string placeholders even for optional fields (unchanged exemption)', () => {
  const schema = {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        blockTypes: {
          note: {
            type: 'object',
            properties: { type: { type: 'string', const: 'note' }, caption: { type: 'string' } },
            required: ['type'],
          },
        },
      },
    },
    required: ['blocks'],
  };
  const entry = { blocks: [{ type: 'note', caption: '' }] };
  const form = render(schema, entry);
  equal(extractFormData(form, schema), entry);
});

check('with no schema at a level, an empty array is never dropped (fail safe)', () => {
  const schema = { type: 'object', properties: { meta: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } } } };
  const form = render(schema, { meta: { tags: [] } });
  // No `properties` for the cleaner at the top level → nothing removed anywhere.
  equal(extractFormData(form, {}), { meta: { tags: [] } });
});

// --- Realistic round trip --------------------------------------------------

check('a realistic page with blocks: [] round-trips through extractFormData unchanged', () => {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      slug: { type: 'string' },
      description: { type: 'string' },
      seoTitle: { type: 'string' },
      heroImage: { type: 'string' },
      blocks: blocksSchema,
    },
    required: ['title', 'slug', 'description', 'blocks'],
  };
  const page = {
    title: 'Articles page',
    slug: 'articles',
    description: "Everything we've written, newest first.",
    seoTitle: 'Articles | Site A',
    heroImage: '/images/articles.jpg',
    blocks: [],
  };
  const form = render(schema, page);
  equal(extractFormData(form, schema), page);
});

// --- Integers read back as numbers --------------------------------------------
// z.number().int() is JSON Schema `integer`. Rendered as anything but
// type="number" it reads back as the string "2" and fails validation.

const INT = { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 };

check('integer fields (plain, default, nullable, nested, array) read back as numbers', () => {
  const schema = {
    type: 'object',
    properties: {
      order: { default: 0, ...INT },
      rank: { anyOf: [INT, { type: 'null' }] },
      stats: { type: 'object', properties: { visits: INT } },
      sizes: { type: 'array', items: INT },
    },
    required: ['order', 'stats', 'sizes'],
  };
  const entry = { order: 2, rank: 7, stats: { visits: 40 }, sizes: [3, 5] };
  equal(extractFormData(render(schema, entry), schema), entry, 'positive control: unedited, every value is the stored one');
  // A bound form gives an untouched control its stored value back, so only an
  // EDIT reads the number from the DOM: that is what this pins.
  const form = render(schema, entry);
  const edits = { order: '12', rank: '-3', 'stats.visits': '41', 'sizes[1]': '6' };
  for (const [name, value] of Object.entries(edits)) form.querySelector(`[name="${name}"]`).value = value;
  equal(extractFormData(form, schema), { order: 12, rank: -3, stats: { visits: 41 }, sizes: [3, 6] });
});

check('an edited plain number (not an integer, not nullable) saves as a number', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' }, weight: { type: 'number' } }, required: ['title', 'weight'] };
  const form = render(schema, { title: '2024', weight: 1 });
  form.querySelector('[name="weight"]').value = '2.5';
  form.querySelector('[name="title"]').value = '2025';
  equal(extractFormData(form, schema), { title: '2025', weight: 2.5 }, 'the number is a number; a text field holding digits stays a string');
});

// --- Checkboxes -------------------------------------------------------------
// FormData leaves an unchecked box out entirely, so a box the editor unchecks
// is read by its own pass; without it the unchecked value is never saved.

check('unchecking a plain checkbox saves false, and checking one saves true', () => {
  const schema = {
    type: 'object',
    properties: { featured: { type: 'boolean' }, draft: { type: 'boolean' }, meta: { type: 'object', properties: { pinned: { type: 'boolean' } } } },
    required: ['featured', 'draft', 'meta'],
  };
  const entry = { featured: true, draft: false, meta: { pinned: true } };
  const form = render(schema, entry);
  equal(form.querySelector('[name="featured"]').type, 'checkbox', 'control: a plain boolean is a checkbox');
  form.querySelector('[name="featured"]').checked = false;
  form.querySelector('[name="draft"]').checked = true;
  form.querySelector('[name="meta.pinned"]').checked = false;
  equal(extractFormData(form, schema), { featured: false, draft: true, meta: { pinned: false } });
});

// --- A cleared number is absent, never "" (#61) --------------------------------
// An empty number input has no number to save. "" fails every z.number(), so
// a cleared (non-nullable) number is left out, at the top level and inside a
// block alike; a nullable one saves null (below). An untouched one keeps its
// stored value, whatever that is.

const numberControl = (form, name) => form.querySelector(`[name="${name}"]`);
const NOTE_WITH_COUNT = {
  type: 'object',
  properties: { type: { type: 'string', const: 'note' }, heading: { type: 'string' }, count: { type: 'number' } },
  required: ['type', 'heading'],
};
const COUNT_PAGE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    order: INT,
    weight: { type: 'number' },
    blocks: { type: 'array', blockTypes: { note: NOTE_WITH_COUNT }, items: { anyOf: [NOTE_WITH_COUNT] } },
  },
  required: ['title', 'order', 'blocks'],
};

check('a cleared required number and a cleared optional one save as absent, not "" (#61)', () => {
  const entry = { title: 'T', order: 2, weight: 1.5, blocks: [] };
  const form = render(COUNT_PAGE_SCHEMA, entry);
  numberControl(form, 'order').value = '';
  numberControl(form, 'weight').value = '';
  equal(extractFormData(form, COUNT_PAGE_SCHEMA), { title: 'T', blocks: [] });
  equal('order' in extractFields(form), false, 'extractFields leaves the cleared number out too');
});

check('a cleared optional number inside a block saves as absent, not "" (#61)', () => {
  const entry = { title: 'T', order: 1, blocks: [{ type: 'note', heading: 'H', count: 3 }] };
  const form = render(COUNT_PAGE_SCHEMA, entry);
  numberControl(form, 'blocks[0].count').value = '';
  equal(extractFormData(form, COUNT_PAGE_SCHEMA), { title: 'T', order: 1, blocks: [{ type: 'note', heading: 'H' }] });
});

check('a number cleared in a block added since binding (unbound) is absent; its siblings are read', () => {
  const entry = { title: 'T', order: 1, blocks: [] };
  const form = render(COUNT_PAGE_SCHEMA, entry);
  setupFormHandlers(form, () => {});
  form.querySelector('#add-block-type').value = 'note';
  form.querySelector('.add-block-btn').click();
  numberControl(form, 'blocks[0].heading').value = 'New';
  // A new block starts its number at 0 (createEmptyBlock); clearing it is the edit.
  numberControl(form, 'blocks[0].count').value = '';
  equal(extractFormData(form, COUNT_PAGE_SCHEMA).blocks, [{ type: 'note', heading: 'New' }]);
});

check('control: an untouched number keeps its stored value, a stored "" included', () => {
  const entry = { title: 'T', order: 4, weight: '', blocks: [{ type: 'note', heading: 'H', count: '' }] };
  const form = render(COUNT_PAGE_SCHEMA, entry);
  numberControl(form, 'title').value = 'Edited';
  equal(extractFormData(form, COUNT_PAGE_SCHEMA), { ...entry, title: 'Edited' });
});

check('a date-format field reads back as the YYYY-MM-DD string the schema coerces', () => {
  const schema = { type: 'object', properties: { joined: { type: 'string', format: 'date' } }, required: ['joined'] };
  equal(extractFormData(render(schema, { joined: '2020-04-02' }), schema), { joined: '2020-04-02' });
});

// --- Nullable fields keep null ------------------------------------------------
// A nullable field renders as its non-null type, so a null used to come back
// as that type's empty value: editing only the title beside required nullable
// fields saved `rank: ''` and `enabled: false`, which z.number().nullable()
// refuses and which silently changes a boolean's meaning.

const nullableOf = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const NULLABLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    rank: nullableOf(INT),
    enabled: nullableOf({ type: 'boolean' }),
    note: nullableOf({ type: 'string' }),
    tier: nullableOf({ type: 'string', enum: ['gold', 'silver'] }),
    at: nullableOf({ type: 'string', format: 'date-time', 'x-astroadmin-date': true }),
  },
  required: ['title', 'rank', 'enabled', 'note', 'tier', 'at'],
};
const control = (form, name) => form.querySelector(`[name="${name}"]`);

check('nullable fields: an untouched null stays null when another field is edited', () => {
  const entry = { title: 'Hello', rank: null, enabled: null, note: null, tier: null, at: null };
  const form = render(NULLABLE_SCHEMA, entry);
  control(form, 'title').value = 'Edited';
  equal(extractFormData(form, NULLABLE_SCHEMA), { ...entry, title: 'Edited' });
});

check('nullable fields: a value set on a null field is saved with its type', () => {
  const entry = { title: 'Hello', rank: null, enabled: null, note: null, tier: null, at: null };
  const form = render(NULLABLE_SCHEMA, entry);
  control(form, 'rank').value = '5';
  control(form, 'enabled').value = 'false';
  control(form, 'note').value = 'A note';
  control(form, 'tier').value = 'silver';
  // `at` is a real z.date() as zod 3 serialises it (format date-time, marked):
  // with no time to keep it is a date input, and a date-only value is valid.
  equal(control(form, 'at').type, 'date', 'a z.date() with no time is a date input');
  control(form, 'at').value = '2026-07-01';
  equal(extractFormData(form, NULLABLE_SCHEMA), {
    title: 'Hello', rank: 5, enabled: false, note: 'A note', tier: 'silver', at: '2026-07-01',
  });
});

check('nullable fields: values round trip, and clearing a control saves null', () => {
  const entry = { title: 'Hello', rank: 3, enabled: true, note: 'x', tier: 'gold', at: '2026-07-01T12:30:00Z' };
  equal(extractFormData(render(NULLABLE_SCHEMA, entry), NULLABLE_SCHEMA), entry, 'positive control: unedited values');
  const form = render(NULLABLE_SCHEMA, entry);
  for (const name of ['rank', 'enabled', 'note', 'tier', 'at']) control(form, name).value = '';
  equal(extractFormData(form, NULLABLE_SCHEMA), { title: 'Hello', rank: null, enabled: null, note: null, tier: null, at: null });
});

check('nullable fields: an absent optional nullable key stays absent; a stored empty string stays one', () => {
  const schema = { ...NULLABLE_SCHEMA, required: ['title', 'note'] };
  equal(extractFormData(render(schema, { title: 'Hello', note: '' }), schema), { title: 'Hello', note: '' });
});

check('nullable boolean: false and true are kept apart from null', () => {
  const schema = { type: 'object', properties: { enabled: nullableOf({ type: 'boolean' }) }, required: ['enabled'] };
  equal(extractFormData(render(schema, { enabled: false }), schema), { enabled: false });
  equal(extractFormData(render(schema, { enabled: true }), schema), { enabled: true });
});

console.log(`\n${passed} checks passed, ${failures.length} failed, ${assertions} assertions run`);
if (failures.length > 0) process.exit(1);
