/**
 * Empty and absent optionals inside a block: a save writes exactly what the
 * base renderer (HEAD before this work, 9ef8871) wrote, byte for byte.
 *
 * Inside a block every "" the form produced is kept, optional or not. Dropping
 * them (as at the top level) was tried and reverted: optional is not proof
 * that "" and absent mean the same (`.default('x')` fills absent in, a
 * template or block-level refinement can tell them apart), and the serialised
 * JSON Schema cannot say which "" the site's zod rejects (z.coerce, .catch(),
 * z.preprocess and zod 4's .base64() serialise as stricter than they are).
 *
 * For a site on zod 4 and one on zod 3 (a child process each), through the
 * real app (its schema parser and block enrichment, its PUT and file writer),
 * a page and a block, each holding .min(1).optional(), .optional(),
 * .default('x'), z.literal('').optional(), z.enum(['', 'a']).optional(),
 * z.coerce.number().optional(), .min(1).catch('c').optional() and an optional
 * object, are saved by three renderers:
 *   - base: ui/ at BLANK_OPTIONAL_BASE (`git archive`), unchanged
 *   - this checkout's ui/
 *   - a mutant: this checkout with the block exemption removed, so every
 *     optional "" in a block is dropped (the reverted change)
 * Scenarios: nothing edited (a positive control: no version can differ, since
 * every untouched value is restored), a sibling field in the block edited, a
 * new block added and left empty, every block matrix field cleared, and every
 * top-level matrix field cleared (#69: the top-level rule, every optional ""
 * and {} the form produced left out, is kept, and pinned by name as well as
 * by the base's bytes). Each file this checkout writes must equal the base's,
 * except for the changes listed in DELIBERATE (each naming its path, the
 * base's value and the new one). The mutant must differ somewhere, so the
 * comparison is known to be able to fail.
 *
 *   bun tests/blank-optional-round-trip.test.js
 */

import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const childZod = process.argv[2] === '--zod' ? Number(process.argv[3]) : null;
// The renderer this is compared against: before the block rule was narrowed.
const BASE_COMMIT = process.env.BLANK_OPTIONAL_BASE || '9ef8871';

if (childZod === null) {
  let failed = 0;
  for (const zodVersion of [4, 3]) {
    const result = spawnSync(process.execPath, [import.meta.path, '--zod', String(zodVersion)], { encoding: 'utf8', env: { ...process.env } });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) failed++;
  }
  console.log(failed === 0 ? '\n📊 zod 4 and zod 3 passed.' : `\n📊 ${failed} of 2 zod versions FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aa-blank-optional-zod${childZod}-`)));
let passed = 0;
try {
  const projectRoot = path.join(tmpRoot, 'site');
  process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
  process.env.GIT_ENABLED = 'false';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin';
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ASTROADMIN_CONTENT_STORE;

  const writeFile = (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  // The site: only zod in its node_modules (the parser resolves the site's own).
  const realZod = path.join(repoRoot, 'node_modules', 'zod');
  if (childZod === 3) {
    writeFile(path.join(projectRoot, 'node_modules/zod/package.json'), JSON.stringify({ name: 'zod', version: '3.25.0', type: 'module', main: 'index.js' }));
    writeFile(path.join(projectRoot, 'node_modules/zod/index.js'), `export * from ${JSON.stringify(path.join(realZod, 'v3', 'index.js'))};\n`);
  } else {
    fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
    fs.symlinkSync(realZod, path.join(projectRoot, 'node_modules', 'zod'), 'dir');
  }
  writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFile(path.join(projectRoot, 'src/content.config.ts'), `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
const matrix = {
  minOpt: z.string().min(1).optional(),
  opt: z.string().optional(),
  defaulted: z.string().default('x'),
  lit: z.literal('').optional(),
  choice: z.enum(['', 'a']).optional(),
  meta: z.object({ note: z.string().optional() }).optional(),
  coerced: z.coerce.number().optional(),
  caught: z.string().min(1).catch('c').optional(),
};
const note = z.object({ type: z.literal('note'), heading: z.string(), ...matrix });
const spacer = z.object({ type: z.literal('spacer') });
export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.json', base: './src/content/pages' }),
    schema: z.object({ title: z.string(), ...matrix, blocks: z.array(z.discriminatedUnion('type', [note, spacer])) }),
  }),
};
`);

  // The same fields filled at the top level; a filled block, a block stored
  // with every optional empty or absent, a block of another type, and a block
  // with only its required fields (no literal).
  const STORED = {
    title: 'Page',
    minOpt: 'm', opt: 'o', defaulted: 'y', choice: 'a', meta: { note: 'n' }, coerced: 3, caught: 'k',
    blocks: [
      { type: 'note', heading: 'Full', minOpt: 'm', opt: 'o', defaulted: 'y', lit: '', choice: 'a', meta: { note: 'n' }, coerced: 3, caught: 'k' },
      { type: 'note', heading: 'Empties', opt: '', defaulted: '', lit: '', choice: '', meta: {} },
      { type: 'spacer' },
      { type: 'note', heading: 'No literal' },
    ],
  };
  const STORED_TEXT = `${JSON.stringify(STORED, null, 2)}\n`;
  const entryFile = path.join(projectRoot, 'src/content/pages/page.json');
  writeFile(entryFile, STORED_TEXT);

  // The three renderers.
  const headUi = path.join(tmpRoot, 'head');
  fs.mkdirSync(headUi);
  execFileSync('/bin/sh', ['-c', `/usr/bin/git -C "${repoRoot}" archive ${BASE_COMMIT} ui | tar -x -C "${headUi}"`]);
  const mutantUi = path.join(tmpRoot, 'mutant');
  fs.cpSync(path.join(repoRoot, 'ui'), path.join(mutantUi, 'ui'), { recursive: true });
  const mutantFile = path.join(mutantUi, 'ui/form-generator.js');
  const source = fs.readFileSync(mutantFile, 'utf8');
  const anchor = 'if (!isBlockItem && schemaKnown && !isRequired) delete obj[key];';
  // Without the anchor there is no mutant: the instrument check below fails,
  // and the comparisons still run.
  const mutantMade = source.split(anchor).length === 2;
  fs.writeFileSync(mutantFile, source.replace(anchor, 'if (schemaKnown && !isRequired) delete obj[key];'));

  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    window, document: window.document, FormData: window.FormData, CSS: window.CSS,
    HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event,
  });
  globalThis.confirm = () => true;
  window.confirm = () => true;
  const renderers = {
    head: await import(path.join(headUi, 'ui/form-generator.js')),
    current: await import(path.join(repoRoot, 'ui/form-generator.js')),
    mutant: await import(mutantFile),
  };

  const { createServer } = await import('../server/index.js');
  const { app } = await createServer();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.equal(login.status, 200, 'login');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const schema = (await (await fetch(`${base}/api/collections/pages`, { headers: { cookie } })).json()).collection.schema;
    assert.ok(schema.properties.blocks.blockTypes?.note, 'control: the app enriched the blocks with their types');

    /** Save a payload through the real PUT, from the stored file; the file's bytes after. */
    async function saveThroughApp(data) {
      fs.writeFileSync(entryFile, STORED_TEXT);
      const response = await fetch(`${base}/api/content/pages/page`, {
        method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ data, type: 'data' }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return fs.readFileSync(entryFile, 'utf8');
    }

    const setValue = (form, name, value) => {
      const control = form.querySelector(`[name="${name}"]`);
      assert.ok(control, `control: ${name} is rendered`);
      control.value = value;
      assert.equal(control.value, value, `control: ${name} took the value`);
    };
    const MATRIX = ['minOpt', 'opt', 'defaulted', 'lit', 'choice', 'meta.note', 'coerced', 'caught'];
    const scenarios = {
      'nothing edited': () => {},
      'a sibling field in each block edited': (form) => {
        setValue(form, 'blocks[0].heading', 'Full, edited');
        setValue(form, 'blocks[1].heading', 'Empties, edited');
        setValue(form, 'blocks[3].heading', 'No literal, edited');
      },
      'a new block added and left empty': (form) => {
        form.querySelector('#add-block-type').value = 'note';
        form.querySelector('.add-block-btn').click();
        setValue(form, 'blocks[4].heading', 'New');
      },
      'every matrix field cleared': (form) => {
        for (const field of MATRIX) {
          if (field === 'lit') continue; // a const: hidden, not the editor's
          setValue(form, `blocks[0].${field}`, '');
        }
      },
      // #69: at the top level every optional "" (and {}) the form produced is
      // left out, `.default('x')` and z.coerce included: absent is the one
      // value every optional key accepts (a template's `navLabel ?? title`
      // reads it as unset). Pinned against the base AND by name (TOP_CLEARED).
      'every top-level matrix field cleared': (form) => {
        for (const field of MATRIX) {
          if (field === 'lit') continue;
          setValue(form, field, '');
        }
      },
    };
    // What the top-level scenario must write, whatever the base did.
    const TOP_CLEARED = { absent: ['minOpt', 'opt', 'defaulted', 'lit', 'choice', 'meta', 'coerced', 'caught'], kept: {} };

    // Where this checkout deliberately writes other bytes than the base: each
    // change names the path, the value the base wrote there (asserted, so a
    // split is never a silent widening) and the value written now (undefined:
    // the key is absent). Everything else in the file must still be the base's.
    const DELIBERATE = {
      // #69: the const input's value (the schema's) is written only where the
      // key is required. The base wrote an absent optional z.literal('') in a
      // block as "".
      'a sibling field in each block edited': [
        { path: ['blocks', 3, 'lit'], base: '', now: undefined },
      ],
      'a new block added and left empty': [
        { path: ['blocks', 4, 'lit'], base: '', now: undefined },
      ],
      'every matrix field cleared': [
        // #61: a cleared number is absent. The base wrote "" (which
        // z.coerce.number() reads as 0, and every z.number() refuses).
        { path: ['blocks', 0, 'coerced'], base: '', now: undefined },
      ],
    };
    const valueAt = (data, keys) => keys.reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), data);
    /** The base's file with this scenario's deliberate changes applied. */
    function expectedText(scenario, headText) {
      const changes = DELIBERATE[scenario] || [];
      if (changes.length === 0) return headText;
      const data = JSON.parse(headText);
      for (const change of changes) {
        const parent = valueAt(data, change.path.slice(0, -1));
        const key = change.path[change.path.length - 1];
        assert.deepStrictEqual(parent?.[key], change.base, `control: the base wrote ${JSON.stringify(change.base)} at ${change.path.join('.')}`);
        if (change.now === undefined) delete parent[key];
        else parent[key] = change.now;
      }
      return `${JSON.stringify(data, null, 2)}\n`;
    }

    /** What one renderer saves for one scenario. */
    async function savedBy(rendererName, scenario) {
      const { generateForm, setupFormHandlers, bindOriginalValues, extractFormData } = renderers[rendererName];
      const form = document.createElement('form');
      form.innerHTML = generateForm(schema, structuredClone(STORED));
      document.body.appendChild(form);
      setupFormHandlers(form, () => {});
      bindOriginalValues(form, structuredClone(STORED));
      scenarios[scenario](form);
      const data = extractFormData(form, schema);
      form.remove();
      return { data, text: await saveThroughApp(data) };
    }

    let mutantDiffered = 0;
    for (const scenario of Object.keys(scenarios)) {
      const head = await savedBy('head', scenario);
      const current = await savedBy('current', scenario);
      const mutant = await savedBy('mutant', scenario);
      let expected = head.text;
      try {
        if (scenario === 'nothing edited') {
          assert.equal(head.text, STORED_TEXT, 'control: the base writes an unedited entry back byte for byte');
        }
        if (scenario === 'every top-level matrix field cleared') {
          const saved = JSON.parse(current.text);
          for (const key of TOP_CLEARED.absent) assert.ok(!(key in saved), `a cleared optional ${key} at the top level is absent, not ${JSON.stringify(saved[key])}`);
          for (const [key, value] of Object.entries(TOP_CLEARED.kept)) assert.deepStrictEqual(saved[key], value, `the stored ${key} is kept`);
          assert.deepStrictEqual(saved.blocks, STORED.blocks, 'control: the blocks are untouched');
        }
        expected = expectedText(scenario, head.text);
        assert.equal(current.text, expected, DELIBERATE[scenario]
          ? "this checkout must write the base renderer's file with only the deliberate changes"
          : "this checkout must write the base renderer's file");
        passed++;
        console.log(`✅ [zod ${childZod}] ${scenario}: the base renderer's bytes${DELIBERATE[scenario] ? ` (${DELIBERATE[scenario].length} deliberate change(s))` : ''}`);
      } catch (error) {
        console.error(`❌ [zod ${childZod}] ${scenario}\n   ${error.message.split('\n').join('\n   ')}`);
        process.exitCode = 1;
      }
      if (mutant.text !== expected) mutantDiffered++;
    }

    try {
      assert.ok(mutantMade, 'the mutant could not be made: the block exemption in cleanEmptyValues is not there once');
      assert.ok(mutantDiffered > 0, 'the unconditional-drop mutant wrote the base renderer\'s bytes in every scenario: the comparison cannot see the difference');
      passed++;
      console.log(`✅ [zod ${childZod}] instrument: the unconditional-drop mutant is told apart (${mutantDiffered} scenario(s))`);
    } catch (error) {
      console.error(`❌ [zod ${childZod}] instrument\n   ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    server.close();
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
console.log(`[zod ${childZod}] ${passed} checks passed${process.exitCode ? ', some FAILED' : ''}.`);
process.exit(process.exitCode || 0);
