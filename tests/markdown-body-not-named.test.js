/**
 * Guard: the markdown body textarea must NOT be a named form control.
 *
 * Run: bun tests/markdown-body-not-named.test.js
 *
 * The content body is read by id (#markdown-body) and POSTed separately as
 * `body`. If the textarea also had a form `name`, extractFormData/FormData would
 * sweep it into the frontmatter `data`, and the server's matter.stringify would
 * write a duplicate `body:` key on top of the real markdown body — corrupting
 * the file on every save (and, if a collection also declares a real `body`
 * frontmatter field, a blanket delete would drop that field). This is a
 * source-level guard because extractFields is DOM-bound and has no unit harness
 * yet (see issue #37); it fails loudly if `name="body"` is ever reintroduced.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(dir, '../ui/dashboard.js'), 'utf8');

let passed = 0;
function check(name, fn) { fn(); console.log(`✅ ${name}`); passed++; }

// Every COMPLETE <textarea ...> opening tag that mounts #markdown-body, matched
// regardless of attribute order (so `name=` placed before the id can't slip by).
const bodyTextareaTags = [...src.matchAll(/<textarea[\s\S]*?>/g)]
  .map((m) => m[0])
  .filter((tag) => tag.includes('id="markdown-body"'));

check('both render paths mount a #markdown-body textarea', () => {
  // renderEditor (existing entry) + renderEditorForNewEntry (new entry).
  assert.ok(bodyTextareaTags.length >= 2, `expected >=2 #markdown-body textareas, got ${bodyTextareaTags.length}`);
});

check('the markdown body textarea carries no form name (would leak to frontmatter)', () => {
  for (const tag of bodyTextareaTags) {
    assert.ok(
      !/\bname\s*=/.test(tag),
      'markdown body textarea must not have a form name — it would be written into the frontmatter'
    );
  }
});

check('every markdown body textarea is tagged for click-to-edit', () => {
  for (const tag of bodyTextareaTags) {
    assert.ok(
      /data-content-field="body"/.test(tag),
      'each #markdown-body textarea should carry data-content-field so click-to-edit can focus it'
    );
  }
});

check('no blanket delete of formData.body remains (the root fix replaced it)', () => {
  assert.ok(
    !/delete\s+formData\.body\b/.test(src),
    'the blanket `delete formData.body` could drop a legitimate `body` frontmatter field'
  );
});

check('the save path threads the schema into cleanEmptyValues (keeps required fields)', () => {
  const fg = readFileSync(path.join(dir, '../ui/form-generator.js'), 'utf8');
  assert.ok(
    /extractFormData\s*\(\s*formElement\s*,\s*schema\s*\)/.test(fg),
    'extractFormData must accept the schema'
  );
  assert.ok(
    /cleanEmptyValues\s*\(\s*data\s*,\s*schema\b/.test(fg),
    'extractFormData must pass the schema to cleanEmptyValues (else required fields drop)'
  );
  // The top-level-ARRAY branch must ALSO clean (it returns before the object path,
  // so a missing call there silently reinstates over-retention for array entries).
  assert.ok(
    /cleanEmptyValues\s*\(\s*arr\s*,\s*schema\b/.test(fg),
    'the top-level-array branch must clean the array against its schema'
  );
  // Both installSaver targets must carry `schema`, or that entry's saves lose the
  // required-field protection.
  const saverTargets = [...src.matchAll(/installSaver\(form,\s*\{[\s\S]*?\}\)/g)].map((m) => m[0]);
  assert.ok(saverTargets.length >= 2, 'expected two installSaver call sites');
  for (const target of saverTargets) {
    assert.ok(/\bschema\b/.test(target), 'every installSaver target must include `schema`');
  }
  // The saver's CALL to extractFormData must actually pass the target's schema —
  // dropping it silently reverts required-field protection.
  assert.ok(
    /extractFormData\(\s*target\.form\s*,\s*target\.schema\s*\)/.test(src),
    'makeSaver must call extractFormData(target.form, target.schema)'
  );
});

check('the editor→preview click handler matches the body via data-content-field', () => {
  // The body control has no form name, so the outbound highlight handler must
  // match [data-content-field] too, or clicking the body stops highlighting it.
  assert.ok(
    /\[name\],\s*\[data-content-field\]/.test(src),
    'outbound click delegation must match [name], [data-content-field]'
  );
});

console.log(`\n${passed} passed`);
