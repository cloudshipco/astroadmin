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
// Delete Block asks first; the answer here is yes.
globalThis.confirm = () => true;
window.confirm = () => true;

const { generateForm, extractFields, setupFormHandlers } = await import('../ui/form-generator.js');
const {
  describeIssuePath,
  findFieldForPath,
  showEntryProblems,
  renderPublishProblems,
  localeToOpen,
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

check('a refused publish shows the reasons, links the entries and lists their issues', () => {
  const problems = renderPublishProblems({
    message: 'Your changes are saved and committed, but were not published.',
    check: {
      problems: [{ code: 'InvalidContentEntryDataError', message: "An entry's data does not match its collection's schema." }],
      entries: [
        { collection: 'pages', slug: 'home', locale: 'fr', editable: true, issues: [{ path: 'link', message: 'Invalid option', accepted: ['/home/about', '/home/contact'] }] },
        { collection: 'pages', slug: 'archive', locale: null, editable: false, issues: [] },
      ],
      output: 'ignored: the structured parts are shown',
    },
  });
  assert.ok(problems.textContent.includes("An entry's data does not match its collection's schema."), problems.textContent);
  assert.equal(problems.querySelectorAll('a').length, 1, 'an entry the editor cannot open is not a link');
  assert.ok(problems.textContent.includes('pages/archive'), 'but it is still named');
  const link = problems.querySelector('a[data-collection="pages"]');
  assert.equal(link.dataset.slug, 'home');
  assert.equal(link.textContent, 'pages/home (fr)');
  assert.equal(link.getAttribute('href'), '/dashboard/pages/home');
  const issue = problems.querySelector('li li');
  assert.equal(issue.textContent, 'Link: Invalid option Accepted: /home/about, /home/contact.');
  assert.equal(problems.querySelector('pre'), null, 'no raw output block');
  assert.ok(!problems.textContent.includes('ignored'), 'the plain-text output is not shown twice');
});

check('a refused translation opens THAT translation, not the one being edited', () => {
  const opened = [];
  const problems = renderPublishProblems({
    message: 'Not published.',
    check: {
      problems: [],
      entries: [
        { collection: 'pages', slug: 'home', locale: 'fr', editable: true, issues: [] },
        { collection: 'pages', slug: 'home', locale: null, editable: true, issues: [] },
      ],
    },
  }, { onOpenEntry: (target) => opened.push(target) });
  document.body.appendChild(problems);
  const [french, plain] = problems.querySelectorAll('a[data-collection]');
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  french.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, 'the link does not navigate away');
  plain.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, [
    { collection: 'pages', slug: 'home', locale: 'fr' },
    { collection: 'pages', slug: 'home', locale: null },
  ]);
  const i18n = { enabled: true, defaultLocale: 'en', locales: ['en', 'fr'] };
  assert.equal(localeToOpen('fr', i18n), 'fr');
  assert.equal(localeToOpen(null, i18n), 'en', 'a file with no locale suffix is the default locale');
  assert.equal(localeToOpen('fr', { enabled: false }), null, 'no i18n: no locale to select');
  problems.remove();
});

check('a refusal naming no entry shows its reason', () => {
  const problems = renderPublishProblems({ message: 'Not published.', check: { problems: [{ code: null, message: 'The publish check could not run.' }], entries: [] } });
  assert.equal(problems.querySelectorAll('a').length, 0);
  assert.ok(problems.textContent.includes('The publish check could not run.'));
});

check('hostile text in a refusal stays text', () => {
  const problems = renderPublishProblems({
    message: 'Not published.',
    check: { problems: [{ code: 'X', message: '<img src=x onerror=alert(1)>' }], entries: [{ collection: 'pages', slug: '<b>x</b>', editable: false, issues: [{ path: 'title', message: '<script>1</script>' }] }] },
  });
  assert.equal(problems.querySelector('img, b, script'), null, problems.innerHTML);
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

// --- Problems inside collapsed blocks -----------------------------------------
// Blocks render collapsed (the dashboard collapses every block after render),
// so a message on a block's field is out of sight. The block's header says so,
// and the summary line takes the editor to the field. The same on a real
// site's schema and content: tests/block-reveal.test.js.

/** Render with handlers wired and every block collapsed, as the dashboard does. */
function renderCollapsed(entry) {
  const form = render(entry);
  setupFormHandlers(form, () => {});
  form.querySelectorAll('.block-item').forEach((block) => block.classList.add('collapsed'));
  return form;
}

const threeBlocks = { title: 'Home', blocks: [{ type: 'hero', heading: 'A' }, { type: 'hero', heading: '' }, { type: 'hero', heading: 'C' }] };

check('a collapsed block holding a problem is marked in its header, with a count', () => {
  const form = renderCollapsed(threeBlocks);
  showEntryProblems(form, {
    status: 'invalid',
    issues: [
      { path: 'blocks[1].heading', message: 'Too short' },
      { path: 'blocks[1].subtitle', message: 'Required' },
    ],
  });
  const blocks = [...form.querySelectorAll('.block-item')];
  assert.equal(blocks.length, 3, 'control: three blocks rendered');
  assert.ok(blocks[1].classList.contains('collapsed'), 'control: still collapsed');
  assert.ok(blocks[1].classList.contains('block-has-problem'), 'the block is marked');
  assert.equal(blocks[1].querySelector('.toggle-block-header .block-problem-badge')?.textContent, '2 problems');
  for (const index of [0, 2]) {
    assert.ok(!blocks[index].classList.contains('block-has-problem'), `block ${index + 1} is not marked`);
    assert.equal(blocks[index].querySelector('.block-problem-badge'), null, `block ${index + 1} has no badge`);
  }
});

check('one problem reads "1 problem", and a valid result clears the block marks', () => {
  const form = renderCollapsed(threeBlocks);
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'blocks[1].heading', message: 'Too short' }] });
  assert.equal(form.querySelector('.block-problem-badge')?.textContent, '1 problem');
  showEntryProblems(form, { status: 'valid', issues: [] });
  assert.equal(form.querySelectorAll('.block-problem-badge, .block-has-problem').length, 0);
});

check('a problem on a whole block list marks no single block', () => {
  const form = renderCollapsed(threeBlocks);
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'blocks', message: 'Too many' }] });
  assert.equal(form.querySelectorAll('.block-problem-badge, .block-has-problem').length, 0);
});

check('a summary line opens the collapsed block and focuses the field', () => {
  const form = renderCollapsed(threeBlocks);
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'blocks[1].heading', message: 'Too short' }] });
  const line = form.querySelector('.entry-problems li button');
  assert.ok(line, 'the summary line is a button');
  assert.equal(line.textContent, 'Blocks › 2 › Heading: Too short');
  line.click();
  const blocks = [...form.querySelectorAll('.block-item')];
  assert.ok(!blocks[1].classList.contains('collapsed'), 'the block is open');
  assert.ok(blocks[0].classList.contains('collapsed') && blocks[2].classList.contains('collapsed'), 'the others stay closed');
  assert.equal(document.activeElement, form.querySelector('[name="blocks[1].heading"]'), 'the field has focus');
});

check('a summary line with no field to go to is plain text', () => {
  const form = renderCollapsed(threeBlocks);
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'nothing.here', message: 'Required' }] });
  assert.equal(form.querySelector('.entry-problems li button'), null);
  assert.equal(form.querySelector('.entry-problems li').textContent, 'Nothing › Here: Required');
});

check('a problem on a whole block (a block-level refinement) opens that block from the summary', () => {
  // A superRefine on a block reports at the block's own path, which has no
  // control of its own: the summary line goes to the block, not the list.
  const form = renderCollapsed(threeBlocks);
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'blocks[1]', message: 'The whole block is invalid' }] });
  const blocks = [...form.querySelectorAll('.block-item')];
  assert.equal(blocks[1].querySelector('.block-problem-badge')?.textContent, '1 problem', 'control: the block is badged');
  form.querySelector('.entry-problem-link').click();
  assert.ok(!blocks[1].classList.contains('collapsed'), 'the block is open');
  assert.ok(blocks[0].classList.contains('collapsed') && blocks[2].classList.contains('collapsed'), 'the others stay closed');
});

check('a whole-block summary line is disabled once that block is deleted', () => {
  const form = renderCollapsed(threeBlocks);
  showEntryProblems(form, { status: 'invalid', issues: [{ path: 'blocks[1]', message: 'The whole block is invalid' }] });
  const line = form.querySelector('.entry-problem-link');
  form.querySelectorAll('.block-item')[1].querySelector('.remove-block').click();
  assert.equal(form.querySelectorAll('.block-item').length, 2, 'control: the Delete Block button removed it');
  line.click();
  assert.equal(line.disabled, true);
});

// --- Top-level lists ------------------------------------------------------------
// An entry that IS a list (a JSON file holding an array) is validated as one,
// so its issue paths start at an item: '[1]', '[1].title', '' for the whole
// list. An inline list is drawn as one field named `items` (items[0], ...);
// a list of objects is cards under `_root`. The paths here come from the
// real validator (validateAgainstSchema on a real zod schema), not by hand.

const { z } = await import('zod');
const { validateAgainstSchema } = await import('../server/utils/content-validation.js');

async function topLevelListProblems(zodSchema, entry) {
  const jsonSchema = z.toJSONSchema(zodSchema);
  const validation = await validateAgainstSchema({ _zodSchema: zodSchema, schema: jsonSchema }, entry);
  const form = document.createElement('form');
  form.innerHTML = generateForm(jsonSchema, entry);
  document.body.appendChild(form);
  setupFormHandlers(form, () => {});
  return { form, validation };
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}\n   ${String(error.message).split('\n').join('\n   ')}`);
    failures.push(name);
  }
}

await checkAsync('a top-level inline list item\'s problem is marked on that item, and its summary line focuses it', async () => {
  const { form, validation } = await topLevelListProblems(z.array(z.string().min(1)), ['First', '', 'Third']);
  assert.deepEqual(validation.issues.map((issue) => issue.path), ['[1]'], 'control: the validator reports the item as [1]');
  const itemInput = form.querySelector('[name="items[1]"]');
  assert.ok(itemInput, 'control: the renderer names the item items[1]');
  assert.ok(findFieldForPath(form, '[1]') === itemInput, '[1] does not find items[1]');
  showEntryProblems(form, validation);
  assert.equal(itemInput.getAttribute('aria-invalid'), 'true', 'the item is not marked');
  assert.equal(form.querySelectorAll('.field-problem').length, 1, 'the message is not under the list');
  const line = form.querySelector('.entry-problems li button');
  assert.ok(line, 'the summary line is not a button');
  line.click();
  assert.ok(document.activeElement === itemInput, 'the item does not have focus');
  assert.equal(form.querySelector('[name="items[0]"]').getAttribute('aria-invalid'), null, 'control: another item is not marked');
});

await checkAsync('a whole top-level inline list\'s problem names it, without marking an object entry\'s `items` field', async () => {
  const { form } = await topLevelListProblems(z.array(z.string()), ['a']);
  assert.ok(findFieldForPath(form, '[3]') === form.querySelector('[data-field="items"]'), 'an item not rendered does not find its list');
  const objectForm = document.createElement('form');
  objectForm.innerHTML = generateForm({ type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } }, { items: ['a'] });
  assert.equal(findFieldForPath(objectForm, ''), null, 'a whole-entry problem on an object entry is not the items field');
});

const cardItem = z.object({ title: z.string().min(1), note: z.string().optional() });

await checkAsync('a top-level card list item\'s problem is marked on its card, and its summary line goes there', async () => {
  const { form, validation } = await topLevelListProblems(z.array(cardItem), [{ title: 'One' }, { title: '' }, { title: 'Three' }]);
  assert.deepEqual(validation.issues.map((issue) => issue.path), ['[1].title'], 'control: the validator reports [1].title');
  const cards = [...form.querySelectorAll('[data-field="_root"] .array-card')];
  assert.equal(cards.length, 3, 'control: three cards rendered');
  assert.ok(findFieldForPath(form, '[1].title') === cards[1], 'the problem does not find its card');
  showEntryProblems(form, validation);
  const message = form.querySelector('.field-problem');
  assert.ok(message, 'the problem is not marked on the list');
  assert.equal(message.textContent, `${describeIssuePath('[1].title')}: ${validation.issues[0].message}`, 'it names the card');
  const line = form.querySelector('.entry-problems li button');
  assert.ok(line, 'the summary line is not a button');
  assert.equal(line.textContent.startsWith('2 › Title'), true, line.textContent);
});

await checkAsync('a whole top-level card list\'s problem is marked on the list', async () => {
  const { form, validation } = await topLevelListProblems(z.array(cardItem).min(2), [{ title: 'One' }]);
  assert.deepEqual(validation.issues.map((issue) => issue.path), [''], 'control: the validator reports the whole list as ""');
  assert.ok(findFieldForPath(form, '') === form.querySelector('[data-array-cards][data-field="_root"]'), '"" does not find the card list');
  showEntryProblems(form, validation);
  assert.equal(form.querySelectorAll('.field-problem').length, 1);
});

console.log(`\n📊 ${passed} passed, ${failures.length} failed.`);
if (failures.length > 0) process.exitCode = 1;
