/**
 * Schema Parser for AstroAdmin
 *
 * Parses Zod schemas from Astro's src/content/config.ts
 * using esbuild to bundle and zod-to-json-schema for conversion.
 */

import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import zodToJsonSchema from 'zod-to-json-schema';

/** zod 3 has no .meta(): its reference() stand-in carries this description. */
const REFERENCE_DESCRIPTION_PREFIX = 'astroadmin-reference:';

/**
 * Minimal shim for astro:content virtual module.
 * astro:content just re-exports zod and provides defineCollection.
 */
const ASTRO_CONTENT_SHIM = `
import { z } from 'zod';
export { z };
export const defineCollection = (config) => config;
// Astro's reference() is a zod schema over an entry id. It must be one here
// too: a plain object made toJSONSchema throw for the whole site. The target
// collection rides along as JSON Schema metadata (zod 4 .meta()), or in the
// description for zod 3, which has no .meta(); see annotateReferences.
export const reference = (collection) => {
  const id = z.string();
  return typeof id.meta === 'function'
    ? id.meta({ referenceCollection: collection })
    : id.describe('${REFERENCE_DESCRIPTION_PREFIX}' + collection);
};
`;

/**
 * Shim for astro/loaders module (Astro 5+).
 * Provides file() and glob() loader functions that record loader metadata.
 */
const ASTRO_LOADERS_SHIM = `
export const file = (filePath) => ({
  _type: 'file',
  _filePath: filePath,
});

export const glob = (options) => ({
  _type: 'glob',
  _base: options.base,
  _pattern: options.pattern,
});
`;

/**
 * Shim for astroadmin/loader. The real loader imports bun:sqlite (a Bun
 * builtin esbuild can't bundle) and opens the database, so during schema
 * parsing we replace it with a stub that only records loader metadata.
 */
const ASTROADMIN_LOADER_SHIM = `
export const astroadminLoader = (options = {}) => ({
  _type: 'db',
  _dataType: options.type,
});
`;

/**
 * Parse Astro content collection schemas from config.ts
 *
 * @param {string} projectRoot - Astro project root directory
 * @returns {Promise<Object>} - Collection schemas in JSON Schema format
 */
export async function parseAstroSchemas(projectRoot) {
  // Look for the content config file (Astro 6 convention).
  const possiblePaths = [
    path.join(projectRoot, 'src/content.config.ts'),
    path.join(projectRoot, 'src/content.config.mts'),
    path.join(projectRoot, 'src/content.config.js'),
    path.join(projectRoot, 'src/content.config.mjs'),
  ];

  let configPath = null;
  for (const p of possiblePaths) {
    try {
      await fs.access(p);
      configPath = p;
      break;
    } catch {
      // Continue checking
    }
  }

  if (!configPath) {
    throw new Error(
      `No content config found. Checked:\n${possiblePaths.map(p => `  - ${p}`).join('\n')}`
    );
  }

  console.log(`📄 Found content config: ${configPath}`);

  // Bundle with esbuild
  let result;
  try {
    result = await esbuild.build({
      entryPoints: [configPath],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      // Tell esbuild where to find node_modules (for zod resolution)
      nodePaths: [path.join(projectRoot, 'node_modules')],
      plugins: [
        {
          name: 'astro-shims',
          setup(build) {
            // Resolve 'zod' to the project's node_modules
            build.onResolve({ filter: /^zod$/ }, () => ({
              path: path.join(projectRoot, 'node_modules', 'zod', 'index.js'),
            }));

            // Intercept astro:content import
            build.onResolve({ filter: /^astro:content$/ }, () => ({
              path: 'astro:content',
              namespace: 'astro-content-shim',
            }));

            // Intercept astro/loaders import (Astro 5+)
            build.onResolve({ filter: /^astro\/loaders$/ }, () => ({
              path: 'astro/loaders',
              namespace: 'astro-loaders-shim',
            }));

            // Intercept astroadmin/loader import (DB-backed collections)
            build.onResolve({ filter: /^astroadmin\/loader$/ }, () => ({
              path: 'astroadmin/loader',
              namespace: 'astroadmin-loader-shim',
            }));

            // Provide astro:content shim
            build.onLoad({ filter: /.*/, namespace: 'astro-content-shim' }, () => ({
              contents: ASTRO_CONTENT_SHIM,
              loader: 'js',
              resolveDir: projectRoot,
            }));

            // Provide astro/loaders shim
            build.onLoad({ filter: /.*/, namespace: 'astro-loaders-shim' }, () => ({
              contents: ASTRO_LOADERS_SHIM,
              loader: 'js',
              resolveDir: projectRoot,
            }));

            // Provide astroadmin/loader shim
            build.onLoad({ filter: /.*/, namespace: 'astroadmin-loader-shim' }, () => ({
              contents: ASTROADMIN_LOADER_SHIM,
              loader: 'js',
              resolveDir: projectRoot,
            }));
          },
        },
      ],
    });
  } catch (error) {
    throw new Error(`Failed to bundle config.ts: ${error.message}`);
  }

  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('esbuild produced no output');
  }

  // Write temp file inside the project so it can resolve node_modules
  // This allows the dynamic import to find 'zod' from the project's dependencies
  const cacheDir = path.join(projectRoot, 'node_modules', '.cache', 'astroadmin');
  await fs.mkdir(cacheDir, { recursive: true });
  const tempPath = path.join(cacheDir, `schema-${Date.now()}.mjs`);

  try {
    await fs.writeFile(tempPath, result.outputFiles[0].text);

    // Dynamic import the bundled module
    const module = await import(tempPath);

    if (!module.collections) {
      throw new Error(
        'config.ts does not export "collections". Make sure you have:\n' +
        '  export const collections = { ... };'
      );
    }

    // Import zod from the project to create the image helper
    const { z } = await import('zod');

    // Create a mock image() helper that returns a string schema
    // (Astro's image() helper validates image paths and returns image metadata)
    const imageHelper = () => z.string().describe('Image path');

    // Convert each collection's Zod schema to JSON Schema
    const schemas = {};
    // References resolve against the collections this config declares.
    const declaredCollections = new Set(Object.keys(module.collections));

    console.log(`📋 Found ${Object.keys(module.collections).length} collections: ${Object.keys(module.collections).join(', ')}`);

    for (const [name, collection] of Object.entries(module.collections)) {
      // Get loader type if available (from our shim)
      const loaderType = collection.loader?._type || 'glob'; // default to glob
      const loaderFilePath = collection.loader?._filePath;
      const loaderBase = collection.loader?._base;
      const loaderPattern = collection.loader?._pattern;

      console.log(`   Processing "${name}" (loader: ${loaderType}, has schema: ${!!collection.schema})`);

      // Resolve the schema - it might be a function that needs to be called
      let zodSchema = collection.schema;

      if (typeof zodSchema === 'function') {
        // Call the schema function with helpers (image, etc.)
        try {
          zodSchema = zodSchema({ image: imageHelper });
        } catch (err) {
          console.warn(`⚠️  Failed to evaluate schema function for "${name}": ${err.message}`);
          zodSchema = null;
        }
      }

      // Collections without explicit schemas get an empty schema
      // (they still have entries, just no frontmatter validation)
      if (!zodSchema) {
        console.log(`📝 Collection "${name}" has no explicit schema (using empty schema)`);
        schemas[name] = {
          name,
          type: collection.type || collection.loader?._dataType || (loaderType === 'file' ? 'data' : 'content'),
          loaderType,
          loaderFilePath,
          loaderBase,
          loaderPattern,
          schema: { type: 'object', properties: {} },
          discriminatedUnions: [],
          blockCollectionRefs: {},
        };
        continue;
      }

      try {
        // Convert Zod schema to JSON Schema (zod 3 and zod 4 — see toJsonSchema)
        const jsonSchema = toJsonSchema(zodSchema);

        // Find discriminated unions for block UI
        const discriminatedUnions = findDiscriminatedUnions(zodSchema);

        // Mark every reference field with its target collection, in the
        // entry schema and in each block's own schema (the block editor
        // renders from those).
        annotateReferences(jsonSchema, declaredCollections);
        for (const union of discriminatedUnions) {
          for (const option of union.options) annotateReferences(option.schema, declaredCollections);
        }

        // Detect which collections this schema's blocks reference
        const blockCollectionRefs = detectBlockCollectionReferences(
          discriminatedUnions,
          declaredCollections
        );

        schemas[name] = {
          name,
          type: collection.type || collection.loader?._dataType || (loaderType === 'file' ? 'data' : 'content'),
          loaderType,
          loaderFilePath, // For file() loader: the JSON file path
          loaderBase, // For glob() loader: the base directory
          loaderPattern, // For glob() loader: the match pattern(s)
          schema: jsonSchema,
          discriminatedUnions,
          blockCollectionRefs,
          // Store raw Zod schema for advanced introspection
          _zodSchema: zodSchema,
        };

        console.log(`✅ Parsed schema for "${name}" (${discriminatedUnions.length} discriminated unions)`);
      } catch (error) {
        console.error(`❌ Failed to parse schema for "${name}":`, error.message);
        throw error;
      }
    }

    return schemas;
  } finally {
    // Clean up temp file
    await fs.unlink(tempPath).catch(() => {});
  }
}

/**
 * Recursively find discriminated unions in a Zod schema.
 * These are used for the block editor UI.
 *
 * @param {Object} schema - Zod schema
 * @param {string[]} path - Current path in schema
 * @returns {Array} - List of discriminated unions found
 */
/**
 * Convert a Zod schema to JSON Schema, tolerant of zod 3 and zod 4.
 *
 * Astro 6 depends on zod 4, whose internals differ from zod 3 — and the
 * external `zod-to-json-schema` package does NOT understand zod 4 (it silently
 * returns an empty schema, which would render admin forms with no fields). zod
 * 4 ships a native serializer instead. We prefer the schema's OWN native
 * `.toJSONSchema()` method so the serializer always matches the zod copy that
 * built the schema (the site's bundled zod), and fall back to the package for
 * zod 3, which has no native serializer.
 *
 * Options for the zod 4 path:
 *   - reused: 'inline'        inline reused subschemas (no $ref/$defs), matching
 *                             the old `$refStrategy: 'none'` behaviour the UI expects
 *   - unrepresentable: 'any'  emit {} for JSON-unrepresentable types (e.g.
 *                             z.coerce.date()) instead of throwing
 *   - io: 'input'             describe the editable INPUT shape (defaults optional)
 *   - override                a date (z.date(), z.coerce.date()) becomes
 *                             {type: 'string', format: 'date'}. Left as {} it
 *                             rendered as a date input only when its NAME looked
 *                             like a date (`publishDate`), and as a textarea
 *                             otherwise (`joined`). zod 3's serializer already
 *                             emits a date format.
 *                             It is also marked `x-astroadmin-date: true` (zod 3:
 *                             markZod3Dates), the only thing that tells it from
 *                             a string with a date format (z.iso.date()).
 */
function toJsonSchema(zodSchema) {
  if (typeof zodSchema?.toJSONSchema === 'function') {
    return zodSchema.toJSONSchema({
      reused: 'inline',
      unrepresentable: 'any',
      io: 'input',
      override: (ctx) => {
        if (ctx.zodSchema?._zod?.def?.type === 'date') {
          ctx.jsonSchema.type = 'string';
          ctx.jsonSchema.format = 'date';
          ctx.jsonSchema[DATE_MARKER] = true;
        }
      },
    });
  }
  const jsonSchema = zodToJsonSchema(zodSchema, { $refStrategy: 'none', errorMessages: true });
  markZod3Dates(zodSchema, jsonSchema);
  return jsonSchema;
}

/**
 * Marks a REAL date (z.date(), z.coerce.date()) in the JSON Schema, as opposed
 * to a string that only has a date format (zod 4 z.iso.date(), zod 3
 * z.string().date()). Both serialise as `format: 'date'`, but only a real date
 * may be written to frontmatter as an unquoted YAML date: the string forms
 * refuse a Date.
 */
const DATE_MARKER = 'x-astroadmin-date';

/**
 * zod 3 has no serializer override, so walk the zod schema beside its JSON
 * Schema and mark the ZodDate nodes (through optional/nullable/default/effects,
 * objects and arrays).
 */
function markZod3Dates(zodSchema, jsonNode) {
  const def = zodSchema?._def;
  if (!def || !jsonNode || typeof jsonNode !== 'object') return;
  switch (def.typeName) {
    case 'ZodDate':
      jsonNode[DATE_MARKER] = true;
      return;
    case 'ZodOptional':
    case 'ZodDefault':
      markZod3Dates(def.innerType, jsonNode);
      return;
    case 'ZodNullable': {
      const member = (jsonNode.anyOf || []).find((m) => m?.type !== 'null');
      markZod3Dates(def.innerType, member || jsonNode);
      return;
    }
    case 'ZodEffects':
      markZod3Dates(def.schema, jsonNode);
      return;
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      for (const [key, child] of Object.entries(shape || {})) {
        markZod3Dates(child, jsonNode.properties?.[key]);
      }
      return;
    }
    case 'ZodArray':
      markZod3Dates(def.type, jsonNode.items);
      return;
    default:
  }
}

/**
 * Normalise zod 3 vs zod 4 schema internals into a uniform node, or null for a
 * non-schema value. zod 3 exposes `_def` (with a `typeName` string); zod 4
 * exposes `_zod.def` (with a `type` string) and distinguishes some kinds by
 * constructor name (e.g. ZodDiscriminatedUnion, which shares type 'union').
 */
function zodInternals(schema) {
  if (!schema) return null;
  if (schema._zod?.def) {
    return { version: 4, def: schema._zod.def, ctor: schema.constructor?.name };
  }
  if (schema._def) {
    return { version: 3, def: schema._def, ctor: schema._def.typeName };
  }
  return null;
}

/** Uniform kind string ('object'|'array'|'literal'|'optional'|'nullable'|'default'|'discriminatedUnion'|…). */
function zodKind(node) {
  if (!node) return null;
  if (node.version === 4) {
    if (node.def.type === 'union' && node.ctor === 'ZodDiscriminatedUnion') {
      return 'discriminatedUnion';
    }
    return node.def.type;
  }
  switch (node.def.typeName) {
    case 'ZodDiscriminatedUnion': return 'discriminatedUnion';
    case 'ZodObject': return 'object';
    case 'ZodArray': return 'array';
    case 'ZodLiteral': return 'literal';
    case 'ZodOptional': return 'optional';
    case 'ZodNullable': return 'nullable';
    case 'ZodDefault': return 'default';
    default: return node.def.typeName;
  }
}

/** Object field map. zod 4 `def.shape` is a plain object; zod 3's is a function. */
function zodObjectShape(node) {
  const shape = node.def.shape;
  return typeof shape === 'function' ? shape() : shape;
}

/** Array element schema (zod 4: def.element; zod 3: def.type). */
function zodArrayElement(node) {
  return node.version === 4 ? node.def.element : node.def.type;
}

/** Literal value (zod 4 stores values in def.values[]; zod 3 in def.value). */
function zodLiteralValue(node) {
  if (node.version === 4) {
    return Array.isArray(node.def.values) ? node.def.values[0] : node.def.values;
  }
  return node.def.value;
}

function findDiscriminatedUnions(schema, currentPath = []) {
  const unions = [];

  const node = zodInternals(schema);
  if (!node) return unions;

  const kind = zodKind(node);

  // Check if this is a discriminated union
  if (kind === 'discriminatedUnion') {
    const discriminator = node.def.discriminator;
    const options = [];

    // Extract options from the union
    for (const option of node.def.options) {
      const optionNode = zodInternals(option);
      if (zodKind(optionNode) === 'object') {
        const shape = zodObjectShape(optionNode);
        const discriminatorNode = zodInternals(shape[discriminator]);

        if (discriminatorNode && zodKind(discriminatorNode) === 'literal') {
          const value = zodLiteralValue(discriminatorNode);

          // Convert the option schema to JSON Schema
          let optionSchema;
          try {
            optionSchema = toJsonSchema(option);
          } catch {
            optionSchema = { type: 'object' };
          }

          options.push({
            value,
            label: optionSchema?.title || formatLabel(value),
            schema: optionSchema,
          });
        }
      }
    }

    unions.push({
      path: currentPath,
      discriminator,
      options,
    });
  }

  // Recurse into objects
  if (kind === 'object') {
    const shape = zodObjectShape(node);
    for (const [key, value] of Object.entries(shape)) {
      unions.push(...findDiscriminatedUnions(value, [...currentPath, key]));
    }
  }

  // Recurse into arrays
  if (kind === 'array') {
    unions.push(...findDiscriminatedUnions(zodArrayElement(node), [...currentPath, '[]']));
  }

  // Recurse into optionals, nullables and defaults (single inner type)
  if (kind === 'optional' || kind === 'nullable' || kind === 'default') {
    unions.push(...findDiscriminatedUnions(node.def.innerType, currentPath));
  }

  return unions;
}

/**
 * Detect which blocks reference which collections (for the component preview:
 * which block types can show an entry of a collection). Reads the
 * `referenceCollection` marks annotateReferences left on each block's schema,
 * plus a single `<base>Id` string that names a declared collection.
 *
 * @param {Array} discriminatedUnions - Discriminated unions found in schema
 * @param {Set<string>} declaredCollections - collection names in the config
 * @returns {Object} - Map of collection -> array of { blockType, field }
 */
function detectBlockCollectionReferences(discriminatedUnions, declaredCollections) {
  /** @type {Record<string, Array<{blockType: string, field: string}>>} */
  const collectionRefs = {};

  for (const union of discriminatedUnions) {
    for (const option of union.options) {
      const blockType = option.value;
      const properties = option.schema?.properties;
      if (!properties) continue;

      for (const [fieldName, fieldSchema] of Object.entries(properties)) {
        let collectionName = fieldSchema?.referenceCollection || null;
        if (!collectionName && fieldSchema?.type === 'string' && fieldName.endsWith('Id')) {
          collectionName = resolveCollectionName(fieldName.slice(0, -2), declaredCollections);
        }
        if (!collectionName) continue;
        if (!collectionRefs[collectionName]) collectionRefs[collectionName] = [];
        collectionRefs[collectionName].push({ blockType, field: fieldName });
      }
    }
  }

  return collectionRefs;
}

/**
 * The declared collection a field-name stem refers to, or null. Tries
 * `<base>s`, `<base>`, `<base>es`, then y -> ies (`teamIds` finds a collection
 * named `teams` or `team`; `categoryIds` finds `categories`). Exact names only.
 *
 * @param {string} base - the field name without its `Ids`/`Id` suffix
 * @param {Set<string>} declaredCollections
 * @returns {string|null}
 */
export function resolveCollectionName(base, declaredCollections) {
  if (!base) return null;
  const candidates = [`${base}s`, base, `${base}es`];
  if (/[^aeiou]y$/.test(base)) candidates.push(`${base.slice(0, -1)}ies`);
  return candidates.find((name) => declaredCollections.has(name)) || null;
}

/** The collection a reference() stand-in names: zod 4 metadata, or the zod 3 description. */
function referenceTarget(node) {
  if (typeof node.referenceCollection === 'string') return node.referenceCollection;
  if (typeof node.description === 'string' && node.description.startsWith(REFERENCE_DESCRIPTION_PREFIX)) {
    return node.description.slice(REFERENCE_DESCRIPTION_PREFIX.length);
  }
  return null;
}

/**
 * Mark every reference field in a JSON Schema with `referenceCollection`, in
 * place, so the editor renders the reference picker for it:
 *   - reference('c')                    -> {type: 'string', referenceCollection: 'c'}
 *   - z.array(reference('c'))           -> the array node gets it too
 *   - `<base>Ids: z.array(z.string())`  -> the declared collection
 *     resolveCollectionName finds; a name that finds nothing is left alone and
 *     renders as a plain list.
 * A reference to an undeclared collection is not marked: there is nothing to
 * pick from, so the field stays a plain input.
 *
 * @param {object} node - JSON Schema node (mutated)
 * @param {Set<string>} declaredCollections
 * @param {string} [name] - the property name this node is the value of
 */
function annotateReferences(node, declaredCollections, name = '') {
  if (!node || typeof node !== 'object') return;

  const target = referenceTarget(node);
  if (target) {
    if (node.description === `${REFERENCE_DESCRIPTION_PREFIX}${target}`) delete node.description;
    if (declaredCollections.has(target)) node.referenceCollection = target;
    else delete node.referenceCollection;
  }

  // A nullable field is {anyOf: [<field>, {type: 'null'}]}.
  for (const member of [...(node.anyOf || []), ...(node.oneOf || [])]) {
    annotateReferences(member, declaredCollections, name);
  }

  if (node.type === 'array' && node.items && typeof node.items === 'object') {
    annotateReferences(node.items, declaredCollections);
    if (node.items.type === 'string' && !node.referenceCollection) {
      const collection = node.items.referenceCollection
        || (name.endsWith('Ids') ? resolveCollectionName(name.slice(0, -3), declaredCollections) : null);
      if (collection) node.referenceCollection = collection;
    }
  }

  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties)) {
      annotateReferences(child, declaredCollections, key);
    }
  }
}

/**
 * Humanise a block type for display: first word capitalised, the rest lower
 * case ('hero' -> 'Hero', 'featureGrid' -> 'Feature grid'). The same rule as
 * the editor's humanizeName (ui/form-generator.js).
 */
function formatLabel(value) {
  if (typeof value !== 'string') return String(value);
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
 * Convert a JSON Schema property to form field metadata
 */
export function schemaToFormField(name, property, required = false) {
  const field = {
    name,
    required,
    label: formatLabel(name),
  };

  // Handle type
  if (property.type === 'string') {
    field.type = 'string';
    if (property.enum) {
      field.type = 'enum';
      field.options = property.enum;
    }
    if (property.format === 'email') field.inputType = 'email';
    if (property.format === 'uri' || property.format === 'url') field.inputType = 'url';
    if (property.format === 'date') field.inputType = 'date';
    if (property.format === 'date-time') field.inputType = 'datetime-local';
  } else if (property.type === 'number' || property.type === 'integer') {
    field.type = 'number';
    if (property.minimum !== undefined) field.min = property.minimum;
    if (property.maximum !== undefined) field.max = property.maximum;
  } else if (property.type === 'boolean') {
    field.type = 'boolean';
  } else if (property.type === 'array') {
    field.type = 'array';
    field.items = property.items;
  } else if (property.type === 'object') {
    field.type = 'object';
    field.properties = property.properties;
  }

  // Handle descriptions
  if (property.description) {
    field.description = property.description;
  }

  // Handle defaults
  if (property.default !== undefined) {
    field.default = property.default;
  }

  return field;
}
