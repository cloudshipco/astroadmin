/**
 * HTML escaping — one implementation for every UI module.
 *
 * The UI builds its markup with template literals, so a value can land in element
 * text (<div>${x}</div>) or in an attribute (src="${x}"). This escapes quotes as
 * well as angle brackets, which makes it correct in both.
 *
 * Do NOT reach for the `div.textContent = x; return div.innerHTML` trick that
 * several of these modules used to carry: it does not escape " or ', so a value
 * interpolated into an attribute can close it and inject markup.
 */

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
