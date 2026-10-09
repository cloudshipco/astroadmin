/**
 * Static facts about a site, read without running its code: its astro.config
 * (parsed, not imported), what git tracks, whether it uses astro:assets, and
 * whether sharp loads in the runtime the publish check builds with.
 */

import { parse } from '@babel/parser';
import { execFile, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const ASTRO_CONFIG_NAMES = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.mts', 'astro.config.cjs'];
const INTEGRATION_MODULE = 'astroadmin/integration';
const LOCKFILE_NAMES = ['bun.lock', 'bun.lockb'];
const SOURCE_EXTENSIONS = new Set(['.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.md', '.mdx']);
const SHARP_TIMEOUT_MS = 20_000;

/**
 * @typedef {Object} AstroConfigFacts
 * @property {string|null} file - the config's file name, or null if there is none
 * @property {string|null} parseError
 * @property {boolean} integrationImported - imports astroadmin/integration
 * @property {boolean} integrationCalled - and calls what it imported
 * @property {'set'|'missing'|'unknown'} allowedHosts - vite.server.allowedHosts
 * @property {'disabled'|'enabled'|'unknown'} hmr - vite.server.hmr
 * @property {string|null} outDir
 */

/** Every node in a Babel AST, depth first. */
function* walkNodes(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walkNodes(child);
    return;
  }
  if (typeof node.type !== 'string') return;
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    if (value && typeof value === 'object') yield* walkNodes(value);
  }
}

function propertyName(property) {
  if (property.type !== 'ObjectProperty') return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'StringLiteral') return property.key.value;
  return null;
}

/** The value node of `object.name`, or undefined when not statically present. */
function getProperty(objectNode, name) {
  if (objectNode?.type !== 'ObjectExpression') return undefined;
  const property = objectNode.properties.find((candidate) => propertyName(candidate) === name);
  return property?.value;
}

/**
 * The object literal the config exports: `export default defineConfig({...})`,
 * `export default {...}`, or either through a const.
 */
function findConfigObject(ast) {
  const exported = ast.program.body.find((node) => node.type === 'ExportDefaultDeclaration')?.declaration;
  const resolveIdentifier = (node) => {
    if (node?.type !== 'Identifier') return node;
    for (const statement of ast.program.body) {
      if (statement.type !== 'VariableDeclaration') continue;
      const declarator = statement.declarations.find((candidate) => candidate.id.type === 'Identifier' && candidate.id.name === node.name);
      if (declarator) return declarator.init;
    }
    return node;
  };
  let candidate = resolveIdentifier(exported);
  while (candidate && (candidate.type === 'TSAsExpression' || candidate.type === 'TSSatisfiesExpression')) candidate = candidate.expression;
  if (candidate?.type === 'CallExpression') candidate = resolveIdentifier(candidate.arguments[0]);
  return candidate?.type === 'ObjectExpression' ? candidate : null;
}

/**
 * Read the facts the doctor needs from the site's astro.config.
 * @param {string} projectRoot
 * @returns {Promise<AstroConfigFacts>}
 */
export async function readAstroConfigFacts(projectRoot) {
  const facts = { file: null, parseError: null, integrationImported: false, integrationCalled: false, allowedHosts: 'unknown', hmr: 'unknown', outDir: null };
  let source = null;
  for (const name of ASTRO_CONFIG_NAMES) {
    try {
      source = await fs.readFile(path.join(projectRoot, name), 'utf-8');
      facts.file = name;
      break;
    } catch {
      // try the next name
    }
  }
  if (source === null) return facts;

  let ast;
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch (error) {
    facts.parseError = error.message;
    return facts;
  }

  const localNames = new Set();
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== INTEGRATION_MODULE) continue;
    for (const specifier of statement.specifiers) localNames.add(specifier.local.name);
  }
  facts.integrationImported = localNames.size > 0;
  for (const node of walkNodes(ast.program)) {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && localNames.has(node.callee.name)) {
      facts.integrationCalled = true;
      break;
    }
  }

  const configObject = findConfigObject(ast);
  if (configObject) {
    const server = getProperty(getProperty(configObject, 'vite'), 'server');
    const allowedHosts = getProperty(server, 'allowedHosts');
    if (allowedHosts === undefined) {
      facts.allowedHosts = server === undefined || server.type === 'ObjectExpression' ? 'missing' : 'unknown';
    } else if ((allowedHosts.type === 'ArrayExpression' && allowedHosts.elements.length > 0)
      || (allowedHosts.type === 'BooleanLiteral' && allowedHosts.value === true)) {
      facts.allowedHosts = 'set';
    } else if (allowedHosts.type === 'ArrayExpression' || allowedHosts.type === 'BooleanLiteral') {
      facts.allowedHosts = 'missing';
    }
    const hmr = getProperty(server, 'hmr');
    if (hmr === undefined) {
      facts.hmr = server === undefined || server.type === 'ObjectExpression' ? 'enabled' : 'unknown';
    } else if (hmr.type === 'BooleanLiteral') {
      facts.hmr = hmr.value ? 'enabled' : 'disabled';
    } else if (hmr.type === 'ObjectExpression') {
      facts.hmr = 'enabled';
    }
    const outDir = getProperty(configObject, 'outDir');
    if (outDir?.type === 'StringLiteral') facts.outDir = outDir.value;
  }
  return facts;
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Is the directory inside a git work tree? */
export async function isGitRepository(projectRoot) {
  try {
    return (await git(projectRoot, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

/**
 * The committed Bun lockfile (in the site's directory or at the repo root, for
 * a site in a subdirectory), relative to the repo root, or null.
 * @param {string} projectRoot
 */
export async function findCommittedLockfile(projectRoot) {
  const topLevel = await git(projectRoot, ['rev-parse', '--show-toplevel']);
  const candidates = [];
  for (const name of LOCKFILE_NAMES) {
    candidates.push(path.relative(topLevel, path.join(await fs.realpath(projectRoot), name)) || name);
    candidates.push(name);
  }
  const tracked = await git(topLevel, ['ls-files', '--', ...new Set(candidates)]);
  return tracked.split('\n').find(Boolean) || null;
}

/** Source files under src/, skipping node_modules and dot-directories. */
async function* sourceFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(fullPath);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) yield fullPath;
  }
}

/**
 * Does the site use Astro's image pipeline (astro:assets, or image() in a
 * content schema), which loads sharp at build time?
 * @param {string} projectRoot
 * @returns {Promise<string|null>} the first file that does, relative to the site
 */
export async function findAstroAssetsUse(projectRoot) {
  for await (const file of sourceFiles(path.join(projectRoot, 'src'))) {
    const text = await fs.readFile(file, 'utf-8');
    if (text.includes('astro:assets') || (/content\.config\.[cm]?[jt]s$/.test(file) && /\bimage\s*\(\s*\)/.test(text))) {
      return path.relative(projectRoot, file);
    }
  }
  return null;
}

// Loads sharp the way Astro does (resolved from the site) and makes a 1x1 PNG,
// which needs the native module, not just the JavaScript wrapper.
const SHARP_PROBE = `
const fail = (error) => { console.error('sharp-error: ' + (error && error.message || error)); process.exit(1); };
try {
  const { createRequire } = require('module');
  const siteRequire = createRequire(process.cwd() + '/package.json');
  const sharp = siteRequire('sharp');
  sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } }).png().toBuffer()
    .then(() => { console.log('sharp-ok'); process.exit(0); }, fail);
} catch (error) {
  fail(error);
}
`;

/** The runtime the publish check builds with (`bunx --bun`). */
function bunExecutable() {
  return process.versions.bun ? process.execPath : 'bun';
}

/**
 * Try to load sharp from the site, in a child process (a native module that
 * fails to load can take its process down with it).
 * @param {string} projectRoot
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
export function probeSharp(projectRoot) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // --no-install: Bun would otherwise auto-install a missing sharp from the
    // registry when the site has no node_modules, and report it as loading.
    const child = spawn(bunExecutable(), ['--no-install', '-e', SHARP_PROBE], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `loading sharp did not finish within ${SHARP_TIMEOUT_MS / 1000} seconds` });
    }, SHARP_TIMEOUT_MS);
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('close', (exitCode) => {
      if (exitCode === 0 && output.includes('sharp-ok')) finish({ ok: true, error: null });
      else finish({ ok: false, error: lastMeaningfulLine(output) || `exit code ${exitCode}` });
    });
  });
}

function lastMeaningfulLine(text) {
  const marked = text.split('\n').find((line) => line.startsWith('sharp-error: '));
  if (marked) return marked.slice('sharp-error: '.length).slice(0, 400);
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('at '));
  const errorLine = lines.find((line) => /error|cannot|not found/i.test(line));
  return (errorLine || lines.at(-1) || '').slice(0, 400);
}
