/**
 * Content problems in the editor (ui/content-problems.js)
 *
 * Renders real forms through generateForm into happy-dom, so the field names
 * the issue paths must match are the renderer's own, and asserts:
 *   - an issue path finds its input, or the nearest ancestor that has one;
 *   - a save's validation result marks the form, and a valid result clears it;
 *   - the marks never leak into the data the next save reads back;
 *   - a refused publish lists each invalid entry.
 *
 *   bun tests/content-problems.test.js
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.FormData = window.FormData;
globalThis.CSS = window.CSS;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;

const { generateForm, extractFields } = await import('../ui/form-generator.js');
const {
  describeIssuePath,
  findFieldForPath,
  showEntryProblems,
  renderPublishProblems,
} = await import('../ui/content-problems.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}\n   ${String(error.message).split('\n').join('\n   ')}`);
    failures.push(name);
  }
}

// Block arrays carry blockTypes (the dashboard adds it from the discriminated
// unions); without it the renderer does not draw them as blocks.
const blockTypes = {
  hero: {
    type: 'object',
    properties: { type: { type: 'string', const: 'hero' }, heading: { type: 'string' } },
    required: ['type', 'heading'],
  },
};
const schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    blocks: { type: 'array', blockTypes, items: { anyOf: Object.values(blockTypes) } },
  },
  required: ['title', 'blocks'],
};

function render(data) {
  const form = document.createElement('form');
  form.innerHTML = generateForm(schema, data);
  document.body.appendChild(form);
  return form;
}

const data = { title: 'Home', blocks: [{ type: 'hero', heading: 'Hi' }, { type: 'hero', heading: '' }] };

// Positive control: the rendered form really has the names the paths below
// rely on, so a "not found" is the lookup's doing, not a renderer change.
check('control: the renderer names block fields as the issue paths do', () => {
  const form = render(data);
  assert.ok(form.querySelector('[name="title"]'), 'title input');
  assert.ok(form.querySelector('[name="blocks[1].heading"]'), 'blocks[1].heading input');
});

check('issue paths read as field labels, counting from one', () => {
  assert.equal(describeIssuePath('blocks[1].heading'), 'Blocks › 2 › Heading');
  assert.equal(describeIssuePath('seoTitle'), 'Seo Title');
  assert.equal(describeIssuePath(''), 'This entry');
});

check('an exact path finds its own input', () => {
  const form = render(data);
  assert.equal(findFieldForPath(form, 'blocks[1].heading').getAttribute('name'), 'blocks[1].heading');
});

check('a path with no input of its own finds the nearest ancestor that has one', () => {
  const form = render(data);
  const field = findFieldForPath(form, 'title.nested');
  assert.equal(field.getAttribute('name'), 'title');
  assert.equal(findFieldForPath(form, 'nothing.here'), null);
});

check('an invalid result adds a summary and marks the field', () => {
  const form = render(data);
  showEntryProblems(form, {
    status: 'invalid',
    issues: [{ path: 'blocks[1].heading', message: 'Too short' }],
  });
  const summary = form.querySelector('.entry-problems');
  assert.ok(summary, 'summary shown');
  assert.ok(summary.textContent.includes('Blocks › 2 › Heading: Too short'));
  const input = form.querySelector('[name="blocks[1].heading"]');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  const group = input.closest('.form-group');
  assert.ok(group.classList.contains('has-problem'));
  assert.equal(group.querySelector('.field-problem').textContent, 'Too short');
});

check('a missing required blocks array is marked on the blocks field', () => {
  const form = render({ title: 'Home' });
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'blocks', message: 'Required' }] });
  const message = form.querySelector('.field-problem');
  assert.ok(message, 'a field-level message was placed');
  assert.equal(message.closest('.form-group').dataset.field, 'blocks', 'on the blocks group');
  assert.equal(message.textContent, 'Required');
});

check('an issue with no locatable field is still named in the summary', () => {
  const form = render(data);
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'nothing.here', message: 'Required' }] });
  assert.ok(form.querySelector('.entry-problems').textContent.includes('Nothing › Here: Required'));
  assert.equal(form.querySelectorAll('.field-problem').length, 0);
});

check('a valid result clears the previous marks', () => {
  const form = render(data);
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'title', message: 'Required' }] });
  assert.ok(form.querySelector('.entry-problems'), 'marked first');
  showEntryProblems(form, { status: 'valid', issues: [] });
  assert.equal(form.querySelector('.entry-problems'), null);
  assert.equal(form.querySelectorAll('.field-problem, .has-problem, [aria-invalid]').length, 0);
});

check('marks do not change what the next save reads back', () => {
  const unmarked = extractFields(render(data));
  const form = render(data);
  showEntryProblems(form, {
    status: 'invalid',
    issues: [{ path: 'title', message: 'Required' }, { path: 'blocks[1].heading', message: 'Too short' }],
  });
  assert.deepStrictEqual(extractFields(form), unmarked);
});

check('a refused publish links the entries Astro named and shows its output', () => {
  const problems = renderPublishProblems({
    message: 'Your changes are saved and committed, but were not published.',
    check: {
      output: '[InvalidContentEntryDataError] pages → home data does not match collection schema.',
      entries: [{ collection: 'pages', slug: 'home', editable: true }, { collection: 'pages', slug: 'homefr', editable: false }],
    },
  });
  assert.equal(problems.querySelectorAll('a').length, 1, 'an Astro ID with no editor slug is not a link');
  assert.ok(problems.textContent.includes('pages/homefr'), 'but it is still named');
  const link = problems.querySelector('a[data-collection="pages"]');
  assert.equal(link.dataset.slug, 'home');
  assert.equal(link.getAttribute('href'), '/dashboard/pages/home');
  assert.ok(problems.querySelector('pre').textContent.includes('InvalidContentEntryDataError'));
  assert.equal(problems.querySelector('details').open, false, 'output folded when an entry is named');
});

check('a refusal naming no entry opens the output', () => {
  const problems = renderPublishProblems({ message: 'Not published.', check: { output: 'Config failed to load', entries: [] } });
  assert.equal(problems.querySelectorAll('a').length, 0);
  assert.equal(problems.querySelector('details').open, true);
});

check('an issue on a whole inline array is marked on that field', () => {
  const form = document.createElement('form');
  form.innerHTML = generateForm({
    type: 'object',
    properties: { tags: { type: 'array', items: { type: 'string' } } },
  }, { tags: [] });
  document.body.appendChild(form);
  assert.ok(form.querySelector('[data-field="tags"]'), 'control: the array container carries data-field');
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'tags', message: 'Add at least one' }] });
  assert.equal(form.querySelectorAll('.field-problem').length, 1, 'marked on the field, not just the summary');
});

console.log(`\n📊 ${passed} passed, ${failures.length} failed.`);
if (failures.length > 0) process.exitCode = 1;
