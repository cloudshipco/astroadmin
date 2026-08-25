/**
 * Form generator — field rendering
 *
 * Run: bun tests/form-generator.test.js
 *
 * generateField is the single renderer behind the main editor form, block bodies
 * and the array item modal, so a rendering bug here surfaces in all three. These
 * cover the contracts that are easy to break silently: the input type has to
 * carry the schema type (extractFields reads the element, not the schema, to
 * decide what parses as a number), and an image field must not emit an alt input
 * whose name collides with an alt property the schema already declares.
 */

import assert from 'node:assert';
import { generateForm, generateFields, cleanEmptyValues } from '../ui/form-generator.js';

let passed = 0;
function check(name, fn) {
  fn();
  console.log(`✅ ${name}`);
  passed++;
}

// --- Input type carries the schema type ------------------------------------
// extractFields coerces a value to a number only when the element is
// type="number". Any number field rendered into a text box would save as a
// string and fail schema validation.

check('array of numbers renders number inputs, not text', () => {
  const html = generateForm(
    { type: 'object', properties: { ratings: { type: 'array', items: { type: 'number' } } } },
    { ratings: [4, 5] },
  );
  const itemInputs = html.match(/class="array-item-input[^"]*"/g) || [];
  assert.equal(itemInputs.length, 2, 'expected one input per item');
  assert.ok(/type="number"[^>]*name="ratings\[0\]"|name="ratings\[0\]"[^>]*type="number"/s.test(html)
    || /<input\s+type="number"\s+name="ratings\[0\]"/s.test(html),
    'number array item must render type="number"');
  assert.ok(!/<input\s+type="text"\s+name="ratings\[0\]"/s.test(html),
    'number array item must not render type="text"');
});

check('array of strings still renders text inputs', () => {
  const html = generateForm(
    { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } },
    { tags: ['oak'] },
  );
  assert.ok(/<input\s+type="text"\s+name="tags\[0\]"/s.test(html), 'string array item stays type="text"');
});

check('a number field renders a number input', () => {
  const html = generateForm({ type: 'object', properties: { columns: { type: 'number' } } }, { columns: 3 });
  assert.ok(/type="number"/.test(html) && /name="columns"/.test(html));
});

check('hidden fields JSON-encode their value so types survive the round trip', () => {
  const html = generateForm(
    { type: 'object', properties: { order: { type: 'number', hidden: true }, live: { type: 'boolean', hidden: true } } },
    { order: 7, live: true },
  );
  // data-json makes extractFields JSON.parse the value back to a number/boolean.
  // Without it a hidden input has no type to read and both come back as strings.
  assert.ok(/name="order"[^>]*data-json="true"/.test(html), 'hidden number must carry data-json');
  assert.ok(/name="live"[^>]*data-json="true"/.test(html), 'hidden boolean must carry data-json');
});

// --- Image field alt handling ----------------------------------------------
// The picker offers a built-in alt input named `<field>Alt`. If the schema
// declares that property too, both render and two inputs share a name — last
// one wins, silently.

check('image picker suppresses its built-in alt when the schema declares one', () => {
  const html = generateFields(
    { image: { type: 'string' }, imageAlt: { type: 'string' } },
    { image: '/a.jpg', imageAlt: 'An oak frame' },
  );
  const named = html.match(/name="imageAlt"/g) || [];
  assert.equal(named.length, 1, 'exactly one input may be named imageAlt');
  assert.ok(!/data-alt-input/.test(html), 'built-in alt input must stand down');
  assert.ok(/An oak frame/.test(html), 'the declared alt field keeps its value');
});

check('image picker keeps its built-in alt when the schema declares none', () => {
  const html = generateFields({ ogImage: { type: 'string' } }, { ogImage: '/og.jpg' });
  assert.ok(/data-alt-input/.test(html), 'no alt property in schema, so the picker supplies one');
  assert.equal((html.match(/name="ogImageAlt"/g) || []).length, 1);
});

check('gallery item {src, alt} suppresses the built-in alt too', () => {
  const html = generateFields({ src: { type: 'string' }, alt: { type: 'string' } }, { src: '/a.jpg', alt: 'A' });
  assert.ok(!/data-alt-input/.test(html), 'explicit alt property wins over the built-in');
  assert.equal((html.match(/name="srcAlt"/g) || []).length, 0, 'must not invent a srcAlt field');
});

check('{image, alt} suppresses the built-in alt — a plain alt counts for any image field', () => {
  const html = generateFields({ image: { type: 'string' }, alt: { type: 'string' } }, { image: '/a.jpg', alt: 'A' });
  assert.ok(!/data-alt-input/.test(html), 'the declared alt field wins over the built-in');
  assert.equal((html.match(/name="imageAlt"/g) || []).length, 0, 'must not invent an imageAlt the schema never declared');
});

check('an image field renders a picker, not a raw text input', () => {
  // The original bug: services[].image showed as a bare text box in the item modal.
  const html = generateFields(
    { title: { type: 'string' }, image: { type: 'string' }, imageAlt: { type: 'string' } },
    { title: 'Timber Framing', image: '/images/timber.jpg' },
  );
  assert.ok(/class="image-picker"/.test(html), 'image field must render the picker');
  assert.ok(/data-browse/.test(html) && /data-upload/.test(html), 'picker must offer browse + upload');
  assert.ok(!/<input\s+type="text"\s+name="image"/s.test(html), 'image must not be a raw text input');
});

// --- Image preview visibility -----------------------------------------------
// The preview shows a thumbnail for a real image and the "No image selected"
// state for a placeholder marker. A bare filename IS a real image (the library
// stores them, resolveImageUrl serves them from /images/), so it must preview.

/** The class list on the preview / placeholder divs, so we can assert visibility. */
function previewHidden(html) {
  return /class="image-picker-preview hidden"/.test(html);
}

check('a bare-filename value previews (library image), not the empty state', () => {
  const html = generateFields({ image: { type: 'string' } }, { image: 'hero.jpg' });
  assert.ok(!previewHidden(html), 'bare-filename image must show its thumbnail');
});

check('a placeholder marker shows the empty state, not a broken thumbnail', () => {
  const html = generateFields({ image: { type: 'string' } }, { image: 'placeholder:banner' });
  assert.ok(previewHidden(html), 'a placeholder: value must not load as an <img>');
});

check('an uppercase PLACEHOLDER marker is also treated as empty', () => {
  const html = generateFields({ image: { type: 'string' } }, { image: 'PLACEHOLDER:banner' });
  assert.ok(previewHidden(html), 'placeholder detection must be case-insensitive');
});

// --- Modal ids --------------------------------------------------------------

check('idPrefix keeps modal field ids off the form behind it', () => {
  const html = generateFields({ image: { type: 'string' } }, { image: '/a.jpg' }, { idPrefix: 'item_' });
  assert.ok(/id="item_image"/.test(html), 'id is prefixed');
  assert.ok(/name="image"/.test(html), 'name is NOT prefixed — it is the data key');
});

// --- JSON in attributes -----------------------------------------------------
// Object arrays ride in a hidden input's value attribute. Interpolating raw
// JSON there is a data-loss bug: an apostrophe ends the attribute early, the
// value comes back truncated, JSON.parse throws, and extractFields substitutes
// [] — silently wiping the whole array on save.

/** Decode an attribute value the way the HTML parser would */
function decodeAttr(value) {
  return value
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const OBJECT_ARRAY_SCHEMA = {
  type: 'object',
  properties: { people: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } } } } },
};

for (const hostile of ["O'Brien", 'He said "hi"', 'Tom & Jerry', `'><img src=x onerror=alert(1)>`, '&quot;already encoded&quot;']) {
  check(`object array survives a name containing ${JSON.stringify(hostile)}`, () => {
    const html = generateForm(OBJECT_ARRAY_SCHEMA, { people: [{ name: hostile, role: 'Builder' }] });
    const attr = html.match(/name="people" data-array-data value="([^"]*)"/);
    assert.ok(attr, 'the array must serialise into the hidden input');

    const parsed = JSON.parse(decodeAttr(attr[1]));
    assert.equal(parsed.length, 1, 'the array must not be truncated or emptied');
    assert.equal(parsed[0].name, hostile, 'the value must round-trip byte for byte');
  });
}

// --- Primitive arrays carry their type --------------------------------------

check('array of booleans renders checkboxes, not text inputs', () => {
  const html = generateForm(
    { type: 'object', properties: { flags: { type: 'array', items: { type: 'boolean' } } } },
    { flags: [true, false] },
  );
  // A boolean in a text box comes back as the string "true" and fails validation.
  assert.ok(!/<input\s+type="text"\s+name="flags\[0\]"/s.test(html), 'must not be a text input');
  assert.ok(/type="checkbox"[^>]*name="flags\[0\]"/s.test(html), 'must be a checkbox');
  assert.ok(/name="flags\[0\]"[^>]*checked/s.test(html), 'true must render checked');
  assert.ok(!/name="flags\[1\]"[^>]*checked/s.test(html), 'false must render unchecked');
});

// --- Alt text across multiple images ----------------------------------------

check('two image fields sharing one plain alt each keep their own alt input', () => {
  const html = generateFields(
    { heroImage: { type: 'string' }, cardImage: { type: 'string' }, alt: { type: 'string' } },
    { heroImage: '/a.jpg', cardImage: '/b.jpg', alt: 'shared' },
  );
  // One `alt` cannot describe two images, so neither may claim it — otherwise both
  // suppress their built-in input and distinct alt text becomes impossible to enter.
  assert.equal((html.match(/data-alt-input/g) || []).length, 2, 'each image keeps its own alt input');
  assert.ok(/name="heroImageAlt"/.test(html) && /name="cardImageAlt"/.test(html));
});


// --- Escaping of content that reaches innerHTML ------------------------------
// The form is built with template literals and inserted via innerHTML, so any
// content value interpolated unescaped executes in the admin origin.

const XSS = '<img src=x onerror=alert(1)>';

check('a block heading cannot inject markup through the block preview', () => {
  const html = generateForm(
    { type: 'object', properties: { blocks: { type: 'array', blockTypes: { hero: { properties: { type: {}, heading: { type: 'string' } } } } } } },
    { blocks: [{ type: 'hero', heading: `</span>${XSS}` }] },
  );
  assert.ok(!html.includes(XSS), 'the heading must be escaped in the preview');
});

check('an unknown block type cannot inject markup', () => {
  const html = generateForm(
    { type: 'object', properties: { blocks: { type: 'array', blockTypes: { hero: { properties: {} } } } } },
    { blocks: [{ type: XSS }] },
  );
  assert.ok(!html.includes(XSS), 'the block type must be escaped');
});

check('enum option values cannot inject markup', () => {
  const html = generateForm({ type: 'object', properties: { x: { enum: [XSS] } } }, {});
  assert.ok(!html.includes(XSS), 'enum options must be escaped');
});

check('a colour value cannot break out of the swatch attribute', () => {
  const html = generateForm({ type: 'object', properties: { bgColor: { type: 'string' } } }, { bgColor: '#" onfocus=alert(1) x="' });
  // The payload's own text may appear escaped inside the value — that is inert. What
  // must not happen is a literal " ending the attribute and starting a new one, which
  // is what turns the rest of the value into live markup.
  assert.ok(!/value="[^"]*" onfocus=/.test(html), 'the colour value must not close its attribute and inject a handler');
  assert.ok(/&quot;/.test(html), 'the quote in the value must be escaped, not dropped');
});

// --- cleanEmptyValues (issue #32: don't delete required fields) -------------
// An empty REQUIRED field must survive a save. Deleting it is silent data loss:
// it breaks the schema/build, and if the whole form is momentarily empty it
// wipes the entry's metadata entirely (observed corrupting a page's title/slug).

// The schema node: `properties` marks fields known, `required` lists required keys.
const pageSchema = {
  properties: { title: {}, slug: {}, blocks: {}, navLabel: {}, standfirst: {} },
  required: ['title', 'slug', 'blocks'],
};

check('cleanEmptyValues drops empty OPTIONAL top-level fields', () => {
  const data = { title: 'Home', navLabel: '', standfirst: '' };
  cleanEmptyValues(data, pageSchema);
  assert.deepEqual(data, { title: 'Home' }, 'empty optionals are omitted');
});

check('cleanEmptyValues KEEPS empty REQUIRED top-level fields (as "")', () => {
  const data = { title: '', slug: '', blocks: [], navLabel: '' };
  cleanEmptyValues(data, pageSchema);
  assert.ok('title' in data && data.title === '', 'required title kept as ""');
  assert.ok('slug' in data && data.slug === '', 'required slug kept as ""');
  assert.ok(!('navLabel' in data), 'optional navLabel dropped');
});

check('cleanEmptyValues KEEPS a required field inside a NESTED object', () => {
  const schema = {
    properties: { seo: { properties: { title: {}, description: {} }, required: ['title'] } },
    required: ['seo'],
  };
  const data = { seo: { title: '', description: '' } };
  cleanEmptyValues(data, schema);
  assert.ok(data.seo && data.seo.title === '', 'required nested title kept');
  assert.ok(!('description' in data.seo), 'optional nested description dropped');
  assert.ok('seo' in data, 'a required object is not deleted when emptied of optionals');
});

check('cleanEmptyValues keeps required fields in a non-block object-array item', () => {
  const schema = {
    properties: {
      authors: { items: { properties: { name: {}, bio: {} }, required: ['name'] } },
    },
    required: ['authors'],
  };
  const data = { authors: [{ name: '', bio: '' }] };
  cleanEmptyValues(data, schema);
  assert.strictEqual(data.authors[0].name, '', 'required array-item field kept');
  assert.ok(!('bio' in data.authors[0]), 'optional array-item field dropped');
});

check('cleanEmptyValues fails SAFE without a schema (keeps empties, never data loss)', () => {
  const data = { a: '', b: 'x' };
  cleanEmptyValues(data); // no schema
  assert.deepEqual(data, { a: '', b: 'x' }, 'no schema -> nothing deleted');
});

check('cleanEmptyValues keeps block-item empties BECAUSE of blockTypes', () => {
  // The items schema WOULD clean `kicker` (optional) if the item weren't a block,
  // so this proves `blockTypes` — not fail-safe — is what preserves the empty.
  const schema = {
    properties: {
      blocks: {
        blockTypes: {},
        items: { properties: { type: {}, text: {}, kicker: {} }, required: ['type', 'text'] },
      },
    },
    required: ['blocks'],
  };
  const data = { blocks: [{ type: 'heading', text: 'Hi', kicker: '' }] };
  cleanEmptyValues(data, schema);
  assert.strictEqual(data.blocks[0].kicker, '', 'block item empties are preserved');
  // Sanity: the SAME item, in a non-block array (no blockTypes), IS cleaned.
  const plain = { rows: [{ type: 'heading', text: 'Hi', kicker: '' }] };
  cleanEmptyValues(plain, {
    properties: { rows: { items: { properties: { type: {}, text: {}, kicker: {} }, required: ['type', 'text'] } } },
    required: ['rows'],
  });
  assert.ok(!('kicker' in plain.rows[0]), 'without blockTypes, the optional empty is dropped');
});

check('cleanEmptyValues does NOT treat a typed non-block record as a block', () => {
  // A plain object-array whose items happen to have a `type` field must still get
  // schema-aware cleanup (drop optional empties) rather than being read as blocks.
  const schema = {
    properties: {
      links: { items: { properties: { type: {}, label: {} }, required: ['type'] } },
    },
    required: ['links'],
  };
  const data = { links: [{ type: 'external', label: '' }] };
  cleanEmptyValues(data, schema);
  assert.strictEqual(data.links[0].type, 'external', 'required kept');
  assert.ok(!('label' in data.links[0]), 'optional empty dropped (not treated as a block)');
});

check('cleanEmptyValues cleans a TOP-LEVEL array against its schema', () => {
  const schema = { items: { properties: { name: {}, note: {} }, required: ['name'] } };
  const data = [{ name: '', note: '' }];
  cleanEmptyValues(data, schema);
  assert.strictEqual(data[0].name, '', 'required kept');
  assert.ok(!('note' in data[0]), 'optional empty dropped');
});

// --- const (z.literal) is fixed by the schema -------------------------------
// A single-entry file() collection identifies its entry by `id`, so an editable
// id lets someone rename it to something nothing can find — the site's next
// build then fails on a missing entry.

check('a const field renders nothing visible', () => {
  const html = generateForm(
    { type: 'object', properties: { id: { type: 'string', const: 'home' }, headline: { type: 'string' } } },
    { id: 'home', headline: 'Hello' },
  );
  const idInput = html.match(/<input[^>]*name="id"[^>]*>/s);
  assert.ok(idInput, 'the field must still exist in the DOM');
  assert.ok(/type="hidden"/.test(idInput[0]), 'a const must be a hidden input');
  assert.ok(/value="home"/.test(idInput[0]), 'it carries its fixed value');
  // Nothing visible: no label, no help text, no form-group wrapper of its own.
  assert.ok(!/<label[^>]*for="id"/s.test(html), 'a const must not render a label');
  assert.ok(!/not editable/i.test(html), 'a const must not explain itself to the editor');
  assert.ok(!/<textarea[^>]*name="id"/s.test(html), 'and certainly not a textarea');
});

check('a const value survives a form round-trip', () => {
  // The reason it stays in the DOM at all. extractFields reads submitted values
  // via FormData, which includes hidden inputs but would simply not see a field
  // that was omitted — dropping `id` and orphaning a single-entry collection.
  const html = generateForm(
    { type: 'object', properties: { id: { type: 'string', const: 'home' }, headline: { type: 'string' } } },
    { id: 'home', headline: 'Hello' },
  );
  const idInput = html.match(/<input[^>]*name="id"[^>]*>/s)[0];
  assert.ok(!/\bdisabled\b/.test(idInput),
    'must not be disabled — FormData omits disabled controls, silently losing the key');
});

check('a non-const field of the same shape stays editable', () => {
  // Negative control: without `const` the very same property must stay editable,
  // otherwise the two checks above would pass no matter what this branch did.
  // A plain string renders as an autogrow textarea, not an input — which is
  // exactly why a const rendered through the default path was a large box.
  const html = generateForm(
    { type: 'object', properties: { id: { type: 'string' } } },
    { id: 'home' },
  );
  const control = html.match(/<textarea[^>]*name="id"[^>]*>/s) || html.match(/<input[^>]*name="id"[^>]*>/s);
  assert.ok(control, 'plain string field still renders an editable control');
  assert.ok(!/\breadonly\b/.test(control[0]), 'a field without const must remain editable');
});

console.log('\n========================================\n');
console.log(`📊 ${passed} checks passed.`);
