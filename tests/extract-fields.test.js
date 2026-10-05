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

const { generateForm, extractFields, extractFormData, setupFormHandlers } =
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

check('reference field with zero items extracts []', () => {
  const schema = { type: 'object', properties: { testimonialIds: { type: 'array', items: { type: 'string' } } } };
  const form = render(schema, { testimonialIds: [] });
  assertions++;
  assert.ok(form.querySelector('.reference-field'), 'control: rendered as a reference field');
  equal(extractFields(form).testimonialIds, []);
});

check('reference field after removing its last card extracts []', () => {
  const schema = { type: 'object', properties: { testimonialIds: { type: 'array', items: { type: 'string' } } } };
  const form = render(schema, { testimonialIds: ['t-1'] });
  equal(extractFields(form).testimonialIds, ['t-1'], 'control: populated before removal');
  form.querySelector('.reference-card').remove();
  equal(extractFields(form).testimonialIds, []);
});

check('populated reference field is unchanged', () => {
  const schema = { type: 'object', properties: { testimonialIds: { type: 'array', items: { type: 'string' } } } };
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
  const entry = { title: 'Articles page', blocks: [{ type: 'features', heading: 'Why', tags: [] }] };
  const form = render(pageSchema, entry);
  equal(extractFormData(form, pageSchema), { title: 'Articles page', blocks: [{ type: 'features', heading: 'Why' }] });
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

console.log(`\n${passed} checks passed, ${failures.length} failed, ${assertions} assertions run`);
if (failures.length > 0) process.exit(1);
