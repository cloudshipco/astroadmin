/**
 * Whether a value is a plain object: not null, not an array. The one test the
 * image metadata routes (server/api/images.js) and the doctor
 * (server/doctor/project.js) apply to a parsed `.metadata.json` and its
 * entries before reading keys from it.
 * @param {unknown} value
 * @returns {value is object}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
