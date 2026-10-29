import { blankOptionalPaths } from './form-generator.js';

/**
 * The JSON body of an entry save.
 *
 * The markdown body is the entry's CONTENT, sent separately as `body`. Its
 * textarea carries no form `name` (only #markdown-body + data-content-field)
 * precisely so extractFormData/FormData don't sweep it into the frontmatter
 * `data`. A collection that legitimately declares a `body` frontmatter field
 * keeps it, because that field's own control IS named `body`.
 *
 * `body` is sent only when the form shows a body editor. A form without one
 * says nothing about the body, and the API then keeps the stored body; sending
 * '' instead deleted a page's prose whenever its editor did not show it.
 *
 * `blankOptionals` lists the "" values inside blocks at optional keys
 * (blankOptionalPaths): the server drops each one the site's own zod refuses
 * at exactly that path, and keeps the rest (#70).
 *
 * @param {HTMLFormElement} form - the entry's editor form
 * @param {Object} data - the frontmatter / data fields, from extractFormData
 * @param {'content'|'data'} type - the entry type
 * @returns {{data: Object, type: string, body?: string, blankOptionals?: string[]}}
 */
export function savePayload(form, data, type) {
  const payload = { data, type };
  const bodyField = form.querySelector('#markdown-body');
  if (bodyField) payload.body = bodyField.value;
  const blanks = blankOptionalPaths(data);
  if (blanks.length > 0) payload.blankOptionals = blanks;
  return payload;
}
