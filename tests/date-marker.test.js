/**
 * The schema parser's `x-astroadmin-date` marker, for zod 3 and zod 4.
 *
 * A REAL date (z.date(), z.coerce.date()) must be marked wherever it sits in
 * the schema: through optional/nullable/default, union and discriminated
 * union branches, intersections, objects and arrays. Only a marked field has a
 * new value written as an unquoted YAML date; unmarked, a newly entered date
 * is written as a quoted string and fails a z.date() schema. zod 4 marks
 * dates through its serializer override; zod 3 has none, so markZod3StandIns
 * walks the zod schema beside its JSON Schema, and before this test it never
 * visited union branches.
 *
 * Builds a throwaway site whose content config imports zod 3 (`zod/v3`) for
 * one collection and zod 4 for another. The parser bundles the config with
 * esbuild and runs no Astro, so a wholesale node_modules link is enough here.
 *
 *   bun tests/date-marker.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import matter from 'gray-matter';
import { z as z3 } from 'zod/v3';
import { parseAstroSchemas } from '../server/utils/schema-parser.js';
import { dateFieldsFromSchema, serializeMarkdown } from '../server/utils/content-format.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-date-marker-'));
const MARK = 'x-astroadmin-date';

// The same field shapes for both zod versions. `z` is whichever zod the
// collection's config imports.
const fieldsSource = `{
    title: z.string(),
    plain: z.date(),
    union: z.union([z.date(), z.null()]),
    unionOptional: z.union([z.date(), z.null()]).optional(),
    unionString: z.union([z.date(), z.string()]),
    nullable: z.date().nullable(),
    nullableOptional: z.date().nullable().optional(),
    defaulted: z.date().default(new Date('2026-01-01')),
    coerced: z.coerce.date(),
    caught: z.date().catch(new Date('2026-01-01')),
    dates: z.array(z.date()),
    nested: z.object({ when: z.date(), label: z.string() }),
    nestedUnion: z.object({ when: z.union([z.date(), z.null()]) }),
    events: z.array(z.object({ at: z.union([z.date(), z.null()]) })),
    sections: z.array(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('event'), at: z.date() }),
      z.object({ kind: z.literal('note'), text: z.string() }),
    ])),
    both: z.intersection(z.object({ start: z.date() }), z.object({ name: z.string() })),
    stringOrNull: z.union([z.string(), z.null()]),
    stringDay: z.string().date().optional(),
  }`;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`✅ ${name}`);
}

try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src/content.config.ts'), `import { defineCollection, z as z4 } from 'astro:content';
import { z as z3 } from 'zod/v3';

const zod3Fields = ((z) => (${fieldsSource}))(z3);
const zod4Fields = ((z) => (${fieldsSource}))(z4);

export const collections = {
  legacy: defineCollection({ type: 'content', schema: z3.object(zod3Fields) }),
  modern: defineCollection({ type: 'content', schema: z4.object(zod4Fields) }),
};
`);

  const schemas = await parseAstroSchemas(tmpRoot);

  console.log('\n🧪 Date marker (zod 3 and zod 4)\n' + '='.repeat(40));

  const anyBranch = (node) => [...(node?.anyOf || []), ...(node?.oneOf || []), ...(node?.allOf || [])];
  const marked = (node) => Boolean(node) && (node[MARK] === true || anyBranch(node).some(marked));
  // The single non-null branch of a nullable/union node, or the node itself.
  const dateBranch = (node) => anyBranch(node).find((member) => member?.[MARK] === true);

  for (const collection of ['legacy', 'modern']) {
    const label = collection === 'legacy' ? 'zod 3' : 'zod 4';
    const props = () => schemas[collection]?.schema?.properties;

    await check(`${label}: the collection parsed with its fields (positive control)`, () => {
      assert.ok(props(), `${collection} has properties`);
      assert.ok(props().title, 'title present');
      assert.ok(props().plain, 'plain present');
    });

    await check(`${label}: top-level dates are marked through every wrapper and union`, () => {
      const p = props();
      assert.equal(p.plain[MARK], true, 'z.date()');
      assert.equal(p.coerced[MARK], true, 'z.coerce.date()');
      assert.equal(p.defaulted[MARK], true, '.default()');
      assert.equal(p.caught[MARK], true, '.catch()');
      for (const key of ['union', 'unionOptional', 'unionString', 'nullable', 'nullableOptional']) {
        assert.ok(marked(p[key]), `${key} is marked (${JSON.stringify(p[key])})`);
      }
      // The mark lands on the date branch, not on the null/string one.
      assert.equal(dateBranch(p.union)?.type, 'string', 'union: the marked branch is the date');
      const unionString = anyBranch(p.unionString);
      assert.equal(unionString.filter((member) => member?.[MARK] === true).length, 1,
        'z.union([z.date(), z.string()]): only the date branch is marked');
    });

    await check(`${label}: dates nested in objects, arrays and unions carry the marker`, () => {
      const p = props();
      assert.equal(p.dates.items[MARK], true, 'array items');
      assert.equal(p.nested.properties.when[MARK], true, 'object property');
      assert.ok(marked(p.nestedUnion.properties.when), 'union inside an object');
      assert.ok(marked(p.events.items.properties.at), 'union inside an array of objects');
      const eventOption = anyBranch(p.sections.items).find((option) => option?.properties?.kind);
      assert.ok(eventOption, 'discriminated union options are serialised');
      const event = anyBranch(p.sections.items).find((option) => option?.properties?.at);
      assert.equal(event?.properties?.at?.[MARK], true, 'discriminated union option property');
      // zod 3 serialises an intersection as allOf; zod 4 merges two objects.
      const start = p.both.properties?.start
        || anyBranch(p.both).find((part) => part?.properties?.start)?.properties?.start;
      assert.equal(start?.[MARK], true, 'intersection member property');
    });

    await check(`${label}: strings, including date-format strings, are not marked`, () => {
      const p = props();
      assert.equal(marked(p.title), false, 'z.string()');
      assert.equal(marked(p.stringOrNull), false, 'z.union([z.string(), z.null()])');
      assert.equal(marked(p.stringDay), false, 'z.string().date()');
      assert.equal(marked(p.nested.properties.label), false, 'nested string');
    });

    await check(`${label}: dateFieldsFromSchema lists exactly the top-level date fields`, () => {
      const fields = [...dateFieldsFromSchema(schemas[collection].schema)].sort();
      assert.deepEqual(fields, [
        'caught', 'coerced', 'defaulted', 'nullable', 'nullableOptional',
        'plain', 'union', 'unionOptional', 'unionString',
      ]);
    });
  }

  await check('zod 3: a newly entered date in a union field is written unquoted and passes its schema', () => {
    const dateFields = dateFieldsFromSchema(schemas.legacy.schema);
    const text = serializeMarkdown('Body', { title: 'T', union: '2026-02-01' }, null, { dateFields });
    assert.match(text, /^union: 2026-02-01$/m, `unquoted date in:\n${text}`);
    const parsed = matter(text).data;
    const schema = z3.object({ title: z3.string(), union: z3.union([z3.date(), z3.null()]) });
    assert.equal(schema.safeParse(parsed).success, true, 'the written frontmatter passes z.union([z.date(), z.null()])');
    // Control: the quoted form the unmarked field produced fails that schema.
    const quoted = matter("---\ntitle: T\nunion: '2026-02-01'\n---\nBody\n").data;
    assert.equal(schema.safeParse(quoted).success, false, 'control: a quoted date fails the schema');
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
