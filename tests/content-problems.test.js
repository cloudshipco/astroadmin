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

console.log(`\n📊 ${passed} passed, ${failures.length} failed.`);
if (failures.length > 0) process.exitCode = 1;
