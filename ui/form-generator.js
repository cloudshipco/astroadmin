/**
 * Form Generator
 * Auto-generates forms from schema definitions
 * Supports blocks (discriminated unions) with type-based fields
 *
 * generateField is the single renderer for every field, everywhere: the main
 * editor form, block bodies, and the array item modal all go through it, so a
 * widget added here shows up on all three.
 */

import { setupFieldWidgets, decodeGalleryValue, resolveImageUrl, isPreviewableImage, isPreviewableVideo, setWidgetValue, CLEARED_ATTRIBUTE, colorToHex, colourSwatchTitle, COLOUR_NONE_ATTRIBUTE, COLOUR_CLEAR_BUTTON } from './field-widgets.js';

import { escapeHtml, textareaContent } from './escape-html.js';
// The keywords the schema parser marks a real date, a file() entry's id and
// Astro's image() with (shared with the server).
import { DATE_MARKER, ENTRY_ID_MARKER, IMAGE_MARKER } from './schema-markers.js';

/**
 * Serialise a value into an HTML attribute as JSON.
 *
 * Must be used for EVERY JSON-in-an-attribute site. Interpolating raw
 * JSON.stringify output into an attribute is a data-loss bug, not a style one:
 * an apostrophe in the content ("O'Brien", "we'll") ends a single-quoted
 * attribute early, so the value the browser hands back is truncated, JSON.parse
 * throws, and extractFields falls back to [] — silently wiping the whole array
 * on the next save. Escaping & first also keeps a literal &quot; in the content
 * from being decoded into a real quote on the way back out.
 */
function jsonAttr(value) {
  return escapeHtml(JSON.stringify(value));
}

/**
 * Generate a form from schema
 * Handles both object schemas (most common) and top-level array schemas
 */
export function generateForm(schema, data = {}) {
  // Handle top-level array schemas (e.g., z.array(z.object({...})))
  // These are collections where the entire file is an array of items
  if (schema.type === 'array' && schema.items) {
    return generateTopLevelArrayForm(schema, data);
  }

  const formHtml = [];
  const hiddenHtml = [];
  const carriedAlts = carriedOverAlts(schema.properties || {}, data || {});

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties || {})) {
    const carried = carriedAlts.get(fieldName);
    const value = carried ? carried.value : data[fieldName];

    // Hidden fields are rendered as hidden inputs to preserve data. JSON-encode
    // every value, not just objects: a hidden input has no type to read back, so a
    // plain-string encoding would return a number or boolean as "4" / "true".
    if (fieldSchema.hidden) {
      if (value !== undefined && value !== null) {
        hiddenHtml.push(`<input type="hidden" name="${fieldName}" value="${jsonAttr(value)}" data-json="true">`);
      }
      continue;
    }

    const fieldHtml = generateField(fieldName, fieldSchema, value, '', {
      siblingData: data,
      siblingProps: schema.properties,
      originalPath: carried?.from ?? null,
    });
    formHtml.push(fieldHtml);
  }

  // Add hidden fields at the start
  return hiddenHtml.join('\n') + '\n' + formHtml.join('\n');
}

/**
 * Render every property of an object schema.
 * The shared entry point for anything that renders a set of fields — used by the
 * main form, nested objects, block bodies, and the array item modal.
 *
 * @param {object} properties - Schema properties map
 * @param {object} data - Values for those properties
 * @param {object} [options]
 * @param {string} [options.path] - Path prefix for input names ('' = top level)
 * @param {string} [options.idPrefix] - Prefix for element ids, so fields rendered
 *   into a modal don't collide with same-named fields on the form behind it
 * @param {string[]} [options.skip] - Property names to leave out
 * @param {string} [options.pickerVariant] - Size variant for any image picker in these
 *   fields: 'thumb' (a 70px square in a tight inline row) or 'compact' (a shorter
 *   preview for the item modal, whose body scrolls). Empty for the full-size default.
 */
export function generateFields(properties, data = {}, options = {}) {
  const { path = '', idPrefix = '', skip = [], pickerVariant = '' } = options;
  if (!properties) return '';

  const carriedAlts = carriedOverAlts(properties, data || {});
  return Object.entries(properties)
    .filter(([key]) => !skip.includes(key))
    .map(([key, schema]) => {
      const carried = carriedAlts.get(key);
      return generateField(key, schema, carried ? carried.value : data?.[key], path, {
        siblingData: data || {},
        siblingProps: properties,
        idPrefix,
        pickerVariant,
        originalPath: carried ? (path ? `${path}.${carried.from}` : carried.from) : null,
      });
    })
    .join('\n');
}

/**
 * Alt text an entry holds under the image picker's old built-in key
 * (`bannerImageAlt`), for an image whose alt the schema now declares under
 * another name (`bannerAlt`, #88). The built-in box is gone for such an
 * image, so the text had no control and the next save dropped it. While the
 * declared alt is empty, its control shows the old text and is bound to the
 * old key (data-original-path): left alone it saves that text, so the first
 * save moves it to the declared key.
 * @returns {Map<string, {value: string, from: string}>} declared alt key ->
 *   the text and the key it was stored under
 */
function carriedOverAlts(properties, data) {
  const carried = new Map();
  for (const [name, schema] of Object.entries(properties)) {
    const fieldSchema = unwrapNullable(schema || {});
    if (fieldSchema.type === 'object' || fieldSchema.type === 'array' || !isImageField(name, fieldSchema)) continue;
    const declared = findAltProperty(name, properties);
    const builtinKey = `${name}Alt`;
    if (!declared || declared === builtinKey || carried.has(declared)) continue;
    const oldText = data[builtinKey];
    const current = data[declared];
    if (typeof oldText !== 'string' || oldText === '') continue;
    if (current !== undefined && current !== null && current !== '') continue;
    carried.set(declared, { value: oldText, from: builtinKey });
  }
  return carried;
}

/**
 * The key a top-level list is rendered and bound under. A form's controls are
 * named by path from an object, so a list whose items are edited inline (see
 * generateTopLevelArrayForm) is drawn as this one field, `items[0]`, `items[1]`,
 * and extractFormData unwraps it again. bindOriginalValues wraps a stored list
 * the same way, so its paths find the stored items.
 */
export const TOP_LEVEL_LIST_KEY = 'items';

/**
 * Whether a top-level list is edited inline, as the same list would be as a
 * field: any list whose items are not objects (strings, numbers, booleans,
 * unions of them, nested lists; nullable or not). Only object items are cards,
 * since the item modal draws an item's properties and has none to draw for
 * anything else.
 * @param {object} schema - the collection's JSON Schema
 */
function isInlineTopLevelList(schema) {
  if (schema?.type !== 'array' || !schema.items) return false;
  return unwrapNullable(schema.items).type !== 'object';
}

/** The object schema an inline top-level list is rendered and read as. */
function topLevelListWrapper(schema) {
  return { type: 'object', properties: { [TOP_LEVEL_LIST_KEY]: schema }, required: [TOP_LEVEL_LIST_KEY] };
}

/**
 * Generate a form for top-level array schemas
 * The entire content is an array of items. A list whose items are not objects
 * is the same inline list such a field is (generateField), one control per
 * item: an object card's item modal has no fields to show for a string, and
 * saved it as an object (#34). A list of objects is object cards.
 */
function generateTopLevelArrayForm(schema, data) {
  const items = Array.isArray(data) ? data : [];
  if (isInlineTopLevelList(schema)) {
    return generateField(TOP_LEVEL_LIST_KEY, schema, items);
  }
  const itemSchema = schema.items || {};

  // Use the array card UI for complex items
  return `
    <div class="form-group">
      <div class="array-cards"
           data-array-cards
           data-field="_root"
           data-field-name="Items"
           data-schema="${jsonAttr(itemSchema)}"
           data-top-level-array="true">
        ${items.map((item, index) => generateArrayCard(item, index, itemSchema)).join('')}
      </div>
      <button type="button" class="btn btn-secondary btn-sm array-cards-add" data-add-array-card>
        + Add Item
      </button>
      <input type="hidden" name="_root" data-array-data data-top-level-array="true" value="${jsonAttr(items)}">
    </div>
  `;
}

/**
 * Render a nullable field as its non-null type.
 *
 * A nullable reaches the editor in two shapes, and both converters use both:
 * `{anyOf: [<type>, {type: 'null'}]}` (an object, an enum, an integer), which
 * carries no top-level `type`, and `{type: [<type>, 'null']}` (zod 3 and zod 4
 * for a plain number, boolean or string). Unwrapped, a nullable integer,
 * boolean or date no longer falls through to the textarea. Any other union is
 * returned unchanged.
 * @param {object} schema - a field's JSON Schema
 * @returns {object}
 */
export function unwrapNullable(schema) {
  const nullableType = nullableTypeName(schema);
  if (nullableType !== null) return { ...schema, type: nullableType };
  const union = schema?.anyOf || schema?.oneOf;
  if (!Array.isArray(union) || schema.type !== undefined) return schema || {};
  const nonNull = union.filter((member) => member?.type !== 'null');
  if (nonNull.length !== 1 || nonNull.length === union.length) return schema;
  const { anyOf, oneOf, ...rest } = schema;
  return { ...nonNull[0], ...rest };
}

/**
 * The one non-null type of a `type: [<type>, 'null']` schema, or null for any
 * other schema.
 * @param {object} schema
 * @returns {?string}
 */
function nullableTypeName(schema) {
  if (!Array.isArray(schema?.type)) return null;
  const nonNull = schema.type.filter((type) => type !== 'null');
  return nonNull.length === 1 && nonNull.length !== schema.type.length ? nonNull[0] : null;
}

/**
 * Whether a field's schema is a nullable one that unwrapNullable unwraps: a
 * union of exactly one type and `null`, in either shape.
 */
function isNullableSchema(schema) {
  if (nullableTypeName(schema) !== null) return true;
  const union = schema?.anyOf || schema?.oneOf;
  if (!Array.isArray(union) || schema.type !== undefined) return false;
  const nonNull = union.filter((member) => member?.type !== 'null');
  return nonNull.length === 1 && nonNull.length !== union.length;
}

// A timestamp with no zone, as YAML and the serialiser's parseTimestamp read it: UTC.
const ZONELESS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * A stored date value as a Date. A zoneless timestamp is UTC, as the server
 * reads it; `new Date()` alone would read it as the browser's local time, so
 * each save of a JSON entry moved it by the browser's offset.
 */
function parseStoredDate(value) {
  if (value instanceof Date) return value;
  const text = String(value);
  return new Date(ZONELESS_TIMESTAMP.test(text) ? `${text.replace(' ', 'T')}Z` : text);
}

/**
 * The values a NEW entry's form starts with: its entry id, when the schema
 * declares one (a file() entry is saved under the name chosen in the "Create
 * New" dialog, so its read-only id field shows that name). The id, as Astro
 * reads `id ?? slug`: a marked `slug` only when there is no marked `id`, so
 * a slug beside an id stays the editor's to fill. Empty otherwise.
 * @param {object} schema - the collection's schema
 * @param {string} entryName - the slug the new entry is created as
 */
export function newEntryValues(schema, entryName) {
  const properties = schema?.properties || {};
  const identityKey = ['id', 'slug'].find((key) => properties[key]?.[ENTRY_ID_MARKER] === true);
  return identityKey ? { [identityKey]: entryName } : {};
}

/**
 * Whether a field is the entry's identity, shown read-only: a field the
 * parser marks (ENTRY_ID_MARKER, a file() collection's top-level `id` or
 * `slug`), except a `slug` in an entry that has an id. Astro keys that entry
 * by its id, so its slug is ordinary data. A marked `id` is always read-only,
 * even when empty: an id typed into a slug-keyed entry would re-key it, and
 * the store keeps the stored one.
 * @param {string} name - the field's own name
 * @param {object} schema - the field's schema, nullable unwrapped
 * @param {object} siblingData - the values beside it (the entry's, at the top level)
 */
function isEntryIdentityField(name, schema, siblingData) {
  if (schema[ENTRY_ID_MARKER] !== true) return false;
  if (name !== 'slug') return true;
  return siblingData.id === undefined || siblingData.id === null;
}

/** JSON Schema numeric types: zod's z.number() is 'number', .int() is 'integer'. */
function isNumericType(type) {
  return type === 'number' || type === 'integer';
}

/**
 * A value as the text a textarea or text input shows. Anything that is not a
 * string (a number in a field the schema calls text, an object in a field whose
 * type the parser could not represent) must not crash the whole entry.
 */
function displayText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Generate a single field
 * @param {string} name - Field name
 * @param {object} schema - Field schema
 * @param {any} value - Field value
 * @param {string} path - Parent path prefix
 * @param {object} [ctx] - Render context
 * @param {object} [ctx.siblingData] - Values of the sibling fields (e.g. to find existing alt text)
 * @param {object} [ctx.siblingProps] - Schema of the sibling fields (e.g. to detect an explicit alt field)
 * @param {string} [ctx.idPrefix] - Prefix for the element id
 */
function generateField(name, rawSchema, value, path = '', ctx = {}) {
  const { siblingData = {}, siblingProps = null, idPrefix = '', pickerVariant = '', originalPath = null } = ctx;
  // Where this control's stored value lives, when not at its own path (see
  // carriedOverAlts): what an untouched control saves.
  const originalPathAttribute = originalPath ? `data-original-path="${escapeHtml(originalPath)}"` : '';
  const schema = unwrapNullable(rawSchema);
  const fullPath = path ? `${path}.${name}` : name;
  const id = idPrefix + fullPath.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
  // A nullable field renders as its non-null type, whose empty control would
  // save ''. `data-nullable` lets extractFields save null for a control the
  // editor CLEARED (see nullableControlValue). An untouched null needs nothing:
  // an untouched control saves its stored value (bindOriginalValues).
  const nullable = isNullableSchema(rawSchema);
  const nullableAttributes = nullable ? 'data-nullable' : '';

  // A `const` (Zod's z.literal) is fixed by the schema, so it is not a decision
  // an editor can make — and this UI is for non-technical people, who gain
  // nothing from a box they are told they may not touch. Render nothing visible.
  //
  // It still has to exist in the DOM: extractFields reads the submitted values
  // out of the form via `new FormData(container)`, so a field with no control at
  // all would be dropped from the entry on the next save. A single-entry file()
  // collection is found by its `id`, so losing it would orphan the entry and
  // fail the consuming site's build. A hidden input carries the value through
  // untouched while showing the editor nothing. `data-schema-const` marks it as
  // the schema's value, never the editor's: it does not count towards whether a
  // container is unchanged, and on an edited entry a value STORED at its path
  // is kept (bindOriginalValues, `constants`).
  if (schema.const !== undefined) {
    return `<input type="hidden" name="${fullPath}" id="${id}" value="${escapeHtml(String(schema.const))}" data-schema-const>`;
  }

  // A file() entry's id (or the slug it is keyed by) is fixed: the store
  // writes the entry under the identity it was opened or created with, so an
  // editable box would take an edit the save then drops (#72). Shown
  // read-only, so the editor can see it, and still named, so it is read back
  // like any other control.
  if (isEntryIdentityField(name, schema, siblingData)) {
    const hintId = `${id}_hint`;
    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${getFieldLabel(name, schema)}</label>
        <input
          type="${isNumericType(schema.type) ? 'number' : 'text'}"
          name="${fullPath}"
          id="${id}"
          value="${escapeHtml(displayText(value))}"
          class="form-input"
          readonly
          aria-describedby="${hintId}"
        >
        <span id="${hintId}" class="form-help form-help-after">Set when the entry was created. It cannot be changed here, because other content may refer to the entry by it.</span>
      </div>
    `;
  }

  // Handle blocks array (discriminated union)
  if (schema.type === 'array' && schema.blockTypes) {
    return generateBlocksField(name, schema, value, fullPath, idPrefix);
  }

  if (schema.type === 'object') {
    const nestedData = value || {};
    return `
      <div class="mb-6">
        <fieldset class="nested-fieldset" data-object-field="${fullPath}">
          <legend class="text-sm font-semibold text-gray-700 mb-3">${getFieldLabel(name, schema)}</legend>
          <div class="space-y-4">
            ${generateFields(schema.properties, nestedData, { path: fullPath, idPrefix, pickerVariant })}
          </div>
        </fieldset>
      </div>
    `;
  }

  // A reference to another collection: one id (reference('c')) or a list of
  // them (z.array(reference('c')), `<name>Ids`).
  const refCollection = detectReferenceCollection(schema);
  if (refCollection) {
    return generateReferenceField(name, schema, value, fullPath, id, refCollection, nullableAttributes);
  }

  if (schema.type === 'array') {
    // Check if this is a gallery field (array of objects with 'src' property)
    if (isGalleryField(schema)) {
      return generateGalleryField(name, schema, value, fullPath, id);
    }

    // Check if this is an object array (2+ properties) - use card view with modal editing
    const itemProps = schema.items?.properties || {};
    const isComplexArray = schema.items?.type === 'object' && Object.keys(itemProps).length >= 2;

    if (isComplexArray) {
      const items = Array.isArray(value) ? value : [];

      return `
        <div class="form-group">
          <label class="form-label">${getFieldLabel(name, schema)}</label>
          <div class="array-cards"
               data-array-cards
               data-field="${fullPath}"
               data-field-name="${getFieldLabel(name, schema)}"
               data-schema="${jsonAttr(schema.items || {})}">
            ${items.map((item, index) => generateArrayCard(item, index, schema.items)).join('')}
          </div>
          <button type="button" class="btn btn-secondary btn-sm array-cards-add" data-add-array-card>
            + Add ${escapeHtml(fieldLabelText(name, schema).replace(/s$/, ''))}
          </button>
          <input type="hidden" name="${fullPath}" data-array-data value="${jsonAttr(items)}">
        </div>
      `;
    }

    // Simple array of items (inline editing) - card-style layout
    const items = Array.isArray(value) ? value : [];
    const singularName = name.endsWith('s') ? name.slice(0, -1) : name;
    return `
      <div class="form-group">
        <label class="form-label">${getFieldLabel(name, schema)}</label>
        <div class="array-field" data-field="${fullPath}" data-array-items data-schema="${jsonAttr(schema.items || {})}"${idPrefixAttribute(idPrefix)}>
          ${items.map((item, index) => `
            <div class="array-item" data-index="${index}" draggable="true">
              <div class="array-item-handle" title="Drag to reorder">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="9" cy="5" r="2"/><circle cx="15" cy="5" r="2"/>
                  <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
                  <circle cx="9" cy="19" r="2"/><circle cx="15" cy="19" r="2"/>
                </svg>
              </div>
              <div class="array-item-content">
                ${generateArrayItem(fullPath, schema.items, item, index, idPrefix)}
              </div>
              <div class="array-item-actions">
                <button type="button" class="array-item-btn array-item-delete remove-array-item" title="Delete">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          `).join('\n')}
          <button type="button" class="btn btn-secondary btn-sm add-array-item w-full text-center" data-field="${fullPath}">
            + Add ${schema.label ? escapeHtml(fieldLabelText(name, schema).replace(/s$/, '')) : formatLabel(singularName)}
          </button>
        </div>
      </div>
    `;
  }

  // A nullable boolean has three states, so it is a select, not a checkbox:
  // "Not set" (null), Yes, No. extractFields reads data-value-type back.
  if (schema.type === 'boolean' && nullable) {
    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${getFieldLabel(name, schema)}</label>
        ${nullableBooleanSelect(fullPath, value, `id="${id}" class="form-input"`)}
      </div>
    `;
  }

  if (schema.type === 'boolean') {
    return `
      <div class="form-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            name="${fullPath}"
            id="${id}"
            ${value ? 'checked' : ''}
          >
          <span>${getFieldLabel(name, schema)}</span>
        </label>
      </div>
    `;
  }

  // `integer` (z.number().int()) as well as `number`: the element must be
  // type="number" for extractFields to save a number rather than the string "4".
  if (isNumericType(schema.type)) {
    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
        <input
          type="number"
          name="${fullPath}"
          id="${id}"
          value="${escapeHtml(nullable && value === null ? '' : value ?? schema.default ?? '')}"
          class="form-input"
          ${nullableAttributes}
          ${schema.type === 'integer' ? 'step="1"' : 'step="any"'}
          ${numberBound('min', schema.minimum)}
          ${numberBound('max', schema.maximum)}
          ${schema.placeholder ? `placeholder="${escapeHtml(schema.placeholder)}"` : ''}
          ${schema.required ? 'required' : ''}
        >
      </div>
    `;
  }

  // Handle enum/select
  if (schema.enum) {
    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${getFieldLabel(name, schema)}</label>
        <select name="${fullPath}" id="${id}" class="form-input" ${nullableAttributes}>
          ${nullable ? `<option value="" ${value === null || value === undefined ? 'selected' : ''}>Not set</option>` : ''}
          ${schema.enum.map(opt => `
            <option value="${escapeHtml(opt)}" ${value === opt ? 'selected' : ''}>${escapeHtml(formatLabel(opt))}</option>
          `).join('')}
        </select>
      </div>
    `;
  }

  // A video before a colour: `backgroundVideo` would otherwise be a colour
  // field (any name containing `background`). Only a name ENDING in video is
  // one, so `videoImage` and `videoSrc` stay images. No alt input: a
  // background video is decorative, and anything it says belongs in text.
  if (isVideoField(name, schema)) {
    return generateImageField(name, schema, value, fullPath, id, '', true, pickerVariant, nullableAttributes, 'video');
  }

  // Check if this is an image field
  if (isImageField(name, schema)) {
    // The picker offers its own alt input named `<field>Alt`. If the schema already
    // declares that property it gets rendered as a field in its own right, so the
    // built-in one has to stand down — two inputs sharing a name means whichever
    // renders last silently wins.
    const explicitAlt = findAltProperty(name, siblingProps);
    const altValue = siblingData[`${name}Alt`] || siblingData[`${name}_alt`] || '';
    return generateImageField(name, schema, value, fullPath, id, altValue, Boolean(explicitAlt), pickerVariant, nullableAttributes);
  }

  // Check if this is a color field
  if (isColorField(name, schema)) {
    return generateColorField(name, schema, value, fullPath, id, nullableAttributes);
  }

  // Check if this is a date field by name or schema
  const lowerName = name.toLowerCase();
  const dateFieldNames = ['createdat', 'updatedat', 'publishedat', 'date', 'pubdate', 'publishdate', 'modifiedat', 'modifieddate'];
  const isDateByName = dateFieldNames.some(d => lowerName === d || lowerName.endsWith(d));
  const isDateField = schema.format === 'date' || schema.format === 'date-time' || isDateByName;

  // Default: string input (with date detection). zod 4 serialises .url() as
  // format 'uri'.
  const inputType = schema.format === 'email' ? 'email' :
                    (schema.format === 'url' || schema.format === 'uri') ? 'url' :
                    isDateField ? 'date' : 'text';

  // Date fields use a date input; a value with a time of day uses a datetime
  // input instead, or editing the day would drop the time. Both show UTC: the
  // serialiser reads a zoneless timestamp as UTC, as YAML does, and
  // extractFields gives a datetime input's value back its zone (dateControlValue).
  // An unedited control saves its stored text as it was (its zone, sub-millisecond
  // digits and spelling), because an untouched control saves its stored value.
  if (isDateField) {
    let formattedValue = value ?? '';
    let dateInputType = 'date';
    let stepAttribute = '';
    // A date-time STRING (z.iso.datetime()) always needs a time: a date input
    // would save YYYY-MM-DD, which it refuses. A real z.date() is not one, even
    // though zod 3 serialises it as format date-time: it takes a date-only
    // value, and forcing a time made changing only the day write midnight UTC.
    const timeRequired = schema.format === 'date-time' && schema[DATE_MARKER] !== true;
    if (timeRequired) dateInputType = 'datetime-local';
    if (formattedValue) {
      const dateObj = parseStoredDate(formattedValue);
      if (!isNaN(dateObj.getTime())) {
        const iso = dateObj.toISOString();
        const time = iso.slice(11, 19);
        const milliseconds = dateObj.getUTCMilliseconds();
        if (time === '00:00:00' && milliseconds === 0 && !timeRequired) {
          formattedValue = iso.slice(0, 10);
        } else {
          dateInputType = 'datetime-local';
          if (milliseconds !== 0) {
            formattedValue = iso.slice(0, 23);
            stepAttribute = 'step="0.001"';
          } else {
            formattedValue = `${iso.slice(0, 10)}T${time.endsWith(':00') ? time.slice(0, 5) : time}`;
            if (!time.endsWith(':00')) stepAttribute = 'step="1"';
          }
        }
      }
    }
    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
        <input
          type="${dateInputType}"
          name="${fullPath}"
          id="${id}"
          value="${escapeHtml(formattedValue)}"
          class="form-input"
          ${stepAttribute}
          ${nullableAttributes}
          ${schema.required ? 'required' : ''}
        >
      </div>
    `;
  }

  // Large text field for long content
  // Default to textarea unless:
  // - maxLength is short (under 100 chars), OR
  // - the format is a one-line one (an email address or a URL), OR
  // - field name suggests it's a short field (title, link, etc.). A name
  //   matches exactly or as a suffix (`jobTitle`, `contactEmail`, `homeCity`).
  // The default for any other string stays a textarea: making it an input
  // would shrink long-text fields on existing sites.
  const shortFieldNames = [
    'text', 'link', 'href', 'url', 'title', 'heading', 'name', 'label', 'icon', 'value', 'number', 'alt',
    // One-line values: people, places, contact details, identifiers.
    'role', 'position', 'company', 'organisation', 'organization', 'location', 'city', 'country',
    'email', 'phone', 'website', 'slug', 'author', 'tag', 'category',
  ];
  // An identifier (`id`, `authorId`, `author_id`) is one line too. Matched on
  // the original case so a word merely ending in "id" (`paid`) is not caught.
  const isIdentifier = /^id$|Id$|_id$/.test(name);
  const isShortByName = isIdentifier || shortFieldNames.some(short => lowerName === short || lowerName.endsWith(short));
  const isShortByLength = schema.maxLength && schema.maxLength < 100;
  const isShortByFormat = ['email', 'url', 'uri'].includes(schema.format);
  const isLongByName = lowerName.includes('description') || lowerName.includes('content') || lowerName.includes('subheading');
  // An explicit `.describe('textarea')` forces a textarea even for a normally
  // short-named field (e.g. a long `title`). This only ever adds a textarea, so
  // it can't shrink a field that was one before.
  const wantsTextarea = /\btextarea\b/i.test(schema.description || '');
  const guessedTextarea = wantsTextarea || (!isShortByLength && !isShortByName && !isShortByFormat) || isLongByName;
  // The site's own say (zod 4 `.meta({ multiline })`) beats the guess, except
  // that a stored value holding a line break stays a textarea: an input would
  // drop the break on the first edit.
  const content = displayText(value);
  const multiline = typeof schema.multiline === 'boolean' ? schema.multiline : guessedTextarea;

  if (multiline || content.includes('\n')) {
    // Sized to the content, two rows at least (#87): a four-row floor made
    // every short value (`Photo: A. Person`) a tall box. autoGrowTextarea
    // grows it as the editor types.
    const lineCount = (content.match(/\n/g) || []).length + 1;
    const charBasedRows = Math.ceil(content.length / 60); // ~60 chars per line
    const initialRows = Math.max(2, Math.min(16, Math.max(lineCount, charBasedRows)));

    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
        <div class="textarea-wrapper">
          <textarea
            name="${fullPath}"
            id="${id}"
            rows="${initialRows}"
            class="form-input textarea-autogrow"
            ${nullableAttributes}
            ${originalPathAttribute}
            ${schema.placeholder ? `placeholder="${escapeHtml(schema.placeholder)}"` : ''}
            ${schema.required ? 'required' : ''}
          >${textareaContent(content)}</textarea>
          <button type="button" class="textarea-expand-btn" data-expand-textarea title="Expand editor">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 3 21 3 21 9"></polyline>
              <polyline points="9 21 3 21 3 15"></polyline>
              <line x1="21" y1="3" x2="14" y2="10"></line>
              <line x1="3" y1="21" x2="10" y2="14"></line>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  // Default text/email/url input
  return `
    <div class="form-group">
      <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
      <input
        type="${inputType}"
        name="${fullPath}"
        id="${id}"
        value="${escapeHtml(displayText(value))}"
        class="form-input"
        ${nullableAttributes}
        ${originalPathAttribute}
        ${schema.placeholder ? `placeholder="${escapeHtml(schema.placeholder)}"` : ''}
        ${schema.required ? 'required' : ''}
      >
    </div>
  `;
}

/**
 * A nullable boolean's control, a field's or a list item's: three states, so a
 * select rather than a checkbox. "Not set" (null), Yes, No; extractFields reads
 * data-value-type back, and data-nullable makes a cleared one save null.
 * @param {string} fullPath - the control's name
 * @param {*} value - the stored value
 * @param {string} attributes - the rest of the element's attributes (id, class)
 */
function nullableBooleanSelect(fullPath, value, attributes) {
  const current = value === true ? 'true' : value === false ? 'false' : '';
  return `
        <select name="${fullPath}" ${attributes} data-value-type="boolean" data-nullable>
          <option value="" ${current === '' ? 'selected' : ''}>Not set</option>
          <option value="true" ${current === 'true' ? 'selected' : ''}>Yes</option>
          <option value="false" ${current === 'false' ? 'selected' : ''}>No</option>
        </select>`;
}

/**
 * Generate blocks field (array with discriminated union)
 */
function generateBlocksField(name, schema, value, fullPath, idPrefix = '') {
  const blocks = Array.isArray(value) ? value : [];
  const blockTypes = schema.blockTypes || {};
  const availableTypes = Object.keys(blockTypes);

  return `
    <div class="form-group blocks-container" data-field="${fullPath}">
      <div class="blocks-header">
        <label class="form-label">${getFieldLabel(name, schema)}</label>
        <div class="blocks-actions">
          <select class="form-input form-input-sm add-block-type" aria-label="Block type to add">
            <option value="">Add block...</option>
            ${availableTypes.map(type => `
              <option value="${escapeHtml(type)}">${escapeHtml(formatBlockType(type, blockTypes[type]))}</option>
            `).join('')}
          </select>
          <button type="button" class="btn btn-primary btn-sm add-block-btn" data-field="${fullPath}">
            Add
          </button>
        </div>
      </div>

      <div class="blocks-list" data-field="${fullPath}" data-array-items data-block-types="${jsonAttr(blockTypes)}"${idPrefixAttribute(idPrefix)}>
        ${blocks.map((block, index) => generateBlockItem(fullPath, blockTypes, block, index, idPrefix)).join('\n')}
      </div>
    </div>
  `;
}

/**
 * A list rendered with an id prefix (inside the item modal) carries it, so an
 * item added to it later gets prefixed ids too, like the items rendered with it.
 */
function idPrefixAttribute(idPrefix) {
  return idPrefix ? ` data-id-prefix="${escapeHtml(idPrefix)}"` : '';
}

/**
 * Generate a single block item
 * @param {string} [idPrefix] - the form's id prefix (generateFields), kept for
 *   the block's own fields: dropping it gave a block in the item modal the ids
 *   of the form behind, so its labels focused that form's inputs
 */
function generateBlockItem(arrayPath, blockTypes, block, index, idPrefix = '') {
  const blockType = block?.type;
  const blockSchema = blockTypes[blockType];
  const path = `${arrayPath}[${index}]`;

  if (!blockSchema) {
    return `
      <div class="block-item block-item-error" data-index="${index}" data-type="${escapeHtml(blockType || 'unknown')}">
        <div class="block-header">
          <span class="block-type-badge">Unknown: ${escapeHtml(blockType)}</span>
        </div>
        <p class="text-red-500">Unknown block type</p>
      </div>
    `;
  }

  const blockFields = generateBlockFields(path, blockSchema.properties, block, idPrefix);

  return `
    <div class="block-item" data-index="${index}" data-type="${escapeHtml(blockType)}" draggable="true">
      <div class="block-header toggle-block-header">
        <span class="block-drag-handle" title="Drag to reorder">⋮⋮</span>
        <span class="block-type-badge block-type-${escapeHtml(blockType)}">${escapeHtml(formatBlockType(blockType, blockSchema))}</span>
        <span class="block-preview-text">${escapeHtml(getBlockPreview(block))}</span>
        <span class="block-expand-icon">▶</span>
      </div>
      <div class="block-body">
        <input type="hidden" name="${path}.type" value="${escapeHtml(blockType)}">
        ${blockFields}
        <div class="block-footer">
          <button type="button" class="btn btn-sm btn-danger remove-block">Delete Block</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate fields for a block based on its schema
 */
function generateBlockFields(path, properties, data, idPrefix = '') {
  // 'type' is the discriminator, carried in a hidden input by generateBlockItem
  return generateFields(properties, data || {}, { path, idPrefix, skip: ['type'] });
}

/**
 * Get a preview text for a block
 */
function getBlockPreview(block) {
  if (!block) return '';

  // Try common fields for preview
  const previewFields = ['heading', 'title', 'content', 'description', 'name', 'text'];
  for (const field of previewFields) {
    if (block[field] && typeof block[field] === 'string') {
      const text = String(block[field]);
      return text.length > 50 ? text.substring(0, 50) + '...' : text;
    }
  }

  // Check for array fields with items that have titles
  const arrayFields = ['features', 'items', 'cards', 'slides', 'steps', 'list', 'stats'];
  for (const field of arrayFields) {
    if (Array.isArray(block[field]) && block[field].length > 0) {
      const firstItem = block[field][0];
      // Try to get a title from first item
      for (const titleField of ['title', 'heading', 'name', 'label', 'value']) {
        if (firstItem[titleField]) {
          const count = block[field].length;
          const suffix = count > 1 ? ` (+${count - 1} more)` : '';
          const text = String(firstItem[titleField]);
          const preview = text.length > 35 ? text.substring(0, 35) + '...' : text;
          return preview + suffix;
        }
      }
      // Fallback to count
      const count = block[field].length;
      return `${count} ${field}`;
    }
  }

  return '';
}

/**
 * Generate array item fields
 * @param {string} [idPrefix] - the form's id prefix, kept for the item's fields
 *   (see generateBlockItem)
 */
function generateArrayItem(arrayPath, rawItemSchema, value, index, idPrefix = '') {
  const path = `${arrayPath}[${index}]`;
  const itemSchema = unwrapNullable(rawItemSchema);
  const itemData = value || {};

  if (itemSchema?.type === 'object') {
    const properties = itemSchema.properties || {};
    // Use stacked layout for complex items (more than 2 fields)
    const isComplex = Object.keys(properties).length > 2;
    const layoutClass = isComplex ? 'array-item-fields array-item-stacked' : 'array-item-fields';

    // An inline array row is a tight horizontal strip, so any picker in it renders
    // as a 70px thumbnail rather than a full-width preview.
    return `
      <div class="${layoutClass}">
        ${generateFields(properties, itemData, { path, idPrefix, pickerVariant: 'thumb' })}
      </div>
    `;
  }

  // Simple array of primitives. The element has to carry the item's schema type:
  // extractFields reads the DOM, not the schema, to decide what a value parses back
  // as — so a number or boolean rendered into a text box saves as the string "4" or
  // "true" and fails validation. A nullable item is marked as a nullable field is
  // (generateField), so a cleared one saves null rather than ''.
  const nullable = isNullableSchema(rawItemSchema);
  if (itemSchema?.type === 'boolean' && nullable) {
    return nullableBooleanSelect(path, value, 'class="array-item-input form-input"');
  }
  if (itemSchema?.type === 'boolean') {
    return `
      <label class="checkbox-label array-item-input">
        <input type="checkbox" name="${path}" ${value ? 'checked' : ''}>
        <span>${value ? 'True' : 'False'}</span>
      </label>
    `;
  }

  return `
    <input
      type="${isNumericType(itemSchema?.type) ? 'number' : 'text'}"
      ${itemSchema?.type === 'integer' ? 'step="1"' : isNumericType(itemSchema?.type) ? 'step="any"' : ''}
      name="${path}"
      value="${escapeHtml(isNumericType(itemSchema?.type) ? (value ?? '') : displayText(value))}"
      class="array-item-input form-input"
      placeholder="Enter value..."
      ${nullable ? 'data-nullable' : ''}
    >
  `;
}

/**
 * Parse labelField hint from schema description
 * Format: "labelField:fieldName" anywhere in the description
 */
function parseLabelFieldHint(schema) {
  if (!schema?.description) return null;
  const match = schema.description.match(/labelField:(\w+)/);
  return match ? match[1] : null;
}

/**
 * Work out the title and subtitle to show for an array item, in a card or a list row.
 * @param {object} item - The array item data
 * @param {object} [itemSchema] - Schema for the array items (for the labelField hint)
 * @param {number} [maxSubtitle] - Truncate the subtitle beyond this many characters
 */
export function getItemPreview(item, itemSchema = null, maxSubtitle = 60) {
  const titleFields = ['title', 'name', 'heading', 'value', 'label', 'quote', 'author', 'summary', 'message', 'caption'];
  const subtitleFields = ['description', 'content', 'subtitle', 'text', 'label', 'author', 'source', 'quote'];

  let title = '';
  let subtitle = '';
  let titleField = '';

  // An explicit labelField hint in the schema description wins
  const labelFieldHint = parseLabelFieldHint(itemSchema);
  if (labelFieldHint && item[labelFieldHint]) {
    title = String(item[labelFieldHint]);
    titleField = labelFieldHint;
  }

  // Then the standard title fields
  if (!title) {
    for (const field of titleFields) {
      if (item[field]) {
        title = String(item[field]);
        titleField = field;
        break;
      }
    }
  }

  // Failing that, the first non-empty string on the item
  if (!title) {
    for (const [field, value] of Object.entries(item)) {
      if (typeof value === 'string' && value.trim()) {
        title = value;
        titleField = field;
        break;
      }
    }
  }

  for (const field of subtitleFields) {
    // Don't use the same field for both title and subtitle
    if (field === titleField) continue;
    if (item[field]) {
      const text = String(item[field]);
      subtitle = text.length > maxSubtitle ? text.substring(0, maxSubtitle) + '...' : text;
      break;
    }
  }

  return { title, subtitle };
}

/**
 * Generate an inline card for array items
 * @param {object} item - The array item data
 * @param {number} index - The item index
 * @param {object} [itemSchema] - Optional schema for the array items
 */
function generateArrayCard(item, index, itemSchema = null) {
  const { title, subtitle } = getItemPreview(item, itemSchema);

  return `
    <div class="array-card" data-index="${index}" draggable="true">
      <div class="array-card-handle" title="Drag to reorder">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="5" r="2"/><circle cx="15" cy="5" r="2"/>
          <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
          <circle cx="9" cy="19" r="2"/><circle cx="15" cy="19" r="2"/>
        </svg>
      </div>
      <div class="array-card-content" data-edit-card="${index}">
        <div class="array-card-title">${title ? escapeHtml(title) : '<span class="array-card-untitled">Untitled</span>'}</div>
        ${subtitle ? `<div class="array-card-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <div class="array-card-actions">
        <button type="button" class="array-card-btn array-card-edit" data-edit-card="${index}" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button type="button" class="array-card-btn array-card-delete" data-delete-card="${index}" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

/**
 * Find the sibling property that holds this image field's alt text, if the schema
 * declares one (e.g. `imageAlt` next to `image`, or `alt` next to `src`).
 * Returns the property name, or null if the schema has no alt field of its own.
 */
function findAltProperty(name, siblingProps) {
  if (!siblingProps) return null;

  // A field-specific alt always wins: `<name>Alt`, or, for a name ending in
  // `image`, the alt named after what comes before it (`bannerAlt` beside
  // `bannerImage`, #88). Matching only `bannerImageAlt` showed a second alt
  // box whose `bannerImageAlt` the schema never declared, so Astro dropped it.
  const candidates = [`${name}Alt`, `${name}_alt`];
  const base = name.match(/^(.+?)_?image$/i)?.[1];
  if (base) candidates.push(`${base}Alt`, `${base}_alt`, `${base}alt`);
  const specific = candidates.find(candidate => Object.hasOwn(siblingProps, candidate));
  if (specific) return specific;

  // A plain `alt` only belongs to this image if it is the ONLY image here — as in a
  // gallery item's { src, alt }. With two images and one `alt` ({ heroImage, cardImage,
  // alt }) the alt cannot describe both, so neither claims it and each keeps its own
  // built-in input instead.
  if ('alt' in siblingProps && countImageFields(siblingProps) === 1) return 'alt';

  return null;
}

/**
 * How many of these sibling properties are image fields
 */
function countImageFields(siblingProps) {
  return Object.entries(siblingProps)
    .filter(([key, schema]) => isImageField(key, schema || {}))
    .length;
}

/**
 * Check if a field is an image field based on name and schema
 */
/**
 * A min/max attribute from a JSON Schema bound. zod 4 gives every integer
 * bounds of +/-Number.MAX_SAFE_INTEGER, which say nothing to an editor, so
 * those are left off.
 * @param {'min'|'max'} attribute
 * @param {number|undefined} bound - schema.minimum or schema.maximum
 */
function numberBound(attribute, bound) {
  if (typeof bound !== 'number' || Math.abs(bound) >= Number.MAX_SAFE_INTEGER) return '';
  return `${attribute}="${bound}"`;
}

export function isImageField(name, schema) {
  // Field names that indicate an image
  const imageFieldNames = ['image', 'logo', 'ogImage', 'src', 'icon', 'avatar', 'photo', 'thumbnail', 'banner', 'background'];
  const lowerName = name.toLowerCase();

  // Check if field name matches common image field patterns
  if (imageFieldNames.some(imgName => lowerName === imgName.toLowerCase() || lowerName.endsWith(imgName.toLowerCase()))) {
    return true;
  }

  // Check if schema explicitly marks it as image
  if (schema.format === 'image' || schema.widget === 'image') {
    return true;
  }

  // Astro's image() reaches the editor as the schema parser's stand-in, a
  // string marked with IMAGE_MARKER (server/utils/schema-parser.js).
  if (isAstroImageField(schema)) {
    return true;
  }

  return false;
}

/**
 * Whether a field is Astro's image(). Its value must be a path Astro can
 * import relative to the entry, not a public /images/... URL, so its picker
 * resolves what it stores through the server (field-widgets.js
 * applyPickedImage). A nullable image() (`{anyOf: [image, null]}`) counts.
 */
export function isAstroImageField(schema) {
  if (schema?.[IMAGE_MARKER] === true) return true;
  const members = schema?.anyOf || schema?.oneOf;
  if (!Array.isArray(members)) return false;
  const nonNull = members.filter((member) => member?.type !== 'null');
  return nonNull.length === 1 && nonNull[0]?.[IMAGE_MARKER] === true;
}

/**
 * Whether a string field gets the video picker: `format`/`widget: 'video'`,
 * or a name ending in `video` (`heroVideo`, `backgroundVideo`). By name alone,
 * a `.url()` field stays a URL input, and an Astro image() or a field marked
 * as an image stays an image picker (a video cannot be an image() value).
 * The picker's value box is a visible text input, so a field that holds a
 * link or an embed id (`youtubeVideo`) can still be typed into whatever the
 * widget; the choice never depends on the stored value.
 */
export function isVideoField(name, schema) {
  if (schema.format === 'video' || schema.widget === 'video') return true;
  // A string only: a union or z.any() (no `type`) may hold an object.
  if (schema.type !== 'string') return false;
  if (schema.format === 'uri' || schema.format === 'url') return false;
  if (schema.format === 'image' || schema.widget === 'image' || isAstroImageField(schema)) return false;
  return name.toLowerCase().endsWith('video');
}

/**
 * Get friendly label and help text for known image fields
 */
function getImageFieldInfo(name) {
  const lowerName = name.toLowerCase();

  if (lowerName === 'ogimage' || lowerName === 'og_image') {
    return {
      label: 'Social Share Image',
      help: 'Shown when sharing on Facebook, Twitter, LinkedIn, etc. <a href="https://ogp.me/" target="_blank" rel="noopener">Learn more</a>'
    };
  }

  return {};
}

/** What differs between an image picker and a video picker. */
const PICKER_KINDS = {
  image: { icon: '📷', noun: 'image' },
  video: { icon: '🎬', noun: 'video' },
};

/**
 * Generate an image (or video) picker field
 * @param {string} [variant] - Size variant: 'thumb', 'compact', or '' for full size.
 *   The picker owns its own sizes; a container never reaches in to override them.
 * @param {'image'|'video'} [kind] - a video picker is marked `data-video`
 *   (field-widgets.js opens a library of videos) and previewed by a muted
 *   <video> showing its first frame
 */
function generateImageField(name, schema, value, fullPath, id, altValue = '', hideBuiltinAlt = false, variant = '', nullableAttributes = '', kind = 'image') {
  const { icon, noun } = PICKER_KINDS[kind];
  // Only show the image preview for a value that is actually an image path.
  // A non-path value (e.g. a `placeholder:banner` marker a site uses to render
  // an outline) would otherwise load as a broken <img>. The value is still kept
  // in the hidden input, so it round-trips on save; the field just shows the
  // clean "No image selected" state instead of a broken thumbnail.
  // displayText: a value of an unexpected type (an object in a field marked
  // as an image or a video) renders as the empty state instead of throwing.
  const trimmed = displayText(value).trim();
  const isRealImage = kind === 'video' ? isPreviewableVideo(trimmed) : isPreviewableImage(trimmed);
  const previewClass = isRealImage ? '' : 'hidden';
  const placeholderClass = isRealImage ? 'hidden' : '';

  // Special labels and help text for known fields
  const fieldInfo = getImageFieldInfo(name);
  // The site's own label beats our guess for a known name.
  const label = schema.label ? getFieldLabel(name, schema) : (fieldInfo.label || getFieldLabel(name, schema));
  const helpHtml = fieldInfo.help ? `<span class="form-help">${fieldInfo.help}</span>` : '';

  // Only show built-in alt field if not hidden (e.g., parent object doesn't have its own alt field)
  const altFieldHtml = hideBuiltinAlt ? '' : `
        <input
          type="text"
          class="form-input image-picker-alt"
          style="margin-top: 0.5rem;"
          name="${fullPath}Alt"
          value="${escapeHtml(altValue || '')}"
          placeholder="Alt text for accessibility"
          data-alt-input
        >`;

  // Resolve the image URL for preview (handles relative paths). Empty for a
  // non-path value so a hidden preview never holds a broken src.
  const previewSrc = isRealImage ? resolveImageUrl(trimmed) : '';

  return `
    <div class="form-group">
      <label for="${id}" class="form-label">${label} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
      ${helpHtml}
      <div class="image-picker${variant ? ` image-picker--${variant}` : ''}" data-field="${fullPath}"${kind === 'video' ? ' data-video' : ''}${isAstroImageField(schema) ? ' data-astro-image' : ''}>
        <div class="image-picker-preview ${previewClass}" data-preview>
          ${kind === 'video'
            ? `<video src="${escapeHtml(previewSrc)}" class="image-picker-img" muted playsinline preload="metadata" data-preview-img></video>`
            : `<img src="${escapeHtml(previewSrc)}" alt="Preview" class="image-picker-img" data-preview-img>`}
          <button type="button" class="image-picker-clear" data-clear title="Clear ${noun}">&times;</button>
        </div>
        <div class="image-picker-placeholder ${placeholderClass}" data-placeholder>
          <span class="image-picker-icon">${icon}</span>
          <span>No ${noun} selected</span>
        </div>
        <div class="image-picker-actions">
          <button type="button" class="btn btn-sm btn-secondary image-picker-browse" data-browse>
            Browse Library
          </button>
          <button type="button" class="btn btn-sm btn-secondary image-picker-upload" data-upload>
            Upload New
          </button>
        </div>
        <input
          type="${kind === 'video' ? 'text' : 'hidden'}"
          name="${fullPath}"
          id="${id}"
          value="${escapeHtml(value || '')}"
          class="image-picker-input${kind === 'video' ? ' form-input image-picker-url' : ''}"
          ${kind === 'video' ? 'placeholder="Choose a video, or paste a path or link"' : ''}
          ${nullableAttributes}
          ${schema.required ? 'required' : ''}
        >${altFieldHtml}
      </div>
    </div>
  `;
}

/**
 * Check if a field is a color field based on name and schema
 */
function isColorField(name, schema) {
  const lowerName = name.toLowerCase();

  // Check if field name contains color-related terms
  if (lowerName.includes('color') || lowerName.includes('colour') || lowerName.includes('background')) {
    return true;
  }

  // Check if schema explicitly marks it as color
  if (schema.format === 'color' || schema.widget === 'color') {
    return true;
  }

  return false;
}

/**
 * The colour box's hint when the site sets none (`.meta({ placeholder })`):
 * a hex code, the one form every colour schema accepts. It used to say "or
 * color name", which a hex-only schema then refused on save.
 */
const COLOUR_PLACEHOLDER = 'e.g. #1b2a4a';

/**
 * Generate a color picker field.
 *
 * A native colour input always holds SOME colour, so a blank value, or one
 * the swatch cannot show (`var(--brand)`), renders a swatch marked
 * `data-no-colour` (drawn as "no colour" in ui/input.css) rather than a colour
 * the site may not be using: blank often means "the site's default". The
 * swatch has no name; only the text box is saved. Nor an id: an id with no
 * name is not moved when a block is reindexed, so a later block repeated it.
 */
function generateColorField(name, schema, value, fullPath, id, nullableAttributes = '') {
  const colorValue = value === null || value === undefined ? '' : String(value);
  const placeholder = typeof schema.placeholder === 'string' ? schema.placeholder : COLOUR_PLACEHOLDER;

  return `
    <div class="form-group">
      <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
      <div class="color-picker-wrapper">
        <input
          type="color"
          aria-label="Pick a colour for ${escapeHtml(fieldLabelText(name, schema))}"
          ${colourSwatchAttributes(colorValue)}
          class="color-picker-input"
        >
        <input
          type="text"
          name="${fullPath}"
          id="${id}"
          value="${escapeHtml(colorValue)}"
          class="form-input color-picker-text"
          ${nullableAttributes}
          placeholder="${escapeHtml(placeholder)}"
          ${schema.required ? 'required' : ''}
        >
        ${colorValue ? COLOUR_CLEAR_BUTTON : ''}
      </div>
    </div>
  `;
}

/** The swatch's value, or its no-colour mark (the same rule showColourSwatch applies as the value changes). */
function colourSwatchAttributes(colorValue) {
  const hex = colorToHex(colorValue);
  if (hex !== '') return `value="${hex}"`;
  return `${COLOUR_NONE_ATTRIBUTE} title="${colourSwatchTitle(colorValue)}"`;
}

/**
 * Detect if a field is a gallery (array of image objects with 'src').
 *
 * Not when `src` is Astro's image(): the gallery editor stores public library
 * URLs, which the build refuses for image(). Such an array is edited as
 * array cards, whose item modal renders `src` through the same image picker as
 * any image() field (entry-relative values, applyPickedImage).
 */
function isGalleryField(schema) {
  if (schema.type !== 'array') return false;
  const items = schema.items;
  if (!items || items.type !== 'object') return false;
  // Check if items have a 'src' property (typical for image arrays)
  if (!items.properties || !('src' in items.properties)) return false;
  return !isAstroImageField(items.properties.src);
}

/**
 * Generate a gallery field with thumbnail preview and edit button
 */
function generateGalleryField(name, schema, value, fullPath, id) {
  const images = Array.isArray(value) ? value : [];
  const previewImages = images.slice(0, 6); // Show up to 6 thumbnails
  const moreCount = images.length - 6;
  // Encode JSON to avoid breaking HTML attributes with quotes in alt text
  const encodedValue = btoa(encodeURIComponent(JSON.stringify(images)));

  return `
    <div class="form-group">
      <label>${getFieldLabel(name, schema)}</label>
      <div class="gallery-field" data-field="${fullPath}" data-gallery-value="${encodedValue}" data-gallery-encoded="true">
        <div class="gallery-field-preview">
          ${previewImages.length > 0 ? previewImages.map(img => `
            <div class="gallery-field-thumb">
              <img src="${escapeHtml(img.src || '')}" alt="">
            </div>
          `).join('') : '<span class="gallery-field-empty">No images</span>'}
          ${moreCount > 0 ? `<div class="gallery-field-more">+${moreCount}</div>` : ''}
        </div>
        <button type="button" class="btn btn-secondary btn-sm gallery-field-edit" data-edit-gallery="${fullPath}">
          ${images.length > 0 ? `Edit ${images.length} images` : 'Add images'}
        </button>
      </div>
    </div>
  `;
}

/**
 * The collection a field references, or null.
 *
 * Only the schema says so: the parser marks every reference with
 * `referenceCollection` (server/utils/schema-parser.js annotateReferences),
 * for Astro's reference() and for a `<name>Ids` list whose name resolves to a
 * DECLARED collection. Guessing from the name here could only point at a
 * collection that may not exist.
 */
function detectReferenceCollection(schema) {
  if (schema.type === 'string') return schema.referenceCollection || null;
  if (schema.type !== 'array' || schema.items?.type !== 'string') return null;
  return schema.referenceCollection || schema.items.referenceCollection || null;
}

/**
 * The entry id a stored reference value names, or ''. Astro's reference()
 * accepts a string id, a number, and a lookup object {collection, id} or
 * {collection, slug}; the picker shows and previews all of them by their id.
 * @param {unknown} value
 * @returns {string}
 */
export function referenceId(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object') {
    if (typeof value.id === 'string') return value.id;
    if (typeof value.slug === 'string') return value.slug;
  }
  return '';
}

/**
 * Set a reference's hidden input to a chosen entry id ('' clears a single
 * reference). The dashboard's picker calls this. A chosen entry is saved as
 * its plain id; a stored number or lookup object ({collection, id}) the input
 * stood for is kept only while the input is untouched (bindOriginalValues).
 * @param {HTMLInputElement} input
 * @param {string} entryId
 */
export function setReferenceInputValue(input, entryId) {
  if (!input) return;
  setWidgetValue(input, entryId);
}

/**
 * Generate a reference picker field (card-style layout with drag handles).
 *
 * A list (z.array(reference('c')), `<name>Ids`) renders one hidden input per
 * card, `<path>[i]`, and is marked data-array-items so zero cards still save
 * as []. A single reference (reference('c')) renders ONE hidden input named
 * `<path>`, and at most one card. Each input holds the id; an untouched one
 * saves the stored value whatever its shape (a number, a lookup object).
 */
function generateReferenceField(name, schema, value, fullPath, id, collectionName, nullableAttributes = '') {
  const single = schema.type === 'string';
  // A list item with no id is not shown, so a card's index can differ from its
  // item's index in the stored list; each card carries the stored index.
  const items = single
    ? (referenceId(value) !== '' ? [{ itemId: referenceId(value), storedIndex: 0 }] : [])
    : (Array.isArray(value) ? value : [])
      .map((item, storedIndex) => ({ itemId: referenceId(item), storedIndex }))
      .filter((item) => item.itemId !== '');
  const singularName = collectionName.endsWith('s') ? collectionName.slice(0, -1) : collectionName;
  // A `testimonialIds` list is labelled by its collection ("Testimonials", not
  // "Testimonial Ids"), unless the site gave it a label; any other name is the
  // field's own label. Text here: it is escaped below.
  const label = /Ids?$/.test(name) && !schema.label ? formatLabel(collectionName) : fieldLabelText(name, schema);

  return `
    <div class="form-group">
      <label class="form-label">${escapeHtml(label)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
      <div class="reference-field" data-field="${fullPath}" ${single ? 'data-reference-single' : 'data-array-items'} data-collection="${escapeHtml(collectionName)}">
        ${single ? `<input type="hidden" name="${fullPath}" id="${id}" value="${escapeHtml(items.length ? items[0].itemId : '')}" data-reference-value ${nullableAttributes}>` : ''}
        <div class="reference-cards" data-reference-cards>
          ${items.length === 0 ? REFERENCE_EMPTY_HTML : ''}
          ${items.map((item, index) => referenceCardHtml(item.itemId, { index, fullPath, single, storedIndex: item.storedIndex })).join('')}
        </div>
        <button type="button" class="btn btn-secondary btn-sm reference-cards-add add-reference-item${single && items.length ? ' hidden' : ''}" data-field="${fullPath}" data-collection="${escapeHtml(collectionName)}">
          ${single ? 'Choose' : '+ Add'} ${escapeHtml(formatLabel(singularName))}
        </button>
      </div>
    </div>
  `;
}

/** What an empty reference field shows. */
export const REFERENCE_EMPTY_HTML = '<div class="reference-empty">No items selected. Click "Add" to select.</div>';

/**
 * One reference card. The renderer and the dashboard's add/replace both build
 * cards here, so there is one markup for a card.
 *
 * @param {string} itemId - the referenced entry's id
 * @param {object} options
 * @param {number} [options.index] - position in a list
 * @param {string} options.fullPath - the field's input name
 * @param {boolean} [options.single] - a single reference: no per-card input
 *   (the field holds one) and nothing to reorder
 * @param {string} [options.title] - display title (defaults to the id)
 * @param {?string} [options.preview] - preview text; null shows "Loading..."
 *   until the dashboard fills it in
 * @param {?number} [options.storedIndex] - a rendered list item's index in the
 *   stored list, written as data-original-path when it is not `index` (an item
 *   with no id before it is not shown); null for a card the editor adds
 */
export function referenceCardHtml(itemId, { index = 0, fullPath, single = false, title = '', preview = null, storedIndex = null }) {
  const handle = single ? '' : `
      <div class="reference-card-handle" title="Drag to reorder">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="5" r="2"/><circle cx="15" cy="5" r="2"/>
          <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
          <circle cx="9" cy="19" r="2"/><circle cx="15" cy="19" r="2"/>
        </svg>
      </div>
      <input type="hidden" name="${fullPath}[${index}]" value="${escapeHtml(itemId)}"${storedIndex !== null && storedIndex !== index ? ` data-original-path="${fullPath}[${storedIndex}]"` : ''}>`;
  return `
    <div class="reference-card" data-index="${index}" data-id="${escapeHtml(itemId)}" ${single ? '' : 'draggable="true"'}>${handle}
      <div class="reference-card-content edit-reference-item" title="Click to change">
        <div class="reference-card-title">${escapeHtml(title || itemId)}</div>
        <div class="reference-card-preview" data-preview-for="${escapeHtml(itemId)}">${preview === null ? 'Loading...' : escapeHtml(preview)}</div>
      </div>
      <div class="reference-card-actions">
        <button type="button" class="reference-card-btn reference-card-edit open-reference-editor" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button type="button" class="reference-card-btn reference-card-delete remove-reference-item" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

/**
 * Format field name into readable label
 */
export function formatLabel(name) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^./, str => str.toUpperCase())
    .trim();
}

/**
 * A field's label as text: the site's own (`label` in its JSON Schema, which a
 * zod 4 `.meta({ label: '...' })` puts there; docs/content-collections.md),
 * otherwise the key in title case.
 * @returns {string}
 */
function fieldLabelText(name, schema) {
  return typeof schema?.label === 'string' && schema.label !== '' ? schema.label : formatLabel(name);
}

/** A field's label as HTML (escaped), for every field kind's heading. */
function getFieldLabel(name, schema) {
  return escapeHtml(fieldLabelText(name, schema));
}

/**
 * The label for a block type. A site names its own blocks: a `title` in the
 * block's schema (zod 4: `.meta({ title: 'Call to action' })` on the block
 * object) wins, else the type is humanised ('hero' -> 'Hero',
 * 'featureGrid' -> 'Feature grid'). No built-in list renames a site's types.
 * @param {string} type - the discriminator value
 * @param {object} [blockSchema] - that block's JSON Schema
 */
export function formatBlockType(type, blockSchema = null) {
  if (typeof blockSchema?.title === 'string' && blockSchema.title.trim()) return blockSchema.title;
  return humanizeName(type);
}

/**
 * A code name as words, first one capitalised and the rest lower case:
 * 'featureGrid' -> 'Feature grid', 'call_to-action' -> 'Call to action'.
 */
export function humanizeName(value) {
  if (typeof value !== 'string') return String(value ?? '');
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return value;
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

/**
 * Extract form data into object matching schema structure
 * Returns an array directly for top-level array schemas
 */
export function extractFormData(formElement, schema) {
  // A top-level list of non-objects is read as the one field it is drawn as,
  // by the same rules as any field (untouched items as stored).
  if (isInlineTopLevelList(schema)) {
    return extractValues(formElement, topLevelListWrapper(schema)).data[TOP_LEVEL_LIST_KEY] ?? [];
  }

  // Check for top-level array schema
  const topLevelArrayInput = formElement.querySelector('input[data-top-level-array="true"]');
  if (topLevelArrayInput) {
    // The whole entry is one list of cards, each a final value (see
    // extractValues): an untouched list is the stored one, and an edited one
    // holds stored items as stored and edited items as their item editor
    // settled them, so nothing here is cleaned again.
    const binding = boundContainers.get(formElement);
    if (binding) recordStructuralEdits(binding);
    const storedList = binding?.original[TOP_LEVEL_LIST_KEY];
    if (Array.isArray(storedList) && controlUnchanged(binding, topLevelArrayInput)) {
      return cloneValue(storedList);
    }
    try {
      return JSON.parse(topLevelArrayInput.value || '[]');
    } catch (e) {
      console.error('Failed to parse top-level array:', e);
      return [];
    }
  }

  const { data, blanks } = extractValues(formElement, schema);
  if (blanks.length > 0) blankOptionalCandidates.set(data, blanks);
  return data;
}

/** @type {WeakMap<object, string[]>} see blankOptionalPaths */
const blankOptionalCandidates = new WeakMap();

/**
 * The paths (`blocks[1].caption`) of the "" values in a saved entry that are
 * kept only because they sit inside a block at a key the schema proves
 * optional: what extractFormData returned them in. Inside a block a "" is
 * kept, since the JSON Schema cannot say which "" the site's zod refuses; the
 * save sends these paths (see save-payload.js) and the server drops each one
 * the site's real zod refuses at exactly that path (#70).
 * @param {*} data - a value extractFormData returned
 * @returns {string[]}
 */
export function blankOptionalPaths(data) {
  return (data && typeof data === 'object' && blankOptionalCandidates.get(data)) || [];
}

/**
 * Read a container (the form, or an item editor's form) into the value it
 * saves: changed controls from the DOM, untouched ones as stored
 * (applyOriginalValues), then empty optionals stripped (cleanEmptyValues).
 *
 * Cleanup touches only what the DOM produced. A value put back as stored is
 * never cleaned (a stored '' or [] stays), and neither is an item of a
 * JSON-backed list of cards: each is either a stored item, untouched, or one
 * an item editor already settled by this same rule (extractItem).
 *
 * @param {HTMLElement} container
 * @param {object} schema - the object schema the container renders
 * @returns {{data: object, removed: string[], blanks: string[]}} the value,
 *   the top-level keys cleanup removed, and the block "" it kept at optional
 *   keys (see blankOptionalPaths)
 */
function extractValues(container, schema) {
  const data = readFields(container);
  const kept = applyOriginalValues(container, data);
  container.querySelectorAll('input[data-array-data]').forEach((input) => {
    for (const itemPath of finalItemPaths(getNestedValue(data, input.name), input.name)) kept.add(itemPath);
  });
  // A gallery's STORED images survive a structural edit whole: once the gallery
  // is read from the DOM (data-structural-edit), cleanup must not strip a
  // surviving image's empty optional fields. An image the editor added is
  // cleaned like any new value (an empty alt is left out, not saved as ''),
  // and the emptied gallery itself can still be dropped.
  const binding = boundContainers.get(container);
  container.querySelectorAll('.gallery-field[data-field]').forEach((gallery) => {
    const bound = binding?.controls.get(gallery);
    if (!bound) return;
    const listPath = gallery.dataset.field;
    const items = getNestedValue(data, listPath);
    if (!Array.isArray(items)) return;
    const storedImages = decodeGalleryValue(bound.baseline).map((image) => JSON.stringify(image));
    items.forEach((image, index) => {
      const match = storedImages.indexOf(JSON.stringify(image));
      if (match < 0) return;
      storedImages.splice(match, 1);
      kept.add(`${listPath}[${index}]`);
    });
  });

  // A const input the stored value was not put back for carries the schema's
  // value, not the editor's: cleanup writes it only where the key is required.
  const constants = new Set();
  container.querySelectorAll('input[name][data-schema-const]').forEach((input) => {
    if (!kept.has(input.name)) constants.add(input.name);
  });

  // Strip empty optional fields, but keep required ones (see cleanEmptyValues) —
  // walking the schema so this holds at every level, not just the top.
  const before = Object.keys(data);
  const blanks = [];
  cleanEmptyValues(data, schema, false, kept, '', { constants, blanks });
  return { data, removed: before.filter((key) => !(key in data)), blanks };
}

/** The paths of a list's items (`<path>[i]`), as cleanEmptyValues walks them. */
function finalItemPaths(items, listPath) {
  return new Set(Array.isArray(items) ? items.map((_, index) => `${listPath}[${index}]`) : []);
}

/**
 * What an item editor saves: the item it was opened with, with every field it
 * renders read by the same rule as the main form (extractValues), so the item
 * it hands back is final. An untouched field keeps its stored value, '' and
 * [] included; a field the editor emptied is dropped when the schema makes it
 * optional; a property the schema does not render is kept as it was.
 * @param {HTMLElement} container - the item editor's form
 * @param {object} item - the item it was opened with
 * @param {object} schema - the item's object schema
 * @returns {object}
 */
export function extractItem(container, item, schema) {
  const { data } = extractValues(container, schema);
  const result = { ...item, ...data };
  // A rendered field missing from what was read was left out on purpose: by
  // cleanup (an emptied optional), by the read itself (an empty number box,
  // #61) or as absent when stored. Merged over the item, it came back as
  // stored, so clearing a number in the modal saved its old value.
  for (const key of renderedKeys(container)) {
    if (!(key in data)) delete result[key];
  }
  return result;
}

/** The top-level keys a container renders a control or container for. */
function renderedKeys(container) {
  const keys = new Set();
  const add = (path) => {
    const key = path?.split(/[.[]/)[0];
    if (key) keys.add(key);
  };
  container.querySelectorAll('[name]').forEach((element) => add(element.getAttribute('name')));
  container.querySelectorAll('[data-field]').forEach((element) => add(element.dataset.field));
  container.querySelectorAll('[data-object-field]').forEach((element) => add(element.dataset.objectField));
  return keys;
}

/**
 * Read every field inside a container back into an object.
 *
 * The counterpart to generateFields: whatever that renders, this can read. Used
 * by the main form and by the array item modal, so an item picks up the same
 * gallery/array/checkbox/number handling the form has always had.
 *
 * A container bound with bindOriginalValues gets the stored value for every
 * control and container the editor has not changed; only changed ones are read
 * from the DOM.
 *
 * Empty strings are preserved — the caller decides whether to strip them, since
 * dropping the key entirely can fail a schema that requires the field.
 *
 * @param {HTMLFormElement} form - Must be a <form>; FormData throws on anything else
 * @returns {object}
 */
export function extractFields(container) {
  const data = readFields(container);
  applyOriginalValues(container, data);
  return data;
}

/**
 * Every value the container's DOM holds, as an object: what a changed control
 * saves.
 */
function readFields(container) {
  const data = {};
  const binding = boundContainers.get(container) || null;

  // Hidden fields carrying JSON
  container.querySelectorAll('input[type="hidden"][data-json="true"]').forEach(input => {
    try {
      data[input.name] = JSON.parse(input.value);
    } catch (e) {
      console.error('Failed to parse JSON field:', input.name, e);
      data[input.name] = input.value;
    }
  });

  // Gallery fields keep their images in a base64 data attribute
  container.querySelectorAll('.gallery-field[data-field]').forEach(field => {
    setNestedValue(data, field.dataset.field, decodeGalleryValue(field.dataset.galleryValue));
  });

  // Inline array cards keep their items as JSON in a hidden input
  container.querySelectorAll('input[data-array-data]').forEach(input => {
    try {
      setNestedValue(data, input.name, JSON.parse(input.value || '[]'));
    } catch (e) {
      console.error('Failed to parse array field:', input.name, e);
      setNestedValue(data, input.name, []);
    }
  });

  for (const [key, value] of new FormData(container).entries()) {
    const input = container.querySelector(`[name="${CSS.escape(key)}"]`);

    // Both were handled above
    if (input?.dataset?.json === 'true') continue;
    if (input?.dataset?.arrayData !== undefined) continue;

    // Only coerce fields the schema actually declared as numbers. Sniffing the
    // string instead would turn a title of "2024" into the number 2024, and a
    // reference id of "123" into an integer.
    let fieldValue = value;
    if (input?.type === 'number' && value === '' && input.dataset?.nullable === undefined && !key.endsWith(']')) {
      // An empty number box has no number to save, and "" fails every
      // z.number(): the key is left out (#61), inside a block too (its parent
      // object is still made, so an object holding only it stays). A nullable
      // one is cleared to null below; an untouched one gets its stored value
      // back (applyOriginalValues). An item of a list keeps its place.
      setNestedValue(data, key, value);
      deleteNestedValue(data, key);
      continue;
    }
    if (input?.type === 'number') fieldValue = toNumber(value);
    else if (input?.type === 'date' || input?.type === 'datetime-local') fieldValue = dateControlValue(input, value);
    else if (input?.dataset?.valueType === 'boolean' && (value === 'true' || value === 'false')) fieldValue = value === 'true';
    setNestedValue(data, key, nullableControlValue(binding, input, fieldValue));
  }

  // FormData omits unchecked boxes entirely
  container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    setNestedValue(data, checkbox.name, checkbox.checked);
  });

  // An array rendered as one named input PER ITEM (blocks, references, inline
  // arrays — every container marked data-array-items) submits nothing at all when
  // it has zero items, so without this its key vanished from the saved entry. A
  // page saved with `blocks: []` came back with no `blocks` key, and a schema that
  // requires the array then failed every build. Only fill a path that is still
  // unset: a populated array was already read from its inputs above.
  container.querySelectorAll('[data-array-items][data-field]').forEach(field => {
    if (getNestedValue(data, field.dataset.field) === undefined) {
      setNestedValue(data, field.dataset.field, []);
    }
  });

  return data;
}

/**
 * The value an EDITED date or datetime control saves (an untouched one saves
 * its stored text, see bindOriginalValues). A datetime input's value (shown in
 * UTC, with no zone) becomes a UTC ISO string: saved zoneless, a JSON entry
 * was read back as the browser's local time and moved on every save. A date
 * input's YYYY-MM-DD stays date-only.
 */
function dateControlValue(input, value) {
  if (input.type !== 'datetime-local' || !ZONELESS_TIMESTAMP.test(value)) return value;
  const date = new Date(`${value}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/**
 * Whether a control's value differs from the markup it was rendered with: the
 * fallback for a control with no recorded baseline (a field in an item added
 * since the form was bound, or a form that was never bound). Imprecise for a
 * hidden input, whose value IS its markup, and for a value the browser
 * normalises; a bound control is judged against its baseline instead.
 */
function controlEdited(control) {
  if (control.tagName === 'SELECT') {
    // The `selected` attribute is what defaultSelected reflects.
    return [...control.options].some((option) => option.selected !== option.hasAttribute('selected'));
  }
  if (control.type === 'checkbox') return control.checked !== control.defaultChecked;
  return control.value !== control.defaultValue;
}

/**
 * A nullable control's value (see generateField's nullableAttributes): an
 * empty value is null when the editor CLEARED the control. An untouched one
 * never gets here as anything but its stored value (applyOriginalValues
 * replaces it), and a control that was always empty keeps '' for
 * cleanEmptyValues to decide.
 * @param {?object} binding - the container's bindOriginalValues record
 */
function nullableControlValue(binding, control, value) {
  if (!control || control.dataset?.nullable === undefined || value !== '') return value;
  const bound = binding?.controls.get(control);
  // With no baseline, a widget's clear button is the record: a hidden input's
  // defaultValue follows its value, and a value chosen then cleared is back
  // where it started (see setWidgetValue).
  const changed = bound
    ? controlState(control) !== bound.baseline
    : control.hasAttribute(CLEARED_ATTRIBUTE) || controlEdited(control);
  return changed ? null : value;
}

// --- Untouched fields keep their stored values ------------------------------
//
// Every save rebuilds the entry from the form, so a control that reads its
// value back from the DOM must reproduce the stored value exactly, and many
// cannot: a null shows as an empty box, a {collection, id} reference as its
// id, a datetime with an offset or microseconds as UTC to the millisecond, a
// stored number in a text field as text. The rule instead: a control (or a
// container: an object, a list, one item of a list) the editor has not
// changed contributes the value the entry had when it was loaded, at the path
// it was rendered from. Only what changed is read from the DOM.

/**
 * @typedef {object} ContainerBinding
 * @property {object} original - the entry (or item) the container was rendered from
 * @property {Map<Element, {path: string, baseline: string}>} controls - every
 *   named control, with the path it was rendered from and its value straight
 *   after rendering (read from the live element, so browser normalisation such
 *   as a datetime-local's milliseconds is already applied)
 * @property {Map<Element, {path: string, members: Element[]}>} containers -
 *   every object, list and list item, with the path it was rendered from and
 *   the controls it held, in order
 * @property {Map<Element, string>} constants - every const input, with the
 *   path it was rendered from (see applyOriginalValues)
 * @property {Set<Element>} structurallyEdited - lists (and card lists' JSON
 *   inputs) whose rows were added, removed or moved since binding
 * @property {?MutationObserver} observer - watches for those row changes
 */

/** @type {WeakMap<Element, ContainerBinding>} */
const boundContainers = new WeakMap();

// The elements extractFields reads a value from: named inputs, selects and
// textareas, and a gallery (whose value is a data attribute). A const input is
// the schema's value, not the editor's: it is not a control a container's
// "unchanged" is judged by, and it is tracked on its own (`constants`).
const CONTROL_SELECTOR = 'input[name], select[name], textarea[name], .gallery-field[data-field]';

// Containers: a nested object's fieldset, a list (blocks, inline array,
// reference list), and each item of a blocks list or inline array.
const CONTAINER_SELECTOR = '[data-object-field], [data-array-items][data-field], .blocks-list > .block-item, .array-field > .array-item';

/**
 * Record what a freshly rendered container was rendered from, so that
 * extractFields / extractFormData give every control and container the editor
 * leaves alone its stored value. Call it once, straight after the markup is in
 * the document and its widgets are set up, and before any edit: the baselines
 * are the live elements' values at that moment. Not for a NEW entry, which has
 * no stored values to keep.
 *
 * Elements added later (a new block, a new item, a newly chosen reference
 * card) are not bound, so they are read from the DOM; a list they join
 * counts as changed.
 *
 * @param {HTMLElement} container - the form or item editor holding the fields
 * @param {object} original - the values it was rendered from (the API's `data`
 *   for the open entry; the item for an item editor)
 */
export function bindOriginalValues(container, original) {
  boundContainers.get(container)?.observer?.disconnect();
  /** @type {ContainerBinding} */
  const binding = {
    // A top-level list is drawn as one field (TOP_LEVEL_LIST_KEY), so its
    // controls' paths start there.
    original: cloneValue(Array.isArray(original) ? { [TOP_LEVEL_LIST_KEY]: original } : original ?? {}),
    controls: new Map(),
    containers: new Map(),
    constants: new Map(),
    structurallyEdited: new Set(),
    observer: null,
  };
  for (const control of boundControls(container)) {
    binding.controls.set(control, {
      path: control.getAttribute('data-original-path') ?? controlPath(control),
      baseline: controlState(control),
    });
  }
  for (const element of container.querySelectorAll(CONTAINER_SELECTOR)) {
    const path = containerPath(element);
    if (path === null) continue;
    binding.containers.set(element, { path, members: boundControls(element) });
  }
  for (const constant of container.querySelectorAll('input[name][data-schema-const]')) {
    binding.constants.set(constant, constant.getAttribute('data-original-path') ?? constant.name);
  }
  // Rows come and go without any control changing value: a row holding only
  // a constant has no bound control, and a row added then removed leaves the
  // list as it was rendered. Watch the rows themselves instead; records are
  // read at extraction (recordStructuralEdits), and on delivery so none pile up.
  if (typeof MutationObserver === 'function') {
    binding.observer = new MutationObserver((records) => noteStructuralEdits(binding, records));
    binding.observer.observe(container, { childList: true, subtree: true });
  }
  boundContainers.set(container, binding);
}

// A list's rows: what adding, removing or moving one adds or removes.
const LIST_ROW_SELECTOR = '.block-item, .array-item, .reference-card, .array-card';

/** Read the observer's pending records (see bindOriginalValues). */
function recordStructuralEdits(binding) {
  if (binding.observer) noteStructuralEdits(binding, binding.observer.takeRecords());
}

/**
 * Mark the list each added, removed or moved row belongs to as structurally
 * edited: the list element for blocks, inline items and references, and the
 * JSON input that holds a list of cards. Such a list saves what the DOM holds
 * now, even when that matches what was rendered.
 */
function noteStructuralEdits(binding, records) {
  for (const record of records) {
    const rows = [...record.addedNodes, ...record.removedNodes]
      .filter((node) => node.nodeType === 1 && node.matches(LIST_ROW_SELECTOR));
    if (rows.length === 0) continue;
    // The nearest list wins. A single reference's card is not a row (its
    // hidden input's value says what changed), and must not mark a list it
    // happens to sit in.
    const owner = record.target.closest?.('[data-array-cards], [data-array-items][data-field], [data-reference-single]');
    if (!owner || owner.hasAttribute('data-reference-single')) continue;
    const list = owner.hasAttribute('data-array-cards')
      ? owner.parentElement?.querySelector('input[data-array-data]')
      : owner;
    if (list) binding.structurallyEdited.add(list);
  }
}

/** Whether rows were added, removed or moved in this element or anywhere inside it. */
function structurallyEditedWithin(binding, element) {
  for (const edited of binding.structurallyEdited) {
    if (element === edited || element.contains(edited)) return true;
  }
  return false;
}

/**
 * Put the stored value back for everything the editor has not changed.
 * Containers first, outermost first: an unchanged container yields its stored
 * value whole (null, an unrendered key, an item's every field), and nothing
 * inside it is looked at again. A changed container (an edit inside, or an
 * item added, removed or moved) falls through to its contents, so a moved but
 * otherwise untouched block is still its stored self at its new index.
 * A list whose rows were added, removed or moved is changed even when no
 * control in it changed (see noteStructuralEdits), and so is everything
 * holding it.
 * @param {HTMLElement} container
 * @param {object} data - what readFields read from the DOM (mutated)
 * @returns {Set<string>} the current paths given their stored values, which
 *   cleanEmptyValues must leave alone
 */
function applyOriginalValues(container, data) {
  const restored = new Set();
  const binding = boundContainers.get(container);
  if (!binding) return restored;
  recordStructuralEdits(binding);
  const settled = [];
  const insideSettled = (element) => settled.some((outer) => outer.contains(element));

  for (const [element, bound] of binding.containers) {
    if (!container.contains(element) || insideSettled(element)) continue;
    if (structurallyEditedWithin(binding, element)) continue;
    const members = boundControls(element);
    const unchanged = members.length === bound.members.length
      && members.every((control, index) => control === bound.members[index] && controlUnchanged(binding, control));
    if (!unchanged) continue;
    const currentPath = containerPath(element);
    if (currentPath === null) continue;
    putStoredValue(data, currentPath, binding.original, bound.path);
    restored.add(currentPath);
    settled.push(element);
  }

  for (const [control, bound] of binding.controls) {
    if (!container.contains(control) || insideSettled(control)) continue;
    if (!controlUnchanged(binding, control)) continue;
    putStoredValue(data, controlPath(control), binding.original, bound.path);
    restored.add(controlPath(control));
  }

  // A const input always carries the schema's value, so it never "changes";
  // left to the DOM, a stored optional `z.literal('')` was re-read as '' and
  // cleaned away whenever a sibling changed. A value stored at its path is
  // kept. With nothing stored there the schema's value stands, so a missing
  // required id is still written.
  for (const [constant, storedPath] of binding.constants) {
    if (!container.contains(constant) || insideSettled(constant)) continue;
    if (getNestedValue(binding.original, storedPath) === undefined) continue;
    putStoredValue(data, constant.name, binding.original, storedPath);
    restored.add(constant.name);
  }
  return restored;
}

/** The controls inside an element that extractFields reads, in document order. */
function boundControls(root) {
  return [...root.querySelectorAll(CONTROL_SELECTOR)].filter((control) => !control.hasAttribute('data-schema-const'));
}

/** Where a control's value is saved now (its name follows a reindex). */
function controlPath(control) {
  return control.matches('.gallery-field') ? control.dataset.field : control.name;
}

/**
 * Where a container's value is saved now: its field path, or for a list item
 * its list's path and the item's current index. Null for anything else.
 */
function containerPath(element) {
  if (element.hasAttribute('data-object-field')) return element.dataset.objectField;
  if (element.matches('.block-item, .array-item')) {
    const listPath = element.parentElement?.dataset.field;
    const index = element.dataset.index;
    return listPath && index !== undefined ? `${listPath}[${index}]` : null;
  }
  return element.dataset.field ?? null;
}

/** A control's current value as one comparable string. */
function controlState(control) {
  if (control.matches('.gallery-field')) return control.dataset.galleryValue ?? '';
  if (control.type === 'checkbox') return control.checked ? 'checked' : 'unchecked';
  if (control.tagName === 'SELECT' && control.multiple) {
    return [...control.selectedOptions].map((option) => option.value).join('\u0000');
  }
  return control.value;
}

/** Whether a bound control still holds its baseline value. */
function controlUnchanged(binding, control) {
  const bound = binding.controls.get(control);
  return bound !== undefined && controlState(control) === bound.baseline
    && !binding.structurallyEdited.has(control)
    && !control.hasAttribute('data-structural-edit');
}

/**
 * Write the stored value at `storedPath` to `currentPath`. A value the entry
 * did not have is removed rather than written: an absent key stays absent.
 */
function putStoredValue(data, currentPath, original, storedPath) {
  const stored = getNestedValue(original, storedPath);
  if (stored === undefined) {
    deleteNestedValue(data, currentPath);
  } else {
    setNestedValue(data, currentPath, cloneValue(stored));
  }
}

/** A deep copy, so a saved object never shares structure with the binding. */
function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** Remove an object key at a dot/bracket path; array slots are left alone. */
function deleteNestedValue(obj, path) {
  const keys = path.split(/\.|\[|\]/).filter(Boolean);
  const last = keys.pop();
  let current = obj;
  for (const key of keys) {
    if (current === undefined || current === null || typeof current !== 'object') return;
    current = current[key];
  }
  if (current && typeof current === 'object' && !Array.isArray(current)) delete current[last];
}

/**
 * Parse a number input's value, leaving it alone if it isn't a number
 */
function toNumber(value) {
  if (value === '') return value;
  const num = Number(value);
  return Number.isNaN(num) ? value : num;
}

/**
 * Strip empty OPTIONAL string fields and empty OPTIONAL arrays (an unset optional
 * must serialise as absent, since "" or [] would fail an `.optional().min(1)`),
 * walking the schema so REQUIRED
 * fields are never deleted at ANY level — deleting a required key is silent data
 * loss that breaks the build (and, if a whole object is momentarily empty, wipes
 * its metadata). Fail-safe: a field is deleted ONLY when the schema PROVES it
 * optional; without a schema at this level (or block items, which keep their
 * required-field placeholders) nothing is removed.
 *
 * @param {*} obj - The data to clean (mutated in place).
 * @param {object} [schemaNode] - The JSON schema for `obj` (properties/required,
 *   or `items` for arrays). Omit at a level to fail safe (keep empties).
 * @param {boolean} [isBlockItem] - True inside a discriminated-union block item.
 * @param {?Set<string>} [kept] - Paths (as controls name them: `a.b[0].c`) of
 *   values that are not the DOM's to clean: stored values put back as they
 *   were, and items an item editor already settled. Each is left whole.
 * @param {string} [path] - The path of `obj` itself ('' at the top).
 * @param {object} [extras]
 * @param {?Set<string>} [extras.constants] - Paths of const (z.literal)
 *   values the DOM produced, i.e. the schema's value with nothing stored
 *   there. Each is removed where the schema proves its key optional, at every
 *   level, blocks included: an optional literal the entry did not have is
 *   not the editor's to add (#69). A required one is always written.
 * @param {?string[]} [extras.blanks] - Collects the path of every "" kept
 *   inside a block at a key the schema proves optional (see
 *   blankOptionalPaths).
 */
export function cleanEmptyValues(obj, schemaNode, isBlockItem = false, kept = null, path = '', extras = {}) {
  // A nullable node ({anyOf: [<node>, {type: 'null'}]} or type: [x, 'null'])
  // has no `properties`/`items` of its own: read through it, or nothing inside
  // a nullable object or array could be proven optional. No schema stays none.
  if (schemaNode) schemaNode = unwrapNullable(schemaNode);
  if (Array.isArray(obj)) {
    const itemSchema = schemaNode && schemaNode.items;
    // Prefer the schema to decide block-ness: a discriminated-union block array
    // is marked with `blockTypes` (see enrichSchemaWithBlockTypes). Only fall
    // back to the `'type' in item` heuristic when we have NO schema — otherwise
    // an ordinary record that merely has a `type` field (e.g. {type:'external'})
    // would be misread as a block and keep its empty optionals.
    const schemaSaysBlock = !!(schemaNode && schemaNode.blockTypes);
    obj.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (kept?.has(itemPath)) return;
      const itemIsBlock = schemaNode
        ? schemaSaysBlock
        : (item && typeof item === 'object' && 'type' in item);
      // A block array's `items` is the whole union (anyOf/oneOf, no `properties`),
      // so on its own it tells us nothing about any one block. Resolve the block's
      // own schema through its `type` discriminator, so the empty-optional-array
      // rule below holds inside blocks too. An unknown type falls back to `items`,
      // which fails safe (no properties → nothing removed).
      const blockSchema = schemaSaysBlock && item && typeof item === 'object'
        ? schemaNode.blockTypes[item.type]
        : undefined;
      cleanEmptyValues(item, blockSchema || itemSchema, itemIsBlock, kept, itemPath, extras);
    });
    return;
  }
  if (!obj || typeof obj !== 'object') return;

  const props = (schemaNode && schemaNode.properties) || null;
  const schemaKnown = !!props;
  const required = new Set(
    schemaNode && Array.isArray(schemaNode.required) ? schemaNode.required : []
  );

  for (const key of Object.keys(obj)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (kept?.has(keyPath)) continue;
    const value = obj[key];
    const isRequired = required.has(key);
    if (extras.constants?.has(keyPath)) {
      if (schemaKnown && !isRequired) delete obj[key];
      continue;
    }
    if (value === '') {
      // Only ever drop a value the schema proves optional. Inside a block it
      // is kept, and named for the server to judge by the site's zod (#70).
      if (!isBlockItem && schemaKnown && !isRequired) delete obj[key];
      else if (schemaKnown && !isRequired) extras.blanks?.push(keyPath);
    } else if (value && typeof value === 'object') {
      cleanEmptyValues(value, props ? props[key] : undefined, isBlockItem, kept, keyPath, extras);
      // Drop a now-empty object only when we can prove that key is optional.
      if (
        !isBlockItem && schemaKnown && !isRequired &&
        !Array.isArray(value) && Object.keys(value).length === 0
      ) {
        delete obj[key];
      }
      // An empty array survives only when its key is REQUIRED. Absent is always
      // valid for an optional key, but `[]` fails an `.optional().min(1)` — and
      // extractFields fills `[]` for every rendered array with no items, so
      // without this an optional array the entry never had would be saved as
      // `[]` and break the build. Unlike the "" rule this also applies inside
      // block items: their empty arrays are not placeholders anyone needs, and
      // the block's own schema (resolved above) proves which are optional.
      if (schemaKnown && !isRequired && Array.isArray(value) && value.length === 0) {
        delete obj[key];
      }
    }
  }
}

/**
 * Read a nested value using the same dot/bracket paths setNestedValue writes.
 * Returns undefined when any segment along the way is missing.
 */
function getNestedValue(obj, path) {
  const keys = path.split(/\.|\[|\]/).filter(Boolean);
  let current = obj;
  for (const key of keys) {
    if (current === undefined || current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Set nested value in object using dot notation and array brackets
 */
function setNestedValue(obj, path, value) {
  const keys = path.split(/\.|\[|\]/).filter(Boolean);
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const nextKey = keys[i + 1];

    if (!isNaN(nextKey)) {
      // Next key is array index
      if (!Array.isArray(current[key])) {
        current[key] = [];
      }
      current = current[key];
    } else {
      // Next key is object property
      if (current[key] === undefined || current[key] === null) {
        current[key] = {};
      }
      current = current[key];
    }
  }

  current[keys[keys.length - 1]] = value;
}

/**
 * Wire up a container of generated fields.
 *
 * Everything here works wherever fields are rendered — the main editor form or
 * the array item modal — so the two can't drift apart. Anything that only makes
 * sense on the main form (blocks, references) lives outside this.
 *
 * @param {HTMLElement} container - Form or modal root
 * @param {Function} [onChange] - Called after any field changes
 */
export function setupFieldHandlers(container, onChange) {
  // Every listener below is delegated, so binding twice would double every action
  // (one click on '+ Add' appending two items). Guard the whole set, not just part.
  if (container.dataset.fieldHandlersBound === 'true') return;
  container.dataset.fieldHandlersBound = 'true';

  setupFieldWidgets(container, onChange);
  setupArrayHandlers(container, onChange);
}

/**
 * Setup event listeners for the main editor form: the shared field handlers,
 * plus the block behaviour that only the form has.
 */
export function setupFormHandlers(formElement, onBlockChange) {
  setupFieldHandlers(formElement, onBlockChange);
  setupBlockHandlers(formElement, onBlockChange);
}

/**
 * Blocks: add, remove, collapse, reorder, and keep the preview text in sync
 */
function setupBlockHandlers(formElement, onBlockChange) {
  // Delegated like the field handlers, and needs its own guard for the same reason:
  // bound twice, deleting one block prompts twice and fires the save callback twice.
  if (formElement.dataset.blockHandlersBound === 'true') return;
  formElement.dataset.blockHandlersBound = 'true';

  // Add block
  formElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('add-block-btn')) {
      const container = e.target.closest('.blocks-container');
      // A class, not an id: every block list has one (a nested list, the item
      // modal's), and ids must not repeat in the document.
      const select = container.querySelector(':scope > .blocks-header .add-block-type');
      const blockType = select.value;

      if (!blockType) {
        // Visual feedback instead of silent failure
        select.focus();
        select.classList.add('shake');
        setTimeout(() => select.classList.remove('shake'), 500);
        return;
      }

      const blocksList = container.querySelector('.blocks-list');
      const blockTypes = JSON.parse(blocksList.dataset.blockTypes || '{}');
      const fieldPath = blocksList.dataset.field;
      // The list's own blocks: a nested list's items are not its items.
      const index = directItems(blocksList, 'block-item').length;

      // Use createEmptyBlock to populate defaults (prevents schema validation errors)
      const blockSchema = blockTypes[blockType];
      const newBlock = createEmptyBlock(blockType, blockSchema);
      const blockHtml = generateBlockItem(fieldPath, blockTypes, newBlock, index, blocksList.dataset.idPrefix || '');

      // Add to DOM
      blocksList.insertAdjacentHTML('beforeend', blockHtml);

      // Collapse all existing blocks first (accordion behavior)
      blocksList.querySelectorAll('.block-item').forEach(block => {
        if (!block.classList.contains('collapsed')) {
          block.classList.add('collapsed');
          const blockIcon = block.querySelector('.block-expand-icon');
          if (blockIcon) blockIcon.textContent = '▶';
        }
      });

      // Get the newly added block and expand it
      const newBlockEl = blocksList.lastElementChild;
      newBlockEl.classList.remove('collapsed');
      const icon = newBlockEl.querySelector('.block-expand-icon');
      if (icon) icon.textContent = '▼';

      // Focus first input and scroll into view
      const firstInput = newBlockEl.querySelector('input:not([type="hidden"]), textarea');
      if (firstInput) {
        firstInput.focus();
        firstInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // Reset select
      select.value = '';

      // Trigger change callback (saves and refreshes preview)
      if (onBlockChange) onBlockChange();
    }
  });

  // Remove block
  formElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-block')) {
      const blockItem = e.target.closest('.block-item');
      if (confirm('Delete this block?')) {
        blockItem.remove();
        reindexBlocks(formElement);
        if (onBlockChange) onBlockChange();
      }
    }
  });

  // Toggle block collapse - clicking anywhere on header (accordion: only one open at a time)
  formElement.addEventListener('click', (e) => {
    const header = e.target.closest('.toggle-block-header');
    if (header && !e.target.closest('.block-actions') && !e.target.closest('.block-drag-handle')) {
      const blockItem = header.closest('.block-item');
      const blocksList = blockItem.closest('.blocks-list');
      const isCurrentlyCollapsed = blockItem.classList.contains('collapsed');

      // If opening this block, collapse all others first (accordion behavior)
      if (isCurrentlyCollapsed && blocksList) {
        blocksList.querySelectorAll('.block-item').forEach(otherBlock => {
          if (otherBlock !== blockItem && !otherBlock.classList.contains('collapsed')) {
            otherBlock.classList.add('collapsed');
            const otherIcon = otherBlock.querySelector('.block-expand-icon');
            if (otherIcon) otherIcon.textContent = '▶';
          }
        });
      }

      blockItem.classList.toggle('collapsed');
      const icon = blockItem.querySelector('.block-expand-icon');
      if (icon) {
        icon.textContent = blockItem.classList.contains('collapsed') ? '▶' : '▼';
      }
    }
  });

  // Drag and drop for reordering blocks
  let draggedBlock = null;
  let dropIndicator = null;
  let dropTarget = null;
  let dropPosition = null; // 'before' or 'after'

  // Create drop indicator element
  function getDropIndicator() {
    if (!dropIndicator) {
      dropIndicator = document.createElement('div');
      dropIndicator.className = 'block-drop-indicator';
    }
    return dropIndicator;
  }

  function removeDropIndicator() {
    if (dropIndicator && dropIndicator.parentNode) {
      dropIndicator.parentNode.removeChild(dropIndicator);
    }
    dropTarget = null;
    dropPosition = null;
  }

  formElement.addEventListener('dragstart', (e) => {
    const blockItem = e.target.closest('.block-item');
    if (blockItem) {
      draggedBlock = blockItem;
      blockItem.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }
  });

  formElement.addEventListener('dragend', (e) => {
    if (draggedBlock) {
      draggedBlock.classList.remove('dragging');
      draggedBlock = null;
      removeDropIndicator();
    }
  });

  formElement.addEventListener('dragover', (e) => {
    e.preventDefault();
    const blockItem = e.target.closest('.block-item');
    const blocksList = e.target.closest('.blocks-list');

    if (!draggedBlock || !blocksList) return;

    e.dataTransfer.dropEffect = 'move';
    const indicator = getDropIndicator();

    if (blockItem && blockItem !== draggedBlock) {
      // Determine if cursor is in top or bottom half of block
      const rect = blockItem.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      const isAbove = e.clientY < midpoint;

      dropTarget = blockItem;
      dropPosition = isAbove ? 'before' : 'after';

      // Position the indicator
      if (isAbove) {
        blockItem.parentNode.insertBefore(indicator, blockItem);
      } else {
        blockItem.parentNode.insertBefore(indicator, blockItem.nextSibling);
      }
    } else if (!blockItem && blocksList) {
      // Cursor is in the blocks list but not on a block - show at end
      const blocks = blocksList.querySelectorAll('.block-item');
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock !== draggedBlock) {
        dropTarget = lastBlock;
        dropPosition = 'after';
        blocksList.appendChild(indicator);
      }
    }
  });

  formElement.addEventListener('dragleave', (e) => {
    // Only remove indicator if leaving the blocks list entirely
    const blocksList = e.target.closest('.blocks-list');
    if (!blocksList || !blocksList.contains(e.relatedTarget)) {
      removeDropIndicator();
    }
  });

  formElement.addEventListener('drop', (e) => {
    e.preventDefault();

    if (draggedBlock && dropTarget && dropPosition) {
      if (dropPosition === 'before') {
        dropTarget.parentNode.insertBefore(draggedBlock, dropTarget);
      } else {
        dropTarget.parentNode.insertBefore(draggedBlock, dropTarget.nextSibling);
      }

      reindexBlocks(formElement);
      if (onBlockChange) onBlockChange();
    }

    removeDropIndicator();
  });

  // Update block preview text when preview fields change
  const previewFields = ['heading', 'title', 'content', 'description', 'name'];
  formElement.addEventListener('input', (e) => {
    const blockItem = e.target.closest('.block-item');
    if (!blockItem) return;

    // Check if this input is a preview field
    const inputName = e.target.name || '';
    const fieldName = inputName.split('.').pop();
    if (!previewFields.includes(fieldName)) return;

    // Find the first non-empty preview field (by priority)
    let previewText = '';
    for (const field of previewFields) {
      const input = blockItem.querySelector(`[name$=".${field}"]`);
      if (input && input.value) {
        previewText = input.value;
        break;
      }
    }

    // Update the preview text
    const previewEl = blockItem.querySelector('.block-preview-text');
    if (previewEl) {
      previewEl.textContent = previewText.length > 50 ? previewText.substring(0, 50) + '...' : previewText;
    }
  });
}

/**
 * Arrays: inline items, cards, and the item editor modal.
 * Attached to any container that can hold an array field, so an array nested
 * inside an array item works exactly like one on the form.
 */
function setupArrayHandlers(formElement, onBlockChange) {
  // Add array item (for non-block arrays) - card-style layout
  formElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('add-array-item')) {
      const arrayField = e.target.closest('.array-field');
      const fieldPath = arrayField.dataset.field;
      const itemSchema = JSON.parse(arrayField.dataset.schema || '{}');
      // The list's own items: counting every .array-item below it counted the
      // items of lists inside them too, so the new item was `rows[3]` after
      // one row holding two tags (#56).
      const index = directItems(arrayField, 'array-item').length;

      const newItem = document.createElement('div');
      newItem.className = 'array-item';
      newItem.dataset.index = index;
      newItem.draggable = true;
      newItem.innerHTML = `
        <div class="array-item-handle" title="Drag to reorder">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="2"/><circle cx="15" cy="5" r="2"/>
            <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
            <circle cx="9" cy="19" r="2"/><circle cx="15" cy="19" r="2"/>
          </svg>
        </div>
        <div class="array-item-content">
          ${generateArrayItem(fieldPath, itemSchema, null, index, arrayField.dataset.idPrefix || '')}
        </div>
        <div class="array-item-actions">
          <button type="button" class="array-item-btn array-item-delete remove-array-item" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      `;

      arrayField.insertBefore(newItem, e.target);
      if (onBlockChange) onBlockChange();
    }
  });

  // Remove array item
  formElement.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.remove-array-item');
    if (removeBtn) {
      const item = removeBtn.closest('.array-item');
      // Find the list BEFORE removing the item: once it is detached, closest()
      // from inside it finds nothing, the reindex threw, and the save never fired.
      const arrayField = item.closest('.array-field');
      item.remove();
      reindexArrayItems(arrayField);
      if (onBlockChange) onBlockChange();
    }
  });

  // Inline array cards - Edit card
  formElement.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-card]');
    if (!editBtn) return;

    const cardsContainer = editBtn.closest('[data-array-cards]');
    if (!cardsContainer) return;

    const index = parseInt(editBtn.dataset.editCard, 10);
    const schema = JSON.parse(cardsContainer.dataset.schema || '{}');
    const hiddenInput = cardsContainer.parentElement.querySelector('[data-array-data]');
    const items = JSON.parse(hiddenInput?.value || '[]');
    const item = items[index];

    if (!item) return;

    // Dynamic import
    const { openSingleItemEditor } = await import('./array-editor.js');

    // Open editor directly for this specific item
    openSingleItemEditor(item, schema, (updatedItem) => {
      // Update item in array
      items[index] = updatedItem;

      // Update hidden input
      if (hiddenInput) {
        hiddenInput.value = JSON.stringify(items);
      }

      // Re-render cards with schema for proper title detection
      const cardSchema = JSON.parse(cardsContainer.dataset.schema || '{}');
      cardsContainer.innerHTML = items.map((it, i) => generateArrayCard(it, i, cardSchema)).join('');

      // Trigger change callback
      if (onBlockChange) onBlockChange();
    });
  });

  // Inline array cards - Delete card
  formElement.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('[data-delete-card]');
    if (!deleteBtn) return;

    const cardsContainer = deleteBtn.closest('[data-array-cards]');
    if (!cardsContainer) return;

    const index = parseInt(deleteBtn.dataset.deleteCard, 10);
    const hiddenInput = cardsContainer.parentElement.querySelector('[data-array-data]');
    const items = JSON.parse(hiddenInput?.value || '[]');

    // Remove item
    items.splice(index, 1);

    // Update hidden input
    if (hiddenInput) {
      hiddenInput.value = JSON.stringify(items);
    }

    // Re-render cards with schema for proper title detection
    const cardSchema = JSON.parse(cardsContainer.dataset.schema || '{}');
    cardsContainer.innerHTML = items.map((item, i) => generateArrayCard(item, i, cardSchema)).join('');

    // Trigger change callback
    if (onBlockChange) onBlockChange();
  });

  // Inline array cards - Add new card
  formElement.addEventListener('click', async (e) => {
    const addBtn = e.target.closest('[data-add-array-card]');
    if (!addBtn) return;

    const formGroup = addBtn.closest('.form-group');
    const cardsContainer = formGroup?.querySelector('[data-array-cards]');
    if (!cardsContainer) return;

    const schema = JSON.parse(cardsContainer.dataset.schema || '{}');
    const hiddenInput = formGroup.querySelector('[data-array-data]');
    const items = JSON.parse(hiddenInput?.value || '[]');

    // Create empty item based on schema
    const newItem = createEmptyArrayItem(schema);

    // Open editor for the new item directly
    const { openSingleItemEditor } = await import('./array-editor.js');
    openSingleItemEditor(newItem, schema, (savedItem) => {
      // Add to items array
      items.push(savedItem);

      // Update hidden input
      if (hiddenInput) {
        hiddenInput.value = JSON.stringify(items);
      }

      // Re-render cards with schema for proper title detection
      cardsContainer.innerHTML = items.map((item, i) => generateArrayCard(item, i, schema)).join('');

      // Trigger change callback
      if (onBlockChange) onBlockChange();
    }, { isNew: true });
  });

  // Initialize sortable for array cards (features, stats, etc.)
  initSortableCards(formElement, {
    cardSelector: '.array-card',
    containerSelector: '[data-array-cards]',
    onReorder: (container, fromIndex, toIndex) => {
      // Update JSON data in hidden input
      const hiddenInput = container.parentElement?.querySelector('[data-array-data]');
      if (hiddenInput) {
        const items = JSON.parse(hiddenInput.value || '[]');
        const [moved] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, moved);
        hiddenInput.value = JSON.stringify(items);
      }
    },
    onChange: onBlockChange
  });

  // Initialize sortable for reference cards (testimonials, etc.)
  initSortableCards(formElement, {
    cardSelector: '.reference-card',
    containerSelector: '[data-reference-cards]',
    onReorder: (container) => {
      // Update hidden input names with new indices
      const referenceField = container.closest('.reference-field');
      const fieldPath = referenceField?.dataset.field;
      if (fieldPath) {
        const cards = container.querySelectorAll('.reference-card');
        cards.forEach((card, index) => {
          const input = card.querySelector('input[type="hidden"]');
          if (input) {
            input.name = `${fieldPath}[${index}]`;
          }
        });
      }
    },
    onChange: onBlockChange
  });
}

/**
 * Reusable sortable cards initialization
 * Uses DOM manipulation for reliable drag-and-drop reordering
 */
function initSortableCards(formElement, options) {
  const { cardSelector, containerSelector, onReorder, onChange } = options;

  let draggedCard = null;
  let dropTarget = null;
  let dropPosition = null;

  formElement.addEventListener('dragstart', (e) => {
    const card = e.target.closest(cardSelector);
    if (!card) return;

    draggedCard = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  formElement.addEventListener('dragend', (e) => {
    const card = e.target.closest(cardSelector);
    if (card) {
      card.classList.remove('dragging');
    }

    // Clean up all drop indicators
    formElement.querySelectorAll(cardSelector).forEach(c => {
      c.classList.remove('drop-before', 'drop-after', 'dragging');
    });

    draggedCard = null;
    dropTarget = null;
    dropPosition = null;
  });

  formElement.addEventListener('dragover', (e) => {
    const card = e.target.closest(cardSelector);
    const container = e.target.closest(containerSelector);

    if (!draggedCard || !container) return;

    // Make sure we're in the same container
    if (draggedCard.closest(containerSelector) !== container) return;

    if (card && !card.classList.contains('dragging')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      // Remove existing indicators in this container
      container.querySelectorAll(cardSelector).forEach(c => {
        c.classList.remove('drop-before', 'drop-after');
      });

      // Determine drop position based on cursor location
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      dropPosition = e.clientY < midY ? 'before' : 'after';
      dropTarget = card;

      card.classList.add(dropPosition === 'before' ? 'drop-before' : 'drop-after');
    }
  });

  formElement.addEventListener('drop', (e) => {
    if (!draggedCard || !dropTarget || !dropPosition) return;

    e.preventDefault();
    e.stopPropagation();

    const container = draggedCard.closest(containerSelector);
    if (!container) return;

    const cardToMove = draggedCard;
    const targetCard = dropTarget;
    const position = dropPosition;
    const fromIndex = parseInt(cardToMove.dataset.index, 10);
    let toIndex = parseInt(targetCard.dataset.index, 10);

    // Cleanup state immediately
    draggedCard = null;
    dropTarget = null;
    dropPosition = null;
    targetCard.classList.remove('drop-before', 'drop-after');
    cardToMove.classList.remove('dragging');

    // Calculate actual target index
    if (position === 'after') toIndex += 1;
    if (fromIndex < toIndex) toIndex -= 1;

    // Only proceed if position changed
    if (fromIndex === toIndex) return;

    // Move the DOM element
    if (position === 'before') {
      container.insertBefore(cardToMove, targetCard);
    } else {
      container.insertBefore(cardToMove, targetCard.nextSibling);
    }

    // Reindex all cards
    const cards = container.querySelectorAll(cardSelector);
    cards.forEach((card, newIndex) => {
      card.dataset.index = newIndex;
    });

    // Call reorder callback for type-specific logic
    if (onReorder) {
      onReorder(container, fromIndex, toIndex);
    }

    // Dispatch event for the immediate save (the dashboard's cards-reordered
    // handler persists the reorder). Do NOT also call onChange() — that would
    // schedule a second debounced save behind the immediate one.
    formElement.dispatchEvent(new CustomEvent('cards-reordered', { bubbles: true }));
  });
}

/**
 * Create an empty item based on schema
 */
export function createEmptyArrayItem(schema) {
  if (!schema || schema.type !== 'object') return {};

  const item = {};
  const props = schema.properties || {};

  for (const [key, propSchema] of Object.entries(props)) {
    if (propSchema.default !== undefined) {
      item[key] = propSchema.default;
    } else if (propSchema.type === 'string') {
      item[key] = '';
    } else if (isNumericType(propSchema.type)) {
      item[key] = 0;
    } else if (propSchema.type === 'boolean') {
      item[key] = false;
    } else if (propSchema.type === 'array') {
      item[key] = [];
    } else if (propSchema.type === 'object') {
      item[key] = {};
    }
  }

  return item;
}

/**
 * Point everything inside one array item at its new index.
 *
 * An item carries its own path in two places: the `name` of every input, and the
 * `data-field` of any container inside it (a gallery, a nested inline array, a
 * nested blocks list, a reference field), plus a nested object's
 * `data-object-field`. extractFields reads all of them, so updating
 * only the names left a container writing to the item's OLD index — a block's
 * empty nested array was read back as a phantom extra block, and a gallery saved
 * its images onto whichever block used to sit there.
 *
 * Matching the full `<arrayPath>[<oldIndex>]` prefix, rather than the first `[n]`
 * in the string, keeps this right for an array that is itself inside another
 * array item (`blocks[0].points[2]`).
 */
function repointItemPaths(item, arrayPath, oldIndex, newIndex) {
  const oldPrefix = `${arrayPath}[${oldIndex}]`;
  const newPrefix = `${arrayPath}[${newIndex}]`;
  if (oldPrefix === newPrefix) return;
  const repoint = (path) => (
    path === oldPrefix || path.startsWith(`${oldPrefix}.`) || path.startsWith(`${oldPrefix}[`)
      ? newPrefix + path.slice(oldPrefix.length)
      : path
  );

  // An id is the form's prefix plus the name with `.[]` as `_`
  // (generateField). The prefix is kept as it is, and each label that pointed
  // at an old id follows its control: rebuilding ids without the prefix, and
  // rewriting the first `_<n>_` of a label (which in `rows_0_blocks_1_x` is the
  // row, not the block), left labels focusing the wrong input (#56).
  const idOf = (name) => name.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
  const newIds = new Map();
  item.querySelectorAll('input, textarea, select').forEach(input => {
    if (!input.name) return;
    const newName = repoint(input.name);
    if (newName === input.name) return;
    const oldId = input.id;
    if (oldId && oldId.endsWith(idOf(input.name))) {
      const newId = oldId.slice(0, oldId.length - idOf(input.name).length) + idOf(newName);
      newIds.set(oldId, newId);
      input.id = newId;
    }
    input.name = newName;
  });
  item.querySelectorAll('label[for]').forEach(label => {
    const newId = newIds.get(label.htmlFor);
    if (newId) label.htmlFor = newId;
  });

  item.querySelectorAll('[data-field]').forEach(element => {
    element.dataset.field = repoint(element.dataset.field);
  });
  item.querySelectorAll('[data-object-field]').forEach(element => {
    element.dataset.objectField = repoint(element.dataset.objectField);
  });
  item.querySelectorAll('[data-edit-gallery]').forEach(element => {
    element.dataset.editGallery = repoint(element.dataset.editGallery);
  });
}

/**
 * The items of a list itself — not the items of an array nested inside one of them.
 */
function directItems(list, className) {
  return Array.from(list.children).filter(child => child.classList.contains(className));
}

/**
 * Renumber a list's items in their current order: each item's `data-index`
 * and every path inside it (repointItemPaths). Shared by inline lists, block
 * lists and the dashboard's reference lists.
 * @param {Iterable<HTMLElement>} items - the list's own items, in order
 * @param {string} fieldPath - the list's path (`blocks`, `rows[0].tags`)
 */
export function reindexItems(items, fieldPath) {
  Array.from(items).forEach((item, newIndex) => {
    const oldIndex = Number(item.dataset.index);
    item.dataset.index = newIndex;
    repointItemPaths(item, fieldPath, oldIndex, newIndex);
  });
}

/**
 * Reindex blocks after reordering or removal.
 * Walks every blocks list in the form (outer lists first, in document order), not
 * only the first one: a form can hold more than one, e.g. `section.blocks`.
 */
function reindexBlocks(formElement) {
  formElement.querySelectorAll('.blocks-list').forEach(blocksList => {
    reindexItems(directItems(blocksList, 'block-item'), blocksList.dataset.field);
  });
}

/**
 * Reindex array items after removal
 */
function reindexArrayItems(arrayField) {
  reindexItems(directItems(arrayField, 'array-item'), arrayField.dataset.field);
}

/**
 * Create an empty block of a given type
 */
export function createEmptyBlock(blockType, blockSchema) {
  const block = { type: blockType };

  if (blockSchema?.properties) {
    for (const [key, schema] of Object.entries(blockSchema.properties)) {
      if (key === 'type') continue;

      if (schema.default !== undefined) {
        block[key] = schema.default;
      } else if (schema.type === 'array') {
        block[key] = [];
      } else if (schema.type === 'object') {
        block[key] = {};
      } else if (isNumericType(schema.type)) {
        block[key] = 0;
      } else if (schema.type === 'boolean') {
        block[key] = false;
      } else {
        block[key] = '';
      }
    }
  }

  return block;
}
