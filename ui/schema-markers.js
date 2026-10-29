/**
 * The JSON Schema keywords the schema parser (server/utils/schema-parser.js)
 * adds to a collection's schema, and the editor (ui/form-generator.js) and
 * the server read back. One definition, shared by both sides as
 * ui/media-kinds.js is, so a rename on one side cannot silently turn a marked
 * field back into a plain one on the other.
 */

/**
 * Astro's image(). A keyword of its own, not a description:
 * `image().describe('Portrait')` replaced the old 'Image path' description,
 * and the field lost its image() handling. zod 4 keeps it through
 * .describe(), .optional() and .nullable() (meta is merged); zod 3 gets it
 * from the stand-in's _def (markZod3StandIns).
 */
export const IMAGE_MARKER = 'x-astroadmin-image';

/**
 * A REAL date (z.date(), z.coerce.date()), as opposed to a string that only
 * has a date format (zod 4 z.iso.date(), zod 3 z.string().date()). Both
 * serialise as `format: 'date'`, but only a real date may be written to
 * frontmatter as an unquoted YAML date: the string forms refuse a Date.
 */
export const DATE_MARKER = 'x-astroadmin-date';

/**
 * A file() collection's top-level `id`. The store writes a file() entry under
 * the id it was opened or created with (renaming it would orphan the entry and break references to
 * it), so the form shows this field read-only rather than as a box whose
 * edits are silently dropped (#72). A glob() entry's `id`-named field is
 * ordinary data and is not marked.
 */
export const ENTRY_ID_MARKER = 'x-astroadmin-entry-id';
