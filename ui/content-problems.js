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
 */
export function showEntryProblems(form, validation) {
  clearEntryProblems(form);
  if (validation?.status !== 'invalid' || validation.issues.length === 0) return;

  const summary = document.createElement('div');
  summary.className = SUMMARY_CLASS;
  summary.setAttribute('role', 'alert');
  const intro = document.createElement('p');
  intro.textContent = 'Your changes are saved, but the site cannot be published until this is fixed:';
  summary.appendChild(intro);
  const list = document.createElement('ul');
  for (const issue of validation.issues) {
    const item = document.createElement('li');
    item.textContent = `${describeIssuePath(issue.path)}: ${issue.message}`;
    list.appendChild(item);
  }
  summary.appendChild(list);
  form.prepend(summary);

  for (const issue of validation.issues) {
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
 * Lists the entries Astro named (each opens in the editor) and its output.
 * @param {{message: string, check: {output: string, entries: Array<{collection: string, slug: string, editable: boolean}>}}} refusal
 * @returns {HTMLElement}
 */
export function renderPublishProblems(refusal) {
  const container = document.createElement('div');
  container.className = 'publish-problems';

  const intro = document.createElement('p');
  intro.textContent = refusal.message;
  container.appendChild(intro);

  const entries = refusal.check?.entries || [];
  if (entries.length > 0) {
    const list = document.createElement('ul');
    for (const entry of entries) {
      const item = document.createElement('li');
      const label = `${entry.collection}/${entry.slug}`;
      // Only an entry the server matched to an editor slug can be opened.
      if (entry.editable) {
        const link = document.createElement('a');
        link.href = `/dashboard/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.slug)}`;
        link.dataset.collection = entry.collection;
        link.dataset.slug = entry.slug;
        link.textContent = label;
        item.appendChild(link);
      } else {
        item.textContent = label;
      }
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  if (refusal.check?.output) {
    const details = document.createElement('details');
    // Open when there is no entry to point at: the output is all there is.
    details.open = entries.length === 0;
    const summary = document.createElement('summary');
    summary.textContent = "The site's build said";
    const output = document.createElement('pre');
    output.textContent = refusal.check.output;
    details.append(summary, output);
    container.appendChild(details);
  }

  return container;
}
