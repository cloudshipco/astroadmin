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

/**
 * Minimal shim for astro:content virtual module.
 * astro:content just re-exports zod and provides defineCollection.
 */
const ASTRO_CONTENT_SHIM = `
export { z } from 'zod';
export const defineCollection = (config) => config;
export const reference = (collection) => ({ _type: 'reference', collection });
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
 * Parse Astro content collection schemas from config.ts
 *
 * @param {string} projectRoot - Astro project root directory
 * @returns {Promise<Object>} - Collection schemas in JSON Schema format
 */
export async function parseAstroSchemas(projectRoot) {
  // Look for config file
  // Astro 5+: src/content.config.ts (new convention)
  // Astro 4.x: src/content/config.ts (legacy convention)
  const possiblePaths = [
    // Astro 5+ locations (check first)
    path.join(projectRoot, 'src/content.config.ts'),
    path.join(projectRoot, 'src/content.config.mts'),
    path.join(projectRoot, 'src/content.config.js'),
    path.join(projectRoot, 'src/content.config.mjs'),
    // Astro 4.x legacy locations
    path.join(projectRoot, 'src/content/config.ts'),
    path.join(projectRoot, 'src/content/config.mts'),
    path.join(projectRoot, 'src/content/config.js'),
    path.join(projectRoot, 'src/content/config.mjs'),
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
      // Use project's zod installation, don't bundle it
      external: ['zod'],
      plugins: [
        {
          name: 'astro-shims',
          setup(build) {
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

            // Provide astro:content shim
            build.onLoad({ filter: /.*/, namespace: 'astro-content-shim' }, () => ({
              contents: ASTRO_CONTENT_SHIM,
              loader: 'js',
            }));

            // Provide astro/loaders shim
            build.onLoad({ filter: /.*/, namespace: 'astro-loaders-shim' }, () => ({
              contents: ASTRO_LOADERS_SHIM,
              loader: 'js',
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

    console.log(`📋 Found ${Object.keys(module.collections).length} collections: ${Object.keys(module.collections).join(', ')}`);

    for (const [name, collection] of Object.entries(module.collections)) {
      // Get loader type if available (from our shim)
      const loaderType = collection.loader?._type || 'glob'; // default to glob
      const loaderFilePath = collection.loader?._filePath;

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
          type: collection.type || (loaderType === 'file' ? 'data' : 'content'),
          loaderType,
          loaderFilePath,
          schema: { type: 'object', properties: {} },
          discriminatedUnions: [],
          blockCollectionRefs: {},
        };
        continue;
      }

      try {
        // Convert Zod schema to JSON Schema
        // Don't pass 'name' option - it causes wrapping in definitions
        const jsonSchema = zodToJsonSchema(zodSchema, {
          $refStrategy: 'none', // Inline all refs for simplicity
          errorMessages: true,
        });

        // Find discriminated unions for block UI
        const discriminatedUnions = findDiscriminatedUnions(zodSchema);

        // Detect which collections this schema's blocks reference
        const blockCollectionRefs = detectBlockCollectionReferences(
          discriminatedUnions,
          jsonSchema
        );

        schemas[name] = {
          name,
          type: collection.type || (loaderType === 'file' ? 'data' : 'content'),
          loaderType,
          loaderFilePath, // For file() loader: the JSON file path
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
function findDiscriminatedUnions(schema, currentPath = []) {
  const unions = [];

  if (!schema || !schema._def) {
    return unions;
  }

  const typeName = schema._def.typeName;

  // Check if this is a discriminated union
  if (typeName === 'ZodDiscriminatedUnion') {
    const discriminator = schema._def.discriminator;
    const options = [];

    // Extract options from the union
    for (const option of schema._def.options) {
      if (option._def?.typeName === 'ZodObject') {
        const shape = option._def.shape();
        const discriminatorField = shape[discriminator];

        if (discriminatorField?._def?.typeName === 'ZodLiteral') {
          const value = discriminatorField._def.value;

          // Convert the option schema to JSON Schema
          let optionSchema;
          try {
            optionSchema = zodToJsonSchema(option, {
              $refStrategy: 'none',
            });
          } catch {
            optionSchema = { type: 'object' };
          }

          options.push({
            value,
            label: formatLabel(value),
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
  if (typeName === 'ZodObject') {
    const shape = schema._def.shape();
    for (const [key, value] of Object.entries(shape)) {
      unions.push(...findDiscriminatedUnions(value, [...currentPath, key]));
    }
  }

  // Recurse into arrays
  if (typeName === 'ZodArray') {
    unions.push(...findDiscriminatedUnions(schema._def.type, [...currentPath, '[]']));
  }

  // Recurse into optionals
  if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
    unions.push(...findDiscriminatedUnions(schema._def.innerType, currentPath));
  }

  // Recurse into defaults
  if (typeName === 'ZodDefault') {
    unions.push(...findDiscriminatedUnions(schema._def.innerType, currentPath));
  }

  return unions;
}

/**
 * Detect which blocks reference which collections.
 * Analyzes discriminated union options to find fields like `testimonialIds`
 * that reference other collections.
 *
 * @param {Array} discriminatedUnions - Discriminated unions found in schema
 * @param {Object} jsonSchema - The full JSON Schema
 * @returns {Object} - Map of collection -> array of { blockType, field }
 */
function detectBlockCollectionReferences(discriminatedUnions, jsonSchema) {
  /** @type {Record<string, Array<{blockType: string, field: string}>>} */
  const collectionRefs = {};

  // Check each discriminated union (usually one for "blocks" field)
  for (const union of discriminatedUnions) {
    // Each option is a block type
    for (const option of union.options) {
      const blockType = option.value;
      const blockSchema = option.schema;

      if (!blockSchema?.properties) continue;

      // Look for fields that look like collection references
      // Pattern: fieldName ends with "Ids" and is an array of strings
      for (const [fieldName, fieldSchema] of Object.entries(blockSchema.properties)) {
        const collectionName = inferCollectionFromFieldName(fieldName, fieldSchema);
        if (collectionName) {
          if (!collectionRefs[collectionName]) {
            collectionRefs[collectionName] = [];
          }
          collectionRefs[collectionName].push({
            blockType,
            field: fieldName,
          });
        }
      }
    }
  }

  return collectionRefs;
}

/**
 * Infer collection name from field name and schema.
 * - testimonialIds → testimonials (array of strings ending in "Ids")
 * - pageId → pages (single string ending in "Id")
 *
 * @param {string} fieldName - The field name
 * @param {Object} fieldSchema - The JSON Schema for the field
 * @returns {string|null} - Collection name or null if not a reference
 */
function inferCollectionFromFieldName(fieldName, fieldSchema) {
  // Check for array of strings (e.g., testimonialIds: z.array(z.string()))
  if (
    fieldSchema.type === 'array' &&
    fieldSchema.items?.type === 'string' &&
    fieldName.endsWith('Ids')
  ) {
    const base = fieldName.slice(0, -3); // Remove 'Ids'
    // Pluralize: testimonial → testimonials
    return base.endsWith('s') ? base : base + 's';
  }

  // Check for single string reference (e.g., authorId: z.string())
  if (fieldSchema.type === 'string' && fieldName.endsWith('Id')) {
    const base = fieldName.slice(0, -2); // Remove 'Id'
    // Pluralize: author → authors
    return base.endsWith('s') ? base : base + 's';
  }

  return null;
}

/**
 * Format a value as a human-readable label
 * e.g., 'heroBlock' -> 'Hero Block'
 */
function formatLabel(value) {
  if (typeof value !== 'string') return String(value);

  return value
    // Insert space before capitals
    .replace(/([A-Z])/g, ' $1')
    // Capitalize first letter
    .replace(/^./, str => str.toUpperCase())
    .trim();
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
