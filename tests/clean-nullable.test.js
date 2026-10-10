/**
 * cleanEmptyValues reads through a nullable wrapper. Both converters write a
 * nullable object as {anyOf: [<object>, {type: 'null'}]} with no top-level
 * `properties`, so cleanup could not prove a key inside it optional: an
 * optional `.min(1)` array emptied by the editor stayed `[]` and failed
 * validation, although the editor's advice said it would be left out.
 *
 *   bun tests/clean-nullable.test.js
 */

import assert from 'assert';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { cleanEmptyValues } from '../ui/form-generator.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${error.message}`);
  }
}

const zod4 = z.toJSONSchema(z.object({
  group: z.object({ tags: z.array(z.string()).min(1).optional() }).nullable(),
}), { unrepresentable: 'any' });
const zod3 = zodToJsonSchema(z3.object({
  group: z3.object({ tags: z3.array(z3.string()).min(1).optional() }).nullable(),
}));

for (const [label, schema] of [['zod 4', zod4], ['zod 3', zod3]]) {
  check(`${label}: positive control: the converter wraps the nullable object (no top-level properties)`, () => {
    assert.equal(schema.properties.group.properties, undefined, JSON.stringify(schema.properties.group));
  });
  check(`${label}: an emptied optional array inside a nullable object is dropped`, () => {
    const data = { group: { tags: [] } };
    cleanEmptyValues(data, schema);
    assert.deepEqual(data, { group: {} }, JSON.stringify(data));
  });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
