/**
 * A problem inside a collapsed block, on a real site's schema and content.
 *
 * The fixture (tests/fixtures/derived-blocks-site) is derived from a real
 * client site: its own block definitions, refinements and URL check, and one
 * of its pages with the text replaced, plus a video block holding a Vimeo
 * link, which the site's schema refuses. Nothing here is hand-written issue
 * data: the schema goes through the real parser and block enrichment, the
 * entry through the real validation, and the form through the real renderer
 * and its handlers (happy-dom), collapsed as the dashboard collapses it.
 *
 * It pins: the collapsed block holding the problem says so in its header and
 * no other does; the summary line opens THAT block (the accordion closes the
 * one that was open) and focuses the field; a problem on an item inside a
 * block opens the block and goes to the list; a summary line whose block was
 * deleted since is disabled rather than doing nothing. Blocks do not nest (the
 * parser finds block lists only outside a block), so neither does this.
 *
 *   bun tests/block-reveal.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';

const repoRoot = path.resolve(import.meta.dir, '..');
const fixture = path.join(import.meta.dir, 'fixtures/derived-blocks-site');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-block-reveal-')));

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window, document: window.document, FormData: window.FormData, CSS: window.CSS,
  HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event,
});
globalThis.confirm = () => true;
window.confirm = () => true;

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}\n   ${String(error.message).split('\n').join('\n   ')}`);
    failures.push(name);
  }
}

try {
  fs.cpSync(fixture, projectRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'node_modules'));
  fs.symlinkSync(path.join(repoRoot, 'node_modules', 'zod'), path.join(projectRoot, 'node_modules', 'zod'), 'dir');
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));

  const { parseAstroSchemas } = await import('../server/utils/schema-parser.js');
  const { enrichSchemaWithBlockTypes } = await import('../server/utils/block-types.js');
  const { validateAgainstSchema } = await import('../server/utils/content-validation.js');
  const { generateForm, setupFormHandlers, bindOriginalValues } = await import('../ui/form-generator.js');
  const { showEntryProblems } = await import('../ui/content-problems.js');

  const schemas = await parseAstroSchemas(projectRoot);
  const schema = enrichSchemaWithBlockTypes(schemas.pages.schema, schemas.pages.discriminatedUnions);
  const stored = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src/content/pages/sample.json'), 'utf8'));

  /** The dashboard's open-entry sequence: render, wire, bind, collapse every block. */
  function openEntry(entry) {
    document.body.innerHTML = '';
    const form = document.createElement('form');
    form.innerHTML = generateForm(schema, entry);
    document.body.appendChild(form);
    setupFormHandlers(form, () => {});
    bindOriginalValues(form, entry);
    form.querySelectorAll('.block-item').forEach((block) => block.classList.add('collapsed'));
    return form;
  }
  const blocks = (form) => [...form.querySelectorAll('.blocks-list > .block-item')];
  const header = (block) => block.querySelector('.toggle-block-header');

  const validation = await validateAgainstSchema(schemas.pages, stored);
  const VIDEO = 9;

  await check("control: the site's own schema refuses the Vimeo link, at the video block's url, and nothing else", () => {
    assert.deepStrictEqual(validation, {
      status: 'invalid',
      issues: [{ path: `blocks[${VIDEO}].url`, message: 'Paste a YouTube link, e.g. https://www.youtube.com/watch?v=…' }],
    });
  });

  await check('the collapsed video block says it holds a problem; no other block does', () => {
    const form = openEntry(stored);
    showEntryProblems(form, validation, schema);
    const all = blocks(form);
    assert.equal(all.length, 10, 'control: ten blocks rendered');
    assert.equal(all[VIDEO].dataset.type, 'video');
    assert.ok(all.every((block) => block.classList.contains('collapsed')), 'control: all collapsed');
    assert.equal(header(all[VIDEO]).querySelector('.block-problem-badge')?.textContent, '1 problem');
    assert.equal(form.querySelectorAll('.block-problem-badge').length, 1);
  });

  await check('the summary line opens the video block, closes the one that was open, and focuses the url', () => {
    const form = openEntry(stored);
    header(blocks(form)[2]).click();
    assert.ok(!blocks(form)[2].classList.contains('collapsed'), 'control: block 3 was opened by its header');
    showEntryProblems(form, validation, schema);
    form.querySelector('.entry-problems .entry-problem-link').click();
    const all = blocks(form);
    assert.ok(!all[VIDEO].classList.contains('collapsed'), 'the video block is open');
    assert.ok(all[2].classList.contains('collapsed'), 'the block that was open is closed (one open block)');
    assert.equal(all[VIDEO].querySelector('.block-expand-icon').textContent, '▼');
    assert.equal(document.activeElement, form.querySelector(`[name="blocks[${VIDEO}].url"]`));
  });

  await check('a problem on an item inside a block opens that block and goes to the item list', async () => {
    const entry = structuredClone(stored);
    entry.blocks[0].items[1].href = 'javascript:alert(1)';
    const itemValidation = await validateAgainstSchema(schemas.pages, entry);
    assert.ok(itemValidation.issues.some((issue) => issue.path === 'blocks[0].items[1].href'), 'control: the item link is refused');
    const form = openEntry(entry);
    showEntryProblems(form, itemValidation, schema);
    assert.equal(header(blocks(form)[0]).querySelector('.block-problem-badge')?.textContent, '1 problem');
    const line = [...form.querySelectorAll('.entry-problem-link')].find((button) => button.textContent.startsWith('Blocks › 1 › Items › 2 › Href'));
    assert.ok(line, 'the item problem is a link');
    line.click();
    assert.ok(!blocks(form)[0].classList.contains('collapsed'), 'the feature grid block is open');
  });

  await check('a summary line whose block was deleted since is disabled, and opens nothing', () => {
    const form = openEntry(stored);
    showEntryProblems(form, validation, schema);
    const line = form.querySelector('.entry-problem-link');
    blocks(form)[VIDEO].querySelector('.remove-block').click();
    assert.equal(blocks(form).length, 9, 'control: the Delete Block button removed it');
    line.click();
    assert.equal(line.disabled, true);
    assert.ok(blocks(form).every((block) => block.classList.contains('collapsed')), 'no block was opened');
  });
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log(`\n📊 ${passed} passed, ${failures.length} failed.`);
if (failures.length > 0) process.exitCode = 1;
