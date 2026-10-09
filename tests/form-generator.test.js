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

// Every check runs even after one fails, so a red run names every broken case.
let passed = 0;
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
  // (A non-const `id` renders as a one-line input; most other plain strings
  // are autogrow textareas, which is why a const rendered through the default
  // path was a large box.)
  const html = generateForm(
    { type: 'object', properties: { id: { type: 'string' } } },
    { id: 'home' },
  );
  const control = html.match(/<textarea[^>]*name="id"[^>]*>/s) || html.match(/<input[^>]*name="id"[^>]*>/s);
  assert.ok(control, 'plain string field still renders an editable control');
  assert.ok(!/\breadonly\b/.test(control[0]), 'a field without const must remain editable');
});

// --- Integers (z.number().int() is JSON Schema `integer`) --------------------
// There was no integer case, so an integer fell through to the textarea branch,
// whose `content.match` threw on a number and broke the whole entry.

/** The <input> (or textarea/select) element rendered for `name`, or null. */
function controlFor(html, name) {
  const escaped = name.replace(/[[\]]/g, '\\$&');
  return html.match(new RegExp(`<(input|textarea|select)\\b[^>]*name="${escaped}"[^>]*>`, 's'))?.[0] ?? null;
}
function assertIntegerInput(html, name, value) {
  const control = controlFor(html, name);
  assert.ok(control, `no control rendered for ${name}`);
  assert.ok(/^<input\b/.test(control) && /type="number"/.test(control), `${name} must be <input type="number">: ${control}`);
  assert.ok(/step="1"/.test(control), `${name} must have step="1": ${control}`);
  if (value !== undefined) assert.ok(control.includes(`value="${value}"`), `${name} must show ${value}: ${control}`);
}
const INT = { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 };

check('an integer field renders a number input with step 1', () => {
  assertIntegerInput(generateForm({ type: 'object', properties: { order: INT } }, { order: 2 }), 'order', 2);
});

check('a default-wrapped integer renders a number input', () => {
  const html = generateForm({ type: 'object', properties: { order: { default: 0, ...INT } } }, {});
  assertIntegerInput(html, 'order', 0);
});

check('a nullable (anyOf with null) optional integer renders a number input', () => {
  const html = generateForm({ type: 'object', properties: { rank: { anyOf: [INT, { type: 'null' }] } } }, { rank: 7 });
  assertIntegerInput(html, 'rank', 7);
});

check('an integer inside a nested object renders a number input', () => {
  const html = generateForm(
    { type: 'object', properties: { stats: { type: 'object', properties: { visits: INT } } } },
    { stats: { visits: 40 } },
  );
  assertIntegerInput(html, 'stats.visits', 40);
});

check('an array of integers renders number inputs with step 1', () => {
  const html = generateForm({ type: 'object', properties: { sizes: { type: 'array', items: INT } } }, { sizes: [3, 5] });
  assertIntegerInput(html, 'sizes[0]', 3);
  assertIntegerInput(html, 'sizes[1]', 5);
});

check('an integer inside a block renders a number input', () => {
  const html = generateForm(
    { type: 'object', properties: { blocks: { type: 'array', blockTypes: {
      grid: { type: 'object', properties: { type: { type: 'string', const: 'grid' }, columns: INT } },
    } } } },
    { blocks: [{ type: 'grid', columns: 3 }] },
  );
  const control = html.match(/<input\b[^>]*name="blocks\[0\]\.columns"[^>]*>/s)?.[0];
  assert.ok(control, 'no control for blocks[0].columns');
  assert.ok(/type="number"/.test(control) && /step="1"/.test(control), control);
});

check('an integer in the array item modal (generateFields) renders a number input', () => {
  const html = generateFields({ name: { type: 'string' }, years: INT }, { name: 'A', years: 8 }, { idPrefix: 'modal-' });
  assertIntegerInput(html, 'years', 8);
});

check('a plain number keeps step="any" so decimals stay valid', () => {
  const control = controlFor(generateForm({ type: 'object', properties: { price: { type: 'number' } } }, { price: 4.5 }), 'price');
  assert.ok(/type="number"/.test(control) && /step="any"/.test(control), control);
});

// --- No value of an unexpected type can crash an entry -----------------------

check('a textarea field given a non-string value renders it as text instead of throwing', () => {
  for (const [value, shown] of [[42, '42'], [true, 'true'], [{ a: 1 }, '{&quot;a&quot;:1}'], [[1, 2], '[1,2]']]) {
    const html = generateForm({ type: 'object', properties: { summary: { type: 'string' } } }, { summary: value });
    assert.ok(/<textarea[^>]*name="summary"[^>]*>/.test(html), 'still a textarea');
    assert.ok(html.includes(`>${shown}</textarea>`), `expected ${shown} in ${html}`);
  }
});

check('a field the parser could not type ({}) with a number value renders instead of throwing', () => {
  const html = generateForm({ type: 'object', properties: { extra: {} } }, { extra: 12 });
  assert.ok(html.includes('>12</textarea>'), html);
});

// --- Dates --------------------------------------------------------------------

check('a date-format field renders a date input whatever its name', () => {
  const control = controlFor(generateForm(
    { type: 'object', properties: { joined: { type: 'string', format: 'date' } } },
    { joined: '2020-04-02' },
  ), 'joined');
  assert.ok(/type="date"/.test(control) && /value="2020-04-02"/.test(control), control);
});

check('a nullable date renders a date input', () => {
  const control = controlFor(generateForm(
    { type: 'object', properties: { joined: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] } } },
    { joined: '2020-04-02' },
  ), 'joined');
  assert.ok(/type="date"/.test(control), control);
});

// --- Short one-line strings are inputs, long ones stay textareas --------------

const ADDED_SHORT_NAMES = ['role', 'position', 'company', 'organisation', 'organization', 'location', 'city',
  'country', 'email', 'phone', 'website', 'slug', 'author', 'tag', 'category'];

check('common one-line string names render as a text input', () => {
  for (const name of [...ADDED_SHORT_NAMES, 'jobRole', 'contactEmail', 'firstName', 'jobTitle']) {
    const control = controlFor(generateForm({ type: 'object', properties: { [name]: { type: 'string' } } }, { [name]: 'x' }), name);
    assert.ok(control && /^<input\b/.test(control), `${name} should be an input: ${control}`);
  }
});

check('an email or URL format is a one-line input whatever its name', () => {
  const html = generateForm(
    { type: 'object', properties: { contact: { type: 'string', format: 'email' }, homepage: { type: 'string', format: 'uri' } } },
    { contact: 'a@example.com', homepage: 'https://example.com/' },
  );
  assert.ok(/type="email"/.test(controlFor(html, 'contact')), controlFor(html, 'contact'));
  assert.ok(/type="url"/.test(controlFor(html, 'homepage')), controlFor(html, 'homepage'));
});

check('other strings keep the textarea default', () => {
  for (const name of ['bio', 'summary', 'body', 'excerpt', 'description', 'content', 'notes']) {
    const control = controlFor(generateForm({ type: 'object', properties: { [name]: { type: 'string' } } }, { [name]: 'x' }), name);
    assert.ok(control && /^<textarea\b/.test(control), `${name} should stay a textarea: ${control}`);
  }
});

check(".describe('textarea') still forces a textarea on a short-named field", () => {
  const control = controlFor(generateForm(
    { type: 'object', properties: { role: { type: 'string', description: 'textarea' } } },
    { role: 'x' },
  ), 'role');
  assert.ok(control && /^<textarea\b/.test(control), control);
});

check('an image() field gets the picker whatever its name', () => {
  // image() reaches the editor as the bundled stand-in z.string().describe('Image path'),
  // so a field named `cover` (no image-like name) must be recognised by that description.
  const html = generateFields({ cover: { type: 'string', description: 'Image path' } }, { cover: '/a.jpg' });
  assert.ok(/class="image-picker"/.test(html), 'an image() field must render the picker');
});

check('a plain string with an unremarkable name is not an image field', () => {
  const html = generateFields({ cover: { type: 'string' } }, { cover: 'x' });
  assert.ok(!/class="image-picker"/.test(html), 'must not guess an image from the name cover');
});

check('a number input carries the schema bounds (JSON Schema minimum/maximum)', () => {
  const control = controlFor(generateForm(
    { type: 'object', properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } } },
    { rating: 3 },
  ), 'rating');
  assert.ok(/min="1"/.test(control) && /max="5"/.test(control), control);
});

check("zod 4's safe-integer bounds are not rendered as min/max", () => {
  const control = controlFor(generateForm(
    { type: 'object', properties: { count: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 } } },
    { count: 3 },
  ), 'count');
  assert.ok(!/\bmin="/.test(control) && !/\bmax="/.test(control), control);
});

// --- Identifiers are one-line inputs -----------------------------------------
// A file() collection's `id` rendered as a textarea.

check('an id field (id, authorId, author_id) renders as a text input', () => {
  for (const name of ['id', 'authorId', 'author_id']) {
    const control = controlFor(generateForm({ type: 'object', properties: { [name]: { type: 'string' } } }, { [name]: 'x' }), name);
    assert.ok(control && /^<input\b/.test(control), `${name} should be an input: ${control}`);
  }
});

check('a word merely ending in "id" keeps the textarea default (paid, avoid)', () => {
  for (const name of ['paid', 'avoid']) {
    const control = controlFor(generateForm({ type: 'object', properties: { [name]: { type: 'string' } } }, { [name]: 'x' }), name);
    assert.ok(control && /^<textarea\b/.test(control), `${name} should stay a textarea: ${control}`);
  }
});

// --- Site agnosticism: no built-in names ---------------------------------------
// The editor used to rename some block types (hero -> "Hero Section") and treat
// fields called `testimonials` / `pages` as references to collections of those
// names, whatever the site declared.

/** The block selector's option labels for these block types, by type. */
function blockOptionLabels(blockTypes) {
  const html = generateForm(
    { type: 'object', properties: { blocks: { type: 'array', items: {}, blockTypes } } },
    { blocks: [] },
  );
  const labels = {};
  for (const match of html.matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)) labels[match[1]] = match[2];
  return labels;
}

check('block types are humanised, not renamed from a built-in list', () => {
  const block = { type: 'object', properties: { heading: { type: 'string' } } };
  const labels = blockOptionLabels({ hero: block, featureGrid: block, stats: block, cta: block, seo: block });
  assert.deepEqual(labels, { hero: 'Hero', featureGrid: 'Feature grid', stats: 'Stats', cta: 'Cta', seo: 'Seo' });
});

check("a block schema's title names it (the site's own label)", () => {
  const labels = blockOptionLabels({
    cta: { type: 'object', title: 'Call to action', properties: { heading: { type: 'string' } } },
  });
  assert.equal(labels.cta, 'Call to action');
});

check('the block badge uses the same label', () => {
  const html = generateForm(
    { type: 'object', properties: { blocks: { type: 'array', items: {}, blockTypes: { featureGrid: { type: 'object', properties: {} } } } } },
    { blocks: [{ type: 'featureGrid' }] },
  );
  assert.ok(/class="block-type-badge[^"]*">Feature grid<\/span>/.test(html), html.match(/block-type-badge[^<]*<\/span>/)?.[0]);
});

check('a list named testimonials or pages is not a reference unless the schema says so', () => {
  for (const name of ['testimonials', 'pages', 'testimonialIds']) {
    const html = generateForm({ type: 'object', properties: { [name]: { type: 'array', items: { type: 'string' } } } }, { [name]: ['a'] });
    assert.ok(!html.includes('reference-field'), `${name} rendered a reference picker`);
    assert.ok(new RegExp(`name="${name}\\[0\\]"`).test(html), `control: ${name} still renders its item`);
  }
  const marked = generateForm(
    { type: 'object', properties: { pages: { type: 'array', items: { type: 'string' }, referenceCollection: 'pages' } } },
    { pages: ['a'] },
  );
  assert.ok(/class="reference-field"[^>]*data-collection="pages"/.test(marked), 'control: a marked list is a reference');
});

check('a date value with a time of day gets a datetime input, so editing it keeps the time', () => {
  // UTC, matching the serialiser, which reads a zoneless timestamp as UTC like YAML.
  const timed = controlFor(generateForm(
    { type: 'object', properties: { publishDate: { type: 'string', format: 'date' } } },
    { publishDate: '2026-01-15T10:30:00.000Z' },
  ), 'publishDate');
  assert.ok(/type="datetime-local"/.test(timed), timed);
  assert.ok(/value="2026-01-15T10:30"/.test(timed), timed);
  const withSeconds = controlFor(generateForm(
    { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } },
    { at: '2026-01-15T10:30:45.000Z' },
  ), 'at');
  assert.ok(/value="2026-01-15T10:30:45"/.test(withSeconds) && /step="1"/.test(withSeconds), withSeconds);
  const midnight = controlFor(generateForm(
    { type: 'object', properties: { publishDate: { type: 'string', format: 'date' } } },
    { publishDate: '2026-01-15T00:00:00.000Z' },
  ), 'publishDate');
  assert.ok(/type="date"/.test(midnight) && /value="2026-01-15"/.test(midnight), midnight);
});

console.log('\n========================================\n');
console.log(`📊 ${passed} checks passed, ${failures.length} failed.`);
if (failures.length > 0) process.exit(1);

