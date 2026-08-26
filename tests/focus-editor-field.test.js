/**
 * Click-to-edit (preview → editor): focusEditorField must scroll to something
 * VISIBLE. An image field's named control is an <input type="hidden"> (see
 * generateImageField), and scrollIntoView/focus on a hidden input are silent
 * no-ops — so clicking an image in the preview appeared to do nothing (site
 * report, 2026-08-26). Runs the real function from dashboard.js against a
 * minimal fake DOM so the behaviour, not the source text, is asserted.
 *
 * Run: bun tests/focus-editor-field.test.js
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(dir, '../ui/dashboard.js'), 'utf8');

const fnSrc = src.match(/function focusEditorField\(field\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(fnSrc, 'focusEditorField not found in dashboard.js');

let passed = 0;
function check(name, fn) { fn(); console.log(`✅ ${name}`); passed++; }

// Build a fake form holding one control inside a .form-group and run the
// function with globals stubbed. Returns what got scrolled / focused / flashed.
function run(controlType) {
  const calls = { scrolled: [], focused: [], flashed: [] };
  const group = {
    id: 'group',
    scrollIntoView: () => calls.scrolled.push('group'),
    closest: () => null,
  };
  const control = {
    id: 'control',
    type: controlType,
    scrollIntoView: () => calls.scrolled.push('control'),
    focus: () => calls.focused.push('control'),
    closest: (sel) => (sel === '.form-group' ? group : null),
  };
  const form = { querySelector: (sel) => (sel.includes('"heroImage"') ? control : null) };
  const fn = new Function(
    'document', 'CSS', 'flashFieldGroup',
    `${fnSrc}; return focusEditorField;`
  )(
    { getElementById: (id) => (id === 'contentForm' ? form : null) },
    { escape: (s) => s },
    (g) => calls.flashed.push(g.id),
  );
  fn('heroImage');
  return calls;
}

check('a visible control is scrolled to and focused, and its group flashed', () => {
  const c = run('text');
  assert.deepStrictEqual(c.scrolled, ['control']);
  assert.deepStrictEqual(c.focused, ['control']);
  assert.deepStrictEqual(c.flashed, ['group']);
});

check('a hidden control (image picker) scrolls to its visible group instead', () => {
  const c = run('hidden');
  assert.deepStrictEqual(c.scrolled, ['group'], 'must scroll the group — a hidden input has no box');
  assert.deepStrictEqual(c.focused, [], 'a hidden input cannot take focus');
  assert.deepStrictEqual(c.flashed, ['group']);
});

console.log(`\n${passed} passed`);
