/**
 * Astro file parser utility
 * Parses .astro files to extract collection references using Babel AST
 */

import fs from 'fs/promises';
import { parse } from '@babel/parser';
import { config } from '../config.js';

/**
 * Parse an Astro file and extract collection references
 * Looks for getEntry() and getCollection() calls to identify which collections are used
 *
 * @param {string} filePath - Absolute path to the .astro file
 * @returns {Promise<string[]>} - Array of collection names referenced in the file
 */
export async function parseAstroCollectionRefs(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // Extract frontmatter script (between --- delimiters)
    const frontmatter = extractFrontmatter(content);
    if (!frontmatter) {
      return [];
    }

    // Parse with Babel
    const ast = parse(frontmatter, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });

    // Traverse AST to find getEntry/getCollection calls
    const collections = new Set();
    traverseForCollectionCalls(ast, collections);

    return Array.from(collections);
  } catch (error) {
    // Silently fail for unparseable files
    if (config.debug) {
      console.warn(`Failed to parse ${filePath}:`, error.message);
    }
    return [];
  }
}

/**
 * Extract frontmatter script from Astro file content
 * Frontmatter is the code between the --- delimiters at the top
 *
 * @param {string} content - Full .astro file content
 * @returns {string|null} - Frontmatter code or null if not found
 */
function extractFrontmatter(content) {
  // Match content between --- delimiters at the start of the file
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

/**
 * Traverse AST to find getEntry and getCollection calls
 * Extracts the first argument (collection name) from each call
 *
 * @param {object} node - AST node to traverse
 * @param {Set<string>} collections - Set to collect found collection names
 */
function traverseForCollectionCalls(node, collections) {
  if (!node || typeof node !== 'object') {
    return;
  }

  // Check if this is a CallExpression for getEntry or getCollection
  if (node.type === 'CallExpression') {
    const calleeName = getCalleeName(node.callee);

    if (calleeName === 'getEntry' || calleeName === 'getCollection') {
      // First argument should be the collection name
      const firstArg = node.arguments?.[0];
      if (firstArg?.type === 'StringLiteral') {
        collections.add(firstArg.value);
      }
    }
  }

  // Recursively traverse child nodes
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        traverseForCollectionCalls(item, collections);
      }
    } else if (child && typeof child === 'object') {
      traverseForCollectionCalls(child, collections);
    }
  }
}

/**
 * Get the name of a callee expression
 * Handles both direct identifiers and member expressions
 *
 * @param {object} callee - AST callee node
 * @returns {string|null} - Function name or null
 */
function getCalleeName(callee) {
  // Direct call: getEntry(...)
  if (callee.type === 'Identifier') {
    return callee.name;
  }

  // Member expression: Astro.getEntry(...) - though not typically used
  if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
    return callee.property.name;
  }

  return null;
}
