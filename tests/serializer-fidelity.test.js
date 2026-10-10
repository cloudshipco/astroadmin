/**
 * The serialisers write exactly the data and body they are given.
 *
 * Run: bun tests/serializer-fidelity.test.js
 *
 * Every output of serializeMarkdown and serializeJson, the preserving
 * candidate and every fallback alike, must parse back to the data and body it
 * was asked to write. Three ways it did not:
 *
 * - gray-matter's `matter.stringify(body, data)` PARSES the body first, so a
 *   body that itself starts with a `---` block was split: its keys moved into
 *   the frontmatter (a CRLF file always took that path), or invalid YAML in it
 *   made the save throw.
 * - a keep-chomp scalar (`text: |+`) as the last key lost its trailing blank
 *   lines: the preserving candidate trimmed them, and gray-matter's own output
 *   `.trim()`s the dumped YAML, so the fallback lost them too, unchecked.
 * - an own `__proto__` key (valid JSON and YAML data) was assigned into `{}`,
 *   which calls the prototype setter, so the key vanished from the save.
 */

import assert from 'node:assert';
import matter from 'gray-matter';
import { serializeMarkdown, serializeJson, orderLike, restoreDates, sameValue } from '../server/utils/content-format.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${String(error.stack || error.message).split('\n').join('\n   ')}`);
  }
}

/** What the store reads back from a markdown file (a fresh options object skips gray-matter's cache). */
const readBack = (text) => {
  const parsed = matter(text, {});
  return { data: parsed.data, body: parsed.content };
};

check('control: an ordinary save reads back as written', () => {
  const out = serializeMarkdown('Body\n', { title: 'B' }, '---\ntitle: A\n---\nBody\n');
  assert.equal(out, '---\ntitle: B\n---\nBody\n');
});

// --- A body that looks like frontmatter ------------------------------------------

const FRONTMATTER_LIKE_BODY = '---\nfoo: bar\n---\nEnd\n';
const ORIGINALS = {
  'a new entry': null,
  'an LF file': '---\ntitle: A\n---\nold\n',
  'a CRLF file': '---\r\ntitle: A\r\n---\r\nold\r\n',
  'a file whose frontmatter the candidate cannot follow': '---\ntitle: A\nlist: {a: 1}\n---\nold\n',
};

for (const [label, original] of Object.entries(ORIGINALS)) {
  check(`a body starting with a --- block is written verbatim: ${label}`, () => {
    const data = original && original.includes('list') ? { title: 'B', list: { a: 1 } } : { title: 'B' };
    const out = serializeMarkdown(FRONTMATTER_LIKE_BODY, data, original);
    const back = readBack(out);
    assert.deepEqual(back.data, data, out);
    assert.equal(back.body, FRONTMATTER_LIKE_BODY, out);
  });

  check(`a body starting with invalid YAML in a --- block saves: ${label}`, () => {
    const body = '---\nIntro: [not YAML\n';
    const out = serializeMarkdown(body, { title: 'B' }, original && original.includes('list') ? '---\ntitle: A\n---\nold\n' : original);
    const back = readBack(out);
    assert.deepEqual(back.data, { title: 'B' }, out);
    assert.equal(back.body, body, out);
  });
}

check('an entry with no data keeps a frontmatter-like body as body', () => {
  const out = serializeMarkdown(FRONTMATTER_LIKE_BODY, {}, null);
  const back = readBack(out);
  assert.deepEqual(back.data, {});
  assert.equal(back.body, FRONTMATTER_LIKE_BODY, out);
});

// --- Keep-chomp scalars --------------------------------------------------------

// gray-matter ends the frontmatter at "\n---", so this value is 'line\n\n'. The
// quoted, commented author line is what only the preserving candidate keeps.
const KEEP_FILE = '---\ntitle: A\nauthor: "Ann"   # kept as written\ntext: |+\n  line\n\n\n---\nbody\n';

check('control: the keep-chomp fixture holds two trailing newlines', () => {
  assert.equal(readBack(KEEP_FILE).data.text, 'line\n\n');
});

check('a final keep-chomp scalar keeps its trailing newlines when only the title changes', () => {
  const out = serializeMarkdown('body\n', { title: 'B', author: 'Ann', text: 'line\n\n' }, KEEP_FILE);
  assert.deepEqual(readBack(out).data, { title: 'B', author: 'Ann', text: 'line\n\n' }, out);
  assert.equal(out, KEEP_FILE.replace('title: A', 'title: B'), 'unchanged keys keep their text');
});

check('an edited final keep-chomp scalar keeps its trailing newlines', () => {
  const out = serializeMarkdown('body\n', { title: 'A', author: 'Ann', text: 'other\n\n\n' }, KEEP_FILE);
  assert.deepEqual(readBack(out).data, { title: 'A', author: 'Ann', text: 'other\n\n\n' }, out);
});

check('a new entry with a value ending in blank lines keeps them', () => {
  const out = serializeMarkdown('body\n', { title: 'A', text: 'line\n\n' }, null);
  assert.deepEqual(readBack(out).data, { title: 'A', text: 'line\n\n' }, out);
});

check('a CRLF file with a final keep-chomp scalar keeps it', () => {
  const crlf = KEEP_FILE.replace(/\n/g, '\r\n');
  const original = readBack(crlf).data.text;
  const out = serializeMarkdown('body\n', { title: 'B', author: 'Ann', text: original }, crlf);
  assert.deepEqual(readBack(out).data, { title: 'B', author: 'Ann', text: original }, out);
});

// --- __proto__ keys -------------------------------------------------------------

const PROTO_JSON = '{"title": "A", "__proto__": {"x": 1}}';

check('control: JSON.parse makes __proto__ an own key', () => {
  assert.deepEqual(Object.keys(JSON.parse(PROTO_JSON)), ['title', '__proto__']);
});

check('orderLike keeps an own __proto__ key, as an own key', () => {
  const ordered = orderLike(JSON.parse(PROTO_JSON), JSON.parse('{"__proto__": {"x": 2}, "title": "B"}'));
  assert.deepEqual(Object.keys(ordered), ['title', '__proto__']);
  assert.equal(Object.getPrototypeOf(ordered), Object.prototype, 'still a plain object');
  assert.equal(JSON.stringify(ordered), '{"title":"B","__proto__":{"x":2}}');
});

check('orderLike keeps a NEW own __proto__ key', () => {
  const ordered = orderLike({ title: 'A' }, JSON.parse(PROTO_JSON));
  assert.deepEqual(Object.keys(ordered), ['title', '__proto__']);
});

check('restoreDates keeps an own __proto__ key', () => {
  const restored = restoreDates(JSON.parse(PROTO_JSON), JSON.parse(PROTO_JSON));
  assert.deepEqual(Object.keys(restored), ['title', '__proto__']);
  assert.ok(sameValue(restored, JSON.parse(PROTO_JSON)));
});

check('serializeJson writes an own __proto__ key', () => {
  const out = serializeJson(orderLike(JSON.parse(PROTO_JSON), JSON.parse(PROTO_JSON)), `${PROTO_JSON}\n`);
  assert.deepEqual(Object.keys(JSON.parse(out)), ['title', '__proto__'], out);
});

check('serializeMarkdown writes an own __proto__ key, edited or not', () => {
  const original = '---\ntitle: A\n__proto__:\n  x: 1\n---\nbody\n';
  assert.deepEqual(Object.keys(readBack(original).data), ['title', '__proto__'], 'control: js-yaml reads an own key');
  for (const data of [JSON.parse('{"title":"B","__proto__":{"x":1}}'), JSON.parse('{"title":"B","__proto__":{"x":2}}')]) {
    const out = serializeMarkdown('body\n', data, original);
    const back = readBack(out).data;
    assert.deepEqual(Object.keys(back), ['title', '__proto__'], out);
    assert.deepEqual(back.__proto__, data.__proto__, out);
  }
  const fresh = serializeMarkdown('body\n', JSON.parse('{"title":"B","__proto__":{"x":1}}'), null);
  assert.deepEqual(Object.keys(readBack(fresh).data), ['title', '__proto__'], fresh);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exitCode = 1;
