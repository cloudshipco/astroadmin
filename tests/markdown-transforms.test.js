/**
 * Markdown toolbar transforms — pure text/selection logic.
 *
 * Run: bun tests/markdown-transforms.test.js
 *
 * These back the body toolbar's buttons. They are DOM-free so the editing logic
 * is covered without a browser; the DOM layer (markdown-toolbar.js) only reads
 * the selection, calls one of these, and writes the result back.
 */

import assert from 'node:assert';
import {
  wrapInline,
  toggleLinePrefix,
  setHeading,
  toggleOrderedList,
  insertLink,
  insertImage,
  codeBlock,
} from '../ui/markdown-transforms.js';

let passed = 0;
function check(name, fn) {
  fn();
  console.log(`✅ ${name}`);
  passed++;
}

// --- wrapInline -------------------------------------------------------------
check('bold wraps the selection', () => {
  const r = wrapInline('the cat sat', 4, 7, '**'); // "cat"
  assert.strictEqual(r.value, 'the **cat** sat');
  assert.strictEqual(r.value.slice(r.selStart, r.selEnd), 'cat');
});

check('bold is idempotent (wrap then unwrap restores)', () => {
  const a = wrapInline('the cat sat', 4, 7, '**');
  const b = wrapInline(a.value, a.selStart, a.selEnd, '**'); // unwrap the now-wrapped selection
  assert.strictEqual(b.value, 'the cat sat');
  assert.strictEqual(b.value.slice(b.selStart, b.selEnd), 'cat');
});

check('bold on empty selection leaves the caret between markers', () => {
  const r = wrapInline('ab', 1, 1, '**');
  assert.strictEqual(r.value, 'a****b');
  assert.strictEqual(r.selStart, 3);
  assert.strictEqual(r.selEnd, 3);
});

check('italic uses a single asterisk', () => {
  const r = wrapInline('a b c', 2, 3, '*');
  assert.strictEqual(r.value, 'a *b* c');
});

// --- toggleLinePrefix (quote, bullet) --------------------------------------
check('quote prefixes every selected line and toggles off', () => {
  const src = 'one\ntwo';
  const on = toggleLinePrefix(src, 0, src.length, '> ');
  assert.strictEqual(on.value, '> one\n> two');
  const off = toggleLinePrefix(on.value, 0, on.value.length, '> ');
  assert.strictEqual(off.value, 'one\ntwo');
});

check('bullet skips blank lines', () => {
  const r = toggleLinePrefix('a\n\nb', 0, 4, '- ');
  assert.strictEqual(r.value, '- a\n\n- b');
});

// --- setHeading -------------------------------------------------------------
check('H2 adds "## " and re-clicking clears it', () => {
  const on = setHeading('Title', 0, 5, 2);
  assert.strictEqual(on.value, '## Title');
  const off = setHeading(on.value, 0, on.value.length, 2);
  assert.strictEqual(off.value, 'Title');
});

check('H3 replaces an existing H2 rather than stacking', () => {
  const r = setHeading('## Title', 0, 8, 3);
  assert.strictEqual(r.value, '### Title');
});

// --- toggleOrderedList ------------------------------------------------------
check('ordered list numbers from 1 and toggles off', () => {
  const src = 'a\nb\nc';
  const on = toggleOrderedList(src, 0, src.length);
  assert.strictEqual(on.value, '1. a\n2. b\n3. c');
  const off = toggleOrderedList(on.value, 0, on.value.length);
  assert.strictEqual(off.value, 'a\nb\nc');
});

// --- insertLink -------------------------------------------------------------
check('link uses the selection as the label, caret in the parens', () => {
  const r = insertLink('see docs here', 4, 8); // "docs"
  assert.strictEqual(r.value, 'see [docs]() here');
  assert.strictEqual(r.selStart, r.selEnd); // collapsed caret
  assert.strictEqual(r.value[r.selStart - 1], '('); // caret sits just inside the parens
  assert.strictEqual(r.value[r.selStart], ')');
});

check('link with a url selects the label for editing', () => {
  const r = insertLink('', 0, 0, 'https://x.com');
  assert.strictEqual(r.value, '[link text](https://x.com)');
  assert.strictEqual(r.value.slice(r.selStart, r.selEnd), 'link text');
});

// --- insertImage ------------------------------------------------------------
check('image inserts ![alt](url) and selects the alt placeholder', () => {
  const r = insertImage('before after', 6, 6, '/images/x.jpg');
  assert.strictEqual(r.value, 'before![alt](/images/x.jpg) after');
  assert.strictEqual(r.value.slice(r.selStart, r.selEnd), 'alt');
});

check('image with alt supplied places the caret after the snippet', () => {
  const r = insertImage('', 0, 0, '/images/x.jpg', 'A shoot');
  assert.strictEqual(r.value, '![A shoot](/images/x.jpg)');
  assert.strictEqual(r.selStart, r.value.length);
});

// --- codeBlock ---
check('code block fences the selection', () => {
  const r = codeBlock('a\nx\nb', 2, 3); // "x"
  assert.strictEqual(r.value, 'a\n```\nx\n```\nb');
  assert.strictEqual(r.value.slice(r.selStart, r.selEnd), 'x');
});

check('inline code uses a backtick via wrapInline', () => {
  const r = wrapInline('run cmd now', 4, 7, '`');
  assert.strictEqual(r.value, 'run `cmd` now');
});

// --- regression: Codex review edge cases ------------------------------------

check('italic on bold text combines rather than downgrading bold', () => {
  // Selecting "cat" inside **cat** and pressing italic must not strip the bold.
  const r = wrapInline('**cat**', 2, 5, '*');
  assert.strictEqual(r.value, '***cat***');
  assert.strictEqual(r.value.slice(r.selStart, r.selEnd), 'cat');
});

check('italic still toggles off a genuine single-asterisk wrap', () => {
  const r = wrapInline('*b*', 1, 2, '*');
  assert.strictEqual(r.value, 'b');
});

check('a selection ending at a line start does not format the next line', () => {
  // "one\n" selected [0,4] from "one\ntwo\nthree" — only "one" gets the heading.
  const r = setHeading('one\ntwo\nthree', 0, 4, 2);
  assert.strictEqual(r.value, '## one\ntwo\nthree');
});

check('heading applies to an empty body and leaves the caret after the marker', () => {
  const r = setHeading('', 0, 0, 2);
  assert.strictEqual(r.value, '## ');
  assert.strictEqual(r.selStart, 3);
  assert.strictEqual(r.selEnd, 3);
});

check('bullet applies to a sole blank line', () => {
  const r = toggleLinePrefix('', 0, 0, '- ');
  assert.strictEqual(r.value, '- ');
  assert.strictEqual(r.selStart, r.selEnd);
});

check('ordered list applies to an empty body', () => {
  const r = toggleOrderedList('', 0, 0);
  assert.strictEqual(r.value, '1. ');
});

check('ordered list does not double-number an already-numbered line', () => {
  const src = '1. one\ntwo';
  const r = toggleOrderedList(src, 0, src.length);
  assert.strictEqual(r.value, '1. one\n2. two');
});

check('bullet does not double-prefix an already-bulleted line in a mixed selection', () => {
  const r = toggleLinePrefix('- one\ntwo', 0, 9, '- ');
  assert.strictEqual(r.value, '- one\n- two');
});

check('code block on a mid-line selection fences the whole line', () => {
  // Fence markers must sit on their own lines, so a mid-line selection is
  // widened to the line rather than producing `hello ```\nworld\n```!`.
  const r = codeBlock('hello world!', 6, 11); // "world"
  assert.strictEqual(r.value, '```\nhello world!\n```');
  assert.strictEqual(r.value.slice(r.selStart, r.selEnd), 'hello world!');
});

check('code block does not leave a blank line when the selection ends at a newline', () => {
  const r = codeBlock('a\nb', 0, 2); // "a\n"
  assert.strictEqual(r.value, '```\na\n```\nb');
});

check('code block toggles off when the lines are already fenced', () => {
  const r = codeBlock('a\n```\nx\n```\nb', 6, 7); // the "x" line inside the fence
  assert.strictEqual(r.value, 'a\nx\nb');
});

check('italic on bold+italic removes only the italic layer', () => {
  const r = wrapInline('***cat***', 3, 6, '*');
  assert.strictEqual(r.value, '**cat**');
  assert.strictEqual(r.value.slice(r.selStart, r.selEnd), 'cat');
});

check('italic over a whole **bold** selection adds italic, not removes bold', () => {
  const r = wrapInline('**cat**', 0, 7, '*'); // selection includes the ** markers
  assert.strictEqual(r.value, '***cat***');
});

check('italic over a whole *italic* selection removes it', () => {
  const r = wrapInline('*cat*', 0, 5, '*');
  assert.strictEqual(r.value, 'cat');
});

check('code block toggles off a whole-block selection', () => {
  const r = codeBlock('```\na\n```', 0, 9); // the entire fenced block
  assert.strictEqual(r.value, 'a');
});

check('code block toggle-off handles CRLF fences without an orphan CR', () => {
  const r = codeBlock('```\r\nx\r\n```', 5, 6); // caret on the "x" line
  assert.strictEqual(r.value, 'x');
});

check('code block toggles off from a caret in the middle of a multi-line block', () => {
  const r = codeBlock('a\n```\nx\ny\n```\nb', 8, 9); // caret on "y"
  assert.strictEqual(r.value, 'a\nx\ny\nb');
  assert.strictEqual(r.value.slice(r.selStart, r.selEnd), 'x\ny');
});

check('CRLF unfence does not strip an unrelated trailing carriage return', () => {
  // The orphan-CR cleanup must only touch a fence that was at EOF, not `tail`.
  const r = codeBlock('```\r\nx\r\n```\r\ntail\r', 5, 6); // caret on "x"
  assert.strictEqual(r.value, 'x\r\ntail\r');
  assert.strictEqual(r.value.slice(r.selStart, r.selEnd), 'x');
});

check('inline code toggles off a genuine single-backtick span (no parity)', () => {
  const r = wrapInline('`cat`', 1, 4, '`');
  assert.strictEqual(r.value, 'cat');
});

check('bullet treats a CRLF blank line as blank (does not prefix it)', () => {
  const src = 'a\r\n\r\nb';
  const r = toggleLinePrefix(src, 0, src.length, '- ');
  assert.strictEqual(r.value, '- a\r\n\r\n- b');
});

check('heading treats a whitespace-only line as blank in a mixed selection', () => {
  const src = 'a\n   \nb';
  const r = setHeading(src, 0, src.length, 2);
  assert.strictEqual(r.value, '## a\n   \n## b');
});

console.log(`\n${passed} passed`);
