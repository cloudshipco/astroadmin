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
 * @param {HTMLFormElement} form - the entry's editor form
 * @param {Object} data - the frontmatter / data fields, from extractFormData
 * @param {'content'|'data'} type - the entry type
 * @returns {{data: Object, type: string, body?: string}}
 */
export function savePayload(form, data, type) {
  const payload = { data, type };
  const bodyField = form.querySelector('#markdown-body');
  if (bodyField) payload.body = bodyField.value;
  return payload;
}
