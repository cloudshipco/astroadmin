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
 * @property {'yes'|'no'|'unknown'} integrationCalled - whether what it imported
 *   is called in the EXPORTED config's integrations ('unknown' when that list
 *   cannot be read statically)
 * @property {'set'|'missing'|'unknown'} allowedHosts - vite.server.allowedHosts
 * @property {'disabled'|'enabled'|'unknown'} hmr - vite.server.hmr
 * @property {string|null} outDir
 */

// A value that is there but cannot be read statically (a later spread, a
// computed key, a call, a variable that is not a plain const).
const UNKNOWN = Symbol('unknown');

/**
 * Resolves expressions in a parsed config: a top-level `const` identifier to
 * its initialiser, through TypeScript `as`/`satisfies` and parentheses.
 * Anything else (let/var, imports, parameters) stays as it is, which the
 * readers below treat as unknown.
 */
function makeResolver(ast) {
  const constants = new Map();
  for (const statement of ast.program.body) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.init) constants.set(declarator.id.name, declarator.init);
    }
  }
  return function resolve(node, seen = new Set()) {
    let current = node;
    while (current && (current.type === 'TSAsExpression' || current.type === 'TSSatisfiesExpression' || current.type === 'ParenthesizedExpression' || current.type === 'TSNonNullExpression')) {
      current = current.expression;
    }
    if (current?.type === 'Identifier' && constants.has(current.name) && !seen.has(current.name)) {
      seen.add(current.name);
      return resolve(constants.get(current.name), seen);
    }
    return current;
  };
}

function propertyName(property) {
  if (property.computed) return property.key.type === 'StringLiteral' ? property.key.value : UNKNOWN;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'StringLiteral') return property.key.value;
  if (property.key.type === 'NumericLiteral') return String(property.key.value);
  return UNKNOWN;
}

/**
 * The value node of `object.name` as JavaScript would evaluate it: properties
 * apply in order and the last one wins, so a spread or a computed key AFTER the
 * last plain `name` (or with no plain `name` at all) may override it, and the
 * value is UNKNOWN. Undefined when the property is certainly absent.
 * @param {Object|undefined|symbol} objectNode
 * @param {string} name
 * @param {(node: Object) => Object} resolve
 */
function getProperty(objectNode, name, resolve) {
  if (objectNode === undefined) return undefined;
  if (objectNode === UNKNOWN) return UNKNOWN;
  const object = resolve(objectNode);
  if (object?.type !== 'ObjectExpression') return UNKNOWN;
  let found;
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      found = UNKNOWN;
      continue;
    }
    const key = propertyName(property);
    if (key === UNKNOWN) found = UNKNOWN;
    else if (key === name) found = property.type === 'ObjectProperty' ? property.value : UNKNOWN;
  }
  return found;
}

/**
 * The object the config exports: `export default defineConfig({...})`,
 * `export default {...}`, or either through a const. Null when it is not
 * statically an object literal.
 */
function findConfigObject(ast, resolve) {
  const exported = ast.program.body.find((node) => node.type === 'ExportDefaultDeclaration')?.declaration;
  let candidate = resolve(exported);
  if (candidate?.type === 'CallExpression') candidate = resolve(candidate.arguments[0]);
  return candidate?.type === 'ObjectExpression' ? candidate : null;
}

/**
 * Is a call of one of `localNames` among the integrations a list holds?
 * Follows const identifiers and spreads of known arrays (Astro also flattens
 * nested arrays, so an element that is itself such an array counts).
 * @returns {'yes'|'no'|'unknown'}
 */
function listCalls(listNode, localNames, resolve, depth = 0) {
  const list = resolve(listNode);
  if (depth > 20 || list?.type !== 'ArrayExpression') return 'unknown';
  let outcome = 'no';
  for (const element of list.elements) {
    if (!element) continue;
    let found;
    if (element.type === 'SpreadElement') {
      found = listCalls(element.argument, localNames, resolve, depth + 1);
    } else {
      const value = resolve(element);
      if (value?.type === 'CallExpression') {
        found = value.callee.type === 'Identifier' && localNames.has(value.callee.name) ? 'yes' : 'no';
      } else if (value?.type === 'ArrayExpression') {
        found = listCalls(value, localNames, resolve, depth + 1);
      } else if (value?.type === 'ObjectExpression') {
        found = 'no';
      } else {
        found = 'unknown';
      }
    }
    if (found === 'yes') return 'yes';
    if (found === 'unknown') outcome = 'unknown';
  }
  return outcome;
}

/**
 * Read the facts the doctor needs from the site's astro.config.
 * @param {string} projectRoot
 * @returns {Promise<AstroConfigFacts>}
 */
export async function readAstroConfigFacts(projectRoot) {
  const facts = { file: null, parseError: null, integrationImported: false, integrationCalled: 'no', allowedHosts: 'unknown', hmr: 'unknown', outDir: null };
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

  // Only the exported config counts: a call anywhere else in the file (an
  // unused `const admin = astroadmin()`) does not install the integration.
  const resolve = makeResolver(ast);
  const configObject = findConfigObject(ast, resolve);
  const integrations = configObject ? getProperty(configObject, 'integrations', resolve) : UNKNOWN;
  if (integrations === undefined) facts.integrationCalled = 'no';
  else if (integrations === UNKNOWN) facts.integrationCalled = 'unknown';
  else facts.integrationCalled = listCalls(integrations, localNames, resolve);

  if (configObject) {
    const server = getProperty(getProperty(configObject, 'vite', resolve), 'server', resolve);
    const allowedHosts = getProperty(server, 'allowedHosts', resolve);
    const allowedHostsValue = allowedHosts === undefined || allowedHosts === UNKNOWN ? allowedHosts : resolve(allowedHosts);
    if (allowedHostsValue === undefined) {
      facts.allowedHosts = server === UNKNOWN ? 'unknown' : 'missing';
    } else if ((allowedHostsValue?.type === 'ArrayExpression' && allowedHostsValue.elements.length > 0)
      || (allowedHostsValue?.type === 'BooleanLiteral' && allowedHostsValue.value === true)) {
      facts.allowedHosts = 'set';
    } else if (allowedHostsValue?.type === 'ArrayExpression' || allowedHostsValue?.type === 'BooleanLiteral') {
      facts.allowedHosts = 'missing';
    }
    const hmr = getProperty(server, 'hmr', resolve);
    const hmrValue = hmr === undefined || hmr === UNKNOWN ? hmr : resolve(hmr);
    if (hmrValue === undefined) {
      facts.hmr = server === UNKNOWN ? 'unknown' : 'enabled';
    } else if (hmrValue?.type === 'BooleanLiteral') {
      facts.hmr = hmrValue.value ? 'enabled' : 'disabled';
    } else if (hmrValue?.type === 'ObjectExpression') {
      facts.hmr = 'enabled';
    }
    const outDir = getProperty(configObject, 'outDir', resolve);
    const outDirValue = outDir === undefined || outDir === UNKNOWN ? null : resolve(outDir);
    if (outDirValue?.type === 'StringLiteral') facts.outDir = outDirValue.value;
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
 * a site in a subdirectory), relative to the repo root, or null. Read from
 * HEAD, not the index: a lockfile that is only staged is not in what a hosted
 * editor clones. A repository with no commits has none.
 * @param {string} projectRoot
 */
export async function findCommittedLockfile(projectRoot) {
  const topLevel = await fs.realpath(await git(projectRoot, ['rev-parse', '--show-toplevel']));
  const candidates = [];
  for (const name of LOCKFILE_NAMES) {
    candidates.push(path.relative(topLevel, path.join(await fs.realpath(projectRoot), name)) || name);
    candidates.push(name);
  }
  let committed;
  try {
    committed = await git(topLevel, ['ls-tree', '--name-only', 'HEAD', '--', ...new Set(candidates)]);
  } catch {
    return null;
  }
  return committed.split('\n').find(Boolean) || null;
}

/**
 * The astro executable the site has installed: the `bin` of node_modules/astro
 * in the site's directory, or in any directory above it up to the repository
 * root (a monorepo with hoisted node_modules). Null when there is none: the
 * doctor never lets a package runner fetch one.
 * @param {string} projectRoot
 * @returns {Promise<string|null>} an absolute, real path
 */
export async function findAstroExecutable(projectRoot) {
  let directory = await fs.realpath(projectRoot);
  let top = directory;
  try {
    top = await fs.realpath(await git(projectRoot, ['rev-parse', '--show-toplevel']));
  } catch {
    // not a repository: only the site's own node_modules
  }
  for (;;) {
    const packageDir = path.join(directory, 'node_modules', 'astro');
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf-8'));
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.astro;
      if (bin) return await fs.realpath(path.join(packageDir, bin));
    } catch {
      // not installed at this level
    }
    const parent = path.dirname(directory);
    if (directory === top || parent === directory || !directory.startsWith(`${top}${path.sep}`)) return null;
    directory = parent;
  }
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

/** The Bun running the admin (the runtime the publish check builds with). */
export function bunExecutable() {
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
