/**
 * The block lists of a collection schema, in the shape the editor's form renders.
 */

/**
 * Convert discriminatedUnions to blockTypes format on schema fields
 * This bridges the zod-to-json-schema output to what form-generator expects.
 * Shared by the collections API (the editor's form) and the doctor, which
 * renders the same form to learn an entry's control names.
 */
export function enrichSchemaWithBlockTypes(schema, discriminatedUnions) {
  if (!discriminatedUnions || discriminatedUnions.length === 0) {
    return schema;
  }

  // Deep clone to avoid mutations
  const enriched = JSON.parse(JSON.stringify(schema));

  for (const union of discriminatedUnions) {
    // Navigate to the field at the union path
    let target = enriched;
    const pathToField = union.path.filter(p => p !== '[]'); // Remove array markers

    for (const key of pathToField) {
      if (target?.properties?.[key]) {
        target = target.properties[key];
      } else {
        target = null;
        break;
      }
    }

    if (target && target.type === 'array') {
      // Convert options to blockTypes format
      const blockTypes = {};
      for (const option of union.options) {
        blockTypes[option.value] = option.schema || { type: 'object', properties: {} };
      }
      target.blockTypes = blockTypes;
    }
  }

  return enriched;
}
