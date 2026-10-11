/**
 * Content problems: what the site's build would reject, shown in the editor.
 *
 * A save always writes (autosave must never lose a half-finished edit), and its
 * response carries `validation` — the stored entry checked against the site's
 * collection schema. This module shows that result on the form: a summary at
 * the top, plus a message under each field it can locate. Publish is gated by
 * the site's own Astro instead; renderPublishProblems shows its refusal.
 *
 * Issue paths use the editor's own field names ('blocks[1].title'), so a field
 * is found by its `name`, or for a block or array list by its container's
 * `data-field`. A path with neither (a whole block, a key the schema does not
 * render) is marked on the nearest ancestor that has one.
 */

import { formatLabel } from './form-generator.js';
import { entryDashboardPath } from './entry-urls.js';

const SUMMARY_CLASS = 'entry-problems';
const FIELD_MESSAGE_CLASS = 'field-problem';
const GROUP_PROBLEM_CLASS = 'has-problem';

/**
 * Human-readable location for an issue path ('blocks[1].title' -> 'Blocks › 2 › Title').
 * @param {string} issuePath
 * @returns {string}
 */
export function describeIssuePath(issuePath) {
  if (!issuePath) return 'This entry';
  const segments = issuePath.match(/[^.[\]]+/g) || [];
  return segments
    .map((segment) => (/^\d+$/.test(segment) ? String(Number(segment) + 1) : formatLabel(segment)))
    .join(' › ');
}

/**
 * The input (or block/array container) for an issue path, or for its nearest
 * ancestor that has one.
 * @param {HTMLFormElement} form
 * @param {string} issuePath
 * @returns {Element|null}
 */
export function findFieldForPath(form, issuePath) {
  let candidate = issuePath;
  while (candidate) {
    const escaped = CSS.escape(candidate);
    // Array, block, gallery and reference lists carry data-field on a
    // container inside their .form-group rather than a named input.
    const field = form.querySelector(`[name="${escaped}"]`)
      || form.querySelector(`[data-field="${escaped}"]`);
    if (field) return field;
    // Drop the last segment: 'blocks[1].title' -> 'blocks[1]' -> 'blocks'.
    const shorter = candidate.replace(/(\.[^.[\]]+|\[\d+\])$/, '');
    if (shorter === candidate) break;
    candidate = shorter;
  }
  return null;
}

// A list with too few items, as zod 4 and zod 3 word it.
const TOO_FEW_ITEMS = /^(?:Too small: expected array to have >=?(\d+) items?|Array must contain at least (\d+) element\(s\))$/;

/**
 * An issue's message, in terms of what the editor can do. A list with too few
 * items says how many it needs, and, when the schema lets the key be absent,
 * how to leave it out: an editor-emptied optional list is saved as not set
 * (form-generator's cleanEmptyValues), so adding an item and deleting it does
 * that, even for an empty list stored that way.
 * @param {{path: string, message: string}} issue
 * @param {?object} schema
 * @returns {string}
 */
export function adviseOn(issue, schema) {
  const match = TOO_FEW_ITEMS.exec(issue.message);
  if (!match) return issue.message;
  const count = Number(match[1] ?? match[2]);
  const needs = `Needs at least ${count} item${count === 1 ? '' : 's'}.`;
  return optionalAtPath(schema, issue.path)
    ? `${needs} Or leave it out: add an item and delete it, and it is saved as not set.`
    : needs;
}

/** A schema node without its null branch (`anyOf: [x, {type: 'null'}]`). */
function withoutNull(node) {
  const union = node?.anyOf || node?.oneOf;
  if (!Array.isArray(union) || node.type !== undefined) return node;
  const nonNull = union.filter((member) => member?.type !== 'null');
  return nonNull.length === 1 ? nonNull[0] : node;
}

/**
 * Whether the schema PROVES the key at an issue path optional: every step is
 * an object property or a list item it can follow. Anything it cannot follow
 * (a block, a union) is not proof.
 */
function optionalAtPath(schema, issuePath) {
  const segments = String(issuePath || '').match(/[^.[\]]+/g) || [];
  let node = withoutNull(schema);
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (/^\d+$/.test(segment)) {
      if (node?.type !== 'array' || node.blockTypes || last) return false;
      node = withoutNull(node.items);
      continue;
    }
    if (!node?.properties || !(segment in node.properties)) return false;
    if (last) return !(node.required || []).includes(segment);
    node = withoutNull(node.properties[segment]);
  }
  return false;
}

/** Remove every mark a previous showEntryProblems call left on the form. */
export function clearEntryProblems(form) {
  form.querySelectorAll(`.${SUMMARY_CLASS}, .${FIELD_MESSAGE_CLASS}`).forEach((el) => el.remove());
  form.querySelectorAll(`.${GROUP_PROBLEM_CLASS}`).forEach((el) => el.classList.remove(GROUP_PROBLEM_CLASS));
  form.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
}

/**
 * Show a save's validation result on its form. Clears the previous result
 * first, so a fixed entry loses its marks on the next save.
 * @param {HTMLFormElement} form
 * @param {{status: string, issues: Array<{path: string, message: string}>}|undefined} validation
 * @param {?object} [schema] - the entry's schema, for advice that depends on
 *   it (whether a too-short list may be left out instead)
 */
export function showEntryProblems(form, validation, schema = null) {
  clearEntryProblems(form);
  if (validation?.status !== 'invalid' || validation.issues.length === 0) return;
  const issues = validation.issues.map((issue) => ({ ...issue, message: adviseOn(issue, schema) }));

  const summary = document.createElement('div');
  summary.className = SUMMARY_CLASS;
  summary.setAttribute('role', 'alert');
  const intro = document.createElement('p');
  intro.textContent = 'Your changes are saved, but the site cannot be published until this is fixed:';
  summary.appendChild(intro);
  const list = document.createElement('ul');
  for (const issue of issues) {
    const item = document.createElement('li');
    item.textContent = `${describeIssuePath(issue.path)}: ${issue.message}`;
    list.appendChild(item);
  }
  summary.appendChild(list);
  form.prepend(summary);

  for (const issue of issues) {
    const field = findFieldForPath(form, issue.path);
    if (!field) continue; // the summary still names it
    if (field.matches('input:not([type="hidden"]), select, textarea')) {
      field.setAttribute('aria-invalid', 'true');
    }

    const group = field.closest('.form-group');
    if (!group) continue;
    group.classList.add(GROUP_PROBLEM_CLASS);
    const message = document.createElement('p');
    message.className = FIELD_MESSAGE_CLASS;
    // A message on an ancestor names which part of it is wrong.
    const fieldPath = field.getAttribute('name') ?? field.dataset.field;
    message.textContent = issue.path === fieldPath
      ? issue.message
      : `${describeIssuePath(issue.path)}: ${issue.message}`;
    group.appendChild(message);
  }
}

/**
 * The body of a refused publish: the site's own Astro rejected the content.
 * Shows why (the server's sentences for Astro's error codes) and the entries
 * it refused, each opening in the editor, with what AstroAdmin's own
 * validation finds wrong in it at the checked commit. Astro's output is not
 * in the response (it names server paths); it is in the server log.
 * @param {{message: string, check: {problems?: Array<{code: string|null, message: string}>,
 *   entries: Array<{collection: string, slug: string, locale?: string|null, editable: boolean,
 *   issues?: Array<{path: string, message: string, accepted?: string[]}>}>}}} refusal
 * @returns {HTMLElement}
 */
export function renderPublishProblems(refusal) {
  const container = document.createElement('div');
  container.className = 'publish-problems';

  const intro = document.createElement('p');
  intro.textContent = refusal.message;
  container.appendChild(intro);

  for (const problem of refusal.check?.problems || []) {
    const reason = document.createElement('p');
    reason.className = 'publish-problem';
    reason.textContent = problem.message;
    container.appendChild(reason);
  }

  const entries = refusal.check?.entries || [];
  if (entries.length > 0) {
    const list = document.createElement('ul');
    for (const entry of entries) {
      const item = document.createElement('li');
      const label = `${entry.collection}/${entry.slug}${entry.locale ? ` (${entry.locale})` : ''}`;
      // Only an entry the server matched to an editor slug can be opened.
      if (entry.editable) {
        const link = document.createElement('a');
        link.href = entryDashboardPath(entry.collection, entry.slug);
        link.dataset.collection = entry.collection;
        link.dataset.slug = entry.slug;
        link.textContent = label;
        item.appendChild(link);
      } else {
        item.textContent = label;
      }
      const issues = entry.issues || [];
      if (issues.length > 0) {
        const issueList = document.createElement('ul');
        for (const issue of issues) {
          const issueItem = document.createElement('li');
          const accepted = issue.accepted?.length ? ` Accepted: ${issue.accepted.join(', ')}.` : '';
          issueItem.textContent = `${issue.path ? `${describeIssuePath(issue.path)}: ` : ''}${issue.message}${accepted}`;
          issueList.appendChild(issueItem);
        }
        item.appendChild(issueList);
      }
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  return container;
}
