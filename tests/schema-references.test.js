/**
 * Collection references: Astro's reference() and the `<name>Ids` convention.
 *
 * Builds a throwaway project, parses its content config with the real schema
 * parser, and renders the result through the real form generator (happy-dom),
 * so the editor sees exactly what a site's schema produces.
 *
 * Pins:
 *   - reference('team') parses (it used to throw inside toJSONSchema and take
 *     the whole site's schema loading down with it) as a string id, and
 *     z.array(reference('posts')) as an array of ids, each carrying its target
 *     collection as `referenceCollection`.
 *   - `<base>Ids` resolves against the DECLARED collections: `<base>s`, then
 *     `<base>`, then `<base>es`, then y -> ies. A name that resolves to nothing
 *     declared is not a reference and renders as a plain list of inputs.
 *   - the editor renders the reference picker for each, a single reference
 *     saves as a string and a list as an array.
 *
 *   bun tests/schema-references.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.FormData = window.FormData;
globalThis.CSS = window.CSS;
globalThis.HTMLElement = window.HTMLElement;

const { parseAstroSchemas } = await import('../server/utils/schema-parser.js');
const { enrichSchemaWithBlockTypes } = await import('../server/utils/block-types.js');
const { generateForm, extractFormData } = await import('../ui/form-generator.js');

const repoRoot = path.resolve(import.meta.dir, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-references-'));

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

function render(schema, data) {
  const form = document.createElement('form');
  form.innerHTML = generateForm(schema, data);
  document.body.appendChild(form);
  return form;
}

try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'src/content.config.ts'),
    `import { defineCollection, reference, z } from 'astro:content';
import { glob, file } from 'astro/loaders';

const team = defineCollection({ loader: file('src/data/team.json'), schema: z.object({ id: z.string(), name: z.string() }) });
const categories = defineCollection({ loader: file('src/data/categories.json'), schema: z.object({ id: z.string() }) });
const boxes = defineCollection({ loader: file('src/data/boxes.json'), schema: z.object({ id: z.string() }) });
const authors = defineCollection({ loader: file('src/data/authors.json'), schema: z.object({ id: z.string() }) });

const quoteBlock = z.object({ type: z.literal('quotes'), teamIds: z.array(z.string()).optional() });
const plainBlock = z.object({ type: z.literal('plain'), heading: z.string() });

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    author: reference('team'),
    editor: reference('team').optional(),
    related: z.array(reference('posts')).optional(),
    teamIds: z.array(z.string()).optional(),
    categoryIds: z.array(z.string()).optional(),
    boxIds: z.array(z.string()).optional(),
    authorIds: z.array(z.string()).optional(),
    ghostIds: z.array(z.string()).optional(),
    blocks: z.array(z.discriminatedUnion('type', [quoteBlock, plainBlock])).optional(),
  }),
});

export const collections = { team, categories, boxes, authors, posts };
`
  );

  console.log('\n🧪 Collection references\n' + '='.repeat(40));

  let schemas = null;
  try {
    schemas = await parseAstroSchemas(tmpRoot);
    passed++;
    console.log('✅ a content config using reference() parses');
  } catch (error) {
    failures.push('parseAstroSchemas');
    console.log(`❌ a content config using reference() parses\n   threw: ${error.message}`);
  }

  if (schemas) {
    const properties = schemas.posts.schema.properties;

    check('reference(coll) is a string id carrying its collection', () => {
      assert.equal(properties.author.type, 'string', JSON.stringify(properties.author));
      assert.equal(properties.author.referenceCollection, 'team');
      assert.ok(schemas.posts.schema.required.includes('author'), 'control: author is required');
    });

    check('an optional reference keeps its collection', () => {
      assert.equal(properties.editor.type, 'string', JSON.stringify(properties.editor));
      assert.equal(properties.editor.referenceCollection, 'team');
    });

    check('z.array(reference(coll)) is an array of ids carrying its collection', () => {
      assert.equal(properties.related.type, 'array');
      assert.equal(properties.related.items.type, 'string');
      assert.equal(properties.related.referenceCollection, 'posts');
    });

    check('<base>Ids finds <base> when only the singular is declared (teamIds -> team)', () => {
      assert.equal(properties.teamIds.referenceCollection, 'team');
    });

    check('<base>Ids finds <base>s (authorIds -> authors)', () => {
      assert.equal(properties.authorIds.referenceCollection, 'authors');
    });

    check('<base>Ids finds y -> ies and <base>es (categoryIds, boxIds)', () => {
      assert.equal(properties.categoryIds.referenceCollection, 'categories');
      assert.equal(properties.boxIds.referenceCollection, 'boxes');
    });

    check('<base>Ids naming nothing declared is not a reference', () => {
      assert.equal(properties.ghostIds.referenceCollection, undefined);
      assert.equal(properties.ghostIds.type, 'array', 'control: still an array field');
    });

    check('a block field resolves the same way, and is recorded for the preview', () => {
      const quotes = schemas.posts.discriminatedUnions[0].options.find((o) => o.value === 'quotes');
      assert.equal(quotes.schema.properties.teamIds.referenceCollection, 'team');
      assert.deepEqual(schemas.posts.blockCollectionRefs.team, [{ blockType: 'quotes', field: 'teamIds' }]);
      assert.equal(schemas.posts.blockCollectionRefs.teams, undefined, 'no ref to an undeclared "teams"');
    });

    const editorSchema = enrichSchemaWithBlockTypes(schemas.posts.schema, schemas.posts.discriminatedUnions);
    const entry = {
      title: 'Hello',
      author: 'ada',
      related: ['other-post'],
      teamIds: ['ada', 'grace'],
      ghostIds: ['g-1'],
      blocks: [{ type: 'quotes', teamIds: ['grace'] }],
    };

    check('the editor renders a reference picker for each reference, aimed at its collection', () => {
      const form = render(editorSchema, entry);
      const pickerFor = (field) => form.querySelector(`.reference-field[data-field="${field}"]`);
      assert.equal(pickerFor('author')?.dataset.collection, 'team', 'author');
      assert.equal(pickerFor('editor')?.dataset.collection, 'team', 'editor');
      assert.equal(pickerFor('related')?.dataset.collection, 'posts', 'related');
      assert.equal(pickerFor('teamIds')?.dataset.collection, 'team', 'teamIds');
      assert.equal(pickerFor('blocks[0].teamIds')?.dataset.collection, 'team', 'block teamIds');
    });

    check('a name that resolves to no collection renders plain inputs, no picker', () => {
      const form = render(editorSchema, entry);
      assert.ok(form.querySelector('.reference-field[data-field="ghostIds"]') === null, 'ghostIds rendered a reference picker');
      const input = form.querySelector('input[name="ghostIds[0]"]');
      assert.ok(input, 'a plain input carries the value');
      assert.equal(input.value, 'g-1');
    });

    check('a single reference saves as a string, a list as an array', () => {
      const form = render(editorSchema, entry);
      const saved = extractFormData(form, editorSchema);
      assert.equal(saved.author, 'ada');
      assert.deepEqual(saved.related, ['other-post']);
      assert.deepEqual(saved.teamIds, ['ada', 'grace']);
      assert.deepEqual(saved.ghostIds, ['g-1']);
      assert.deepEqual(saved.blocks[0].teamIds, ['grace']);
      assert.equal('editor' in saved, false, 'an unset optional reference is left out');
    });
  }

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}.\n`);
  if (failures.length) process.exitCode = 1;
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
