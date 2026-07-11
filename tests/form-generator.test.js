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
import { generateForm, generateFields } from '../ui/form-generator.js';

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

console.log('\n========================================\n');
console.log(`📊 ${passed} checks passed.`);
