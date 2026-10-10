/**
 * The schema parser's stand-in marks survive every wrapper, for zod 3 and zod 4.
 *
 * Astro's image() and reference() reach the editor as stand-ins the parser
 * marks in the JSON Schema: `x-astroadmin-image` and `referenceCollection`.
 * zod 4 carries both as .meta(), which its serializer merges through
 * .optional(), .nullable() and .default(). zod 3 carries them on the _def and
 * zod-to-json-schema's postProcess copied them over, but its nullable
 * conversion of a primitive (`image().nullable()` -> `{type: ['string',
 * 'null']}`) never runs the inner node's postProcess, so the image mark was
 * lost: the picker stored a public URL, and an array item's `src:
 * image().nullable()` took the gallery path.
 *
 * Two throwaway sites: one whose `zod` is zod 3 (a package re-exporting
 * `zod/v3`, so the parser's image() stand-in is zod 3 too, as it is on a site
 * that installs zod 3), and one on this repo's zod 4.
 *
 *   bun tests/stand-in-marks.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseAstroSchemas, IMAGE_MARKER } from '../server/utils/schema-parser.js';
import { isAstroImageField } from '../ui/form-generator.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-stand-in-marks-'));

const config = `import { defineCollection, reference, z } from 'astro:content';

export const collections = {
  team: defineCollection({ type: 'content', schema: z.object({ name: z.string() }) }),
  posts: defineCollection({
    type: 'content',
    schema: ({ image }) => z.object({
      title: z.string(),
      cover: image(),
      described: image().describe('Portrait'),
      nullable: image().nullable(),
      describedNullable: image().describe('Portrait').nullable(),
      optional: image().optional(),
      defaulted: image().default('./a.jpg'),
      nullish: image().nullish(),
      nullableOptional: image().nullable().optional(),
      unionNull: z.union([image(), z.null()]),
      refined: image().refine(() => true).nullable(),
      gallery: z.array(z.object({ src: image().nullable(), alt: z.string() })),
      nested: z.object({ hero: image().nullable() }),
      sections: z.array(z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('hero'), photo: image().nullable() }),
        z.object({ kind: z.literal('text'), body: z.string() }),
      ])),
      plainString: z.string().nullable(),
      imageOrString: z.union([image(), z.string()]),
      author: reference('team'),
      authorNullable: reference('team').nullable(),
      authorOptional: reference('team').optional(),
      authorNullish: reference('team').nullish(),
      authors: z.array(reference('team')),
      authorsNullable: z.array(reference('team').nullable()),
      authorsOptional: z.array(reference('team')).optional(),
      when: z.date().nullable(),
    }),
  }),
};
`;

function makeSite(name, zodVersion) {
  const root = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/content.config.ts'), config);
  const modules = path.join(root, 'node_modules');
  fs.mkdirSync(modules);
  const realZod = path.join(repoRoot, 'node_modules', 'zod');
  if (zodVersion === 3) {
    // A site whose `zod` is zod 3.
    fs.mkdirSync(path.join(modules, 'zod'));
    fs.writeFileSync(path.join(modules, 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '3.25.0', type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(modules, 'zod', 'index.js'), `export * from ${JSON.stringify(path.join(realZod, 'v3', 'index.js'))};\n`);
  } else {
    fs.symlinkSync(realZod, path.join(modules, 'zod'), 'dir');
  }
  return root;
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`✅ ${name}`);
}

try {
  for (const zodVersion of [3, 4]) {
    const label = `zod ${zodVersion}`;
    const schemas = await parseAstroSchemas(makeSite(`zod${zodVersion}`, zodVersion));
    const props = schemas.posts?.schema?.properties;
    const imageMarked = (node) => isAstroImageField(node);

    await check(`${label}: the collection parsed with its fields (positive control)`, () => {
      assert.ok(props, 'posts has properties');
      assert.ok(props.title && props.cover && props.author, 'fields present');
      // The site's own zod built the stand-ins: zod 3 has no .meta().
      assert.equal(typeof schemas.posts._zodSchema.meta === 'function', zodVersion === 4, 'zod version of the parsed schema');
    });

    await check(`${label}: image() is marked through describe/nullable/optional/default/nullish/union`, () => {
      for (const key of ['cover', 'described', 'nullable', 'describedNullable', 'optional', 'defaulted',
        'nullish', 'nullableOptional', 'unionNull', 'refined']) {
        assert.ok(imageMarked(props[key]), `${key} is an image field (${JSON.stringify(props[key])})`);
      }
      assert.equal(props.cover[IMAGE_MARKER], true, 'the plain image() carries the mark itself');
    });

    await check(`${label}: image() inside arrays, objects and block options keeps its mark`, () => {
      assert.ok(imageMarked(props.gallery.items.properties.src), `array item src (${JSON.stringify(props.gallery.items.properties.src)})`);
      assert.ok(imageMarked(props.nested.properties.hero), 'object property');
      const union = schemas.posts.discriminatedUnions.find((candidate) => candidate.path.join('.') === 'sections.[]');
      assert.ok(union, 'block union found');
      const hero = union.options.find((option) => option.value === 'hero');
      assert.ok(imageMarked(hero.schema.properties.photo), `block option photo (${JSON.stringify(hero.schema.properties.photo)})`);
    });

    await check(`${label}: strings that are not image() are not marked`, () => {
      assert.equal(imageMarked(props.title), false, 'title');
      assert.equal(imageMarked(props.plainString), false, 'nullable string');
      assert.equal(imageMarked(props.imageOrString), false, 'image() | string is not only an image');
      assert.equal(imageMarked(props.gallery.items.properties.alt), false, 'array item alt');
    });

    await check(`${label}: reference() is marked through nullable/optional/nullish and in arrays`, () => {
      const target = (node) => node?.referenceCollection
        || [...(node?.anyOf || []), ...(node?.oneOf || [])].map((member) => member?.referenceCollection).find(Boolean);
      for (const key of ['author', 'authorNullable', 'authorOptional', 'authorNullish', 'authors', 'authorsNullable', 'authorsOptional']) {
        assert.equal(target(props[key]), 'team', `${key} references team (${JSON.stringify(props[key])})`);
      }
    });

    await check(`${label}: a nullable date keeps its date mark`, () => {
      const branches = [props.when, ...(props.when.anyOf || [])];
      assert.ok(branches.some((node) => node?.['x-astroadmin-date'] === true), JSON.stringify(props.when));
    });
  }

  console.log(`\n${passed} passed`);
} catch (error) {
  console.error(`\n❌ ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
