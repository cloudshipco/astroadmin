/**
 * The schema parser's marker keywords have one definition (ui/schema-markers.js).
 *
 * The parser writes them into the JSON Schema and the editor reads them back;
 * a copy on each side could drift, and a renamed marker on one side turns a
 * marked field (a file() id, an image(), a real date) back into a plain one
 * on the other, with nothing failing. Asserts: no file under ui/ or server/
 * spells a marker as a string literal outside ui/schema-markers.js, and the
 * names the parser re-exports are that module's.
 *
 *   bun tests/schema-markers.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const markers = await import('../ui/schema-markers.js');
const parser = await import('../server/utils/schema-parser.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`❌ ${name}\n   ${String(error.message).split('\n').join('\n   ')}`);
  }
}

function sourceFiles(directory) {
  return fs.readdirSync(path.join(repoRoot, directory), { recursive: true })
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(directory, name));
}

// A marker as a quoted literal: 'x-astroadmin-…' or "x-astroadmin-…".
const MARKER_LITERAL = /['"]x-astroadmin-[a-z-]+['"]/g;

check('control: the shared module defines the three markers', () => {
  assert.deepEqual(Object.keys(markers).sort(), ['DATE_MARKER', 'ENTRY_ID_MARKER', 'IMAGE_MARKER']);
  const sharedSource = fs.readFileSync(path.join(repoRoot, 'ui/schema-markers.js'), 'utf8');
  assert.equal(sharedSource.match(MARKER_LITERAL)?.length, 3, 'the literal pattern finds them in the shared module');
});

check('no other ui/ or server/ file spells a marker itself', () => {
  const copies = [];
  for (const file of [...sourceFiles('ui'), ...sourceFiles('server')]) {
    if (file === path.join('ui', 'schema-markers.js')) continue;
    for (const line of fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue; // prose may name one
      if (MARKER_LITERAL.test(line)) copies.push(`${file}: ${trimmed}`);
      MARKER_LITERAL.lastIndex = 0;
    }
  }
  assert.deepEqual(copies, [], 'import it from ui/schema-markers.js instead');
});

check('the schema parser re-exports the shared markers', () => {
  for (const name of Object.keys(markers)) {
    assert.equal(parser[name], markers[name], name);
  }
});

console.log(`\n📊 ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
