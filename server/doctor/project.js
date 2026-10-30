/**
 * Static facts about a site, read without running its code: its astro.config
 * (parsed, not imported), what git tracks, whether it uses astro:assets, and
 * whether sharp loads in the runtime the publish check builds with.
 */

import { parse } from '@babel/parser';
import { spawn } from 'child_process';
// Synchronous fs on purpose: under Bun 1.3.4 on macOS an fs/promises call made
// while child processes come and go can lose its completion and never settle,
// hanging the process at 0% CPU. These paths run git and builds, so they use
// the sync calls (small files, bounded walks).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { bunExecutable } from '../utils/astro-bin.js';
import { runGit } from '../utils/git-exec.js';

const ASTRO_CONFIG_NAMES = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.mts', 'astro.config.cjs'];
const INTEGRATION_MODULE = 'astroadmin/integration';
// Any package manager's: Bun reads its own, and `bun install` migrates the
// others (verified for package-lock.json with --frozen-lockfile, Bun 1.3.4).
export const LOCKFILE_NAMES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
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
 * @property {'set'|'missing'|'unknown'} cssTarget - vite.build.cssTarget
 * @property {{state: 'unset'|'literal'|'unknown'|'unreadable', value: string|null}} publicDir
 *   - 'unset' is Astro's default (./public); 'literal' carries the path it is
 *   set to (a string as written, or a URL relative to the config file as a
 *   path relative to the root); 'unknown' is a publicDir whose value the
 *   doctor cannot read statically (a call, an env variable); 'unreadable' is
 *   a config in which the doctor cannot find publicDir at all (a syntax
 *   error, a function passed to defineConfig, a spread that may set it)
 * @property {{state: 'unset'|'literal'|'unknown'|'unreadable', value: string|null}} imageService
 *   - image.service.entrypoint, with the same states as publicDir: 'unset'
 *   is Astro's default service; 'literal' carries the entrypoint as written;
 *   'unknown' is a service the doctor cannot read statically (a call such as
 *   sharpImageService(), a variable); 'unreadable' is a config in which the
 *   doctor cannot find it at all
 */

/** The entrypoint of AstroAdmin's image service, which applies a stored crop. */
export const CROP_SERVICE_ENTRYPOINT = 'astroadmin/image-service';
/** Where the editor keeps alt text, focal points and crops, relative to the site. */
export const IMAGE_METADATA_FILE = 'public/images/.metadata.json';

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

// Modules whose defineConfig returns its argument unchanged.
const DEFINE_CONFIG_MODULES = new Set(['astro/config', 'astro']);

/**
 * The local names `defineConfig` is imported under from astro/config (or astro).
 * A function of that name from anywhere else (a local helper, another module)
 * may change the config, so it is not in this set.
 */
function defineConfigNames(ast) {
  const names = new Set();
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || !DEFINE_CONFIG_MODULES.has(statement.source.value)) continue;
    if (statement.importKind === 'type') continue;
    for (const specifier of statement.specifiers) {
      const imported = specifier.type === 'ImportSpecifier' ? (specifier.imported.name ?? specifier.imported.value) : null;
      if (imported === 'defineConfig' && specifier.importKind !== 'type') names.add(specifier.local.name);
    }
  }
  return names;
}

/**
 * The object the config exports: `export default defineConfig({...})`,
 * `export default {...}`, or either through a const. Only astro's own
 * defineConfig (imported from astro/config), which returns its argument, is
 * unwrapped: any other call (`Object.assign(a, b)`, a helper) may return
 * something else, so it is not read. Null when the export is not statically
 * an object literal.
 */
function findConfigObject(ast, resolve) {
  const exported = ast.program.body.find((node) => node.type === 'ExportDefaultDeclaration')?.declaration;
  let candidate = resolve(exported);
  if (candidate?.type === 'CallExpression') {
    const callee = candidate.callee;
    const isAstroDefineConfig = callee.type === 'Identifier' && defineConfigNames(ast).has(callee.name);
    candidate = isAstroDefineConfig && candidate.arguments.length === 1 ? resolve(candidate.arguments[0]) : null;
  }
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
  const facts = { file: null, parseError: null, integrationImported: false, integrationCalled: 'no', allowedHosts: 'unknown', hmr: 'unknown', outDir: null, cssTarget: 'unknown', publicDir: { state: 'unknown', value: null }, imageService: { state: 'unknown', value: null } };
  let source = null;
  for (const name of ASTRO_CONFIG_NAMES) {
    try {
      source = fs.readFileSync(path.join(projectRoot, name), 'utf-8');
      facts.file = name;
      break;
    } catch {
      // try the next name
    }
  }
  if (source === null) return { ...facts, publicDir: { state: 'unset', value: null }, imageService: { state: 'unset', value: null } };

  let ast;
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch (error) {
    facts.parseError = error.message;
    return { ...facts, publicDir: { state: 'unreadable', value: null }, imageService: { state: 'unreadable', value: null } };
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
    // vite.build.cssTarget: 'set', 'missing' (no key on readable objects), or
    // 'unknown' (a spread or computed value the doctor cannot read).
    const viteBuild = getProperty(getProperty(configObject, 'vite', resolve), 'build', resolve);
    const cssTarget = getProperty(viteBuild, 'cssTarget', resolve);
    if (cssTarget === undefined) facts.cssTarget = viteBuild === UNKNOWN ? 'unknown' : 'missing';
    else if (cssTarget !== UNKNOWN) facts.cssTarget = 'set';
    const outDir = getProperty(configObject, 'outDir', resolve);
    const outDirValue = outDir === undefined || outDir === UNKNOWN ? null : resolve(outDir);
    if (outDirValue?.type === 'StringLiteral') facts.outDir = outDirValue.value;
    const publicDir = getProperty(configObject, 'publicDir', resolve);
    if (publicDir === undefined) facts.publicDir = { state: 'unset', value: null };
    else if (publicDir === UNKNOWN) facts.publicDir = { state: 'unreadable', value: null };
    else {
      const value = readPath(publicDir, resolve, urlHelperNames(ast), path.join(projectRoot, facts.file), projectRoot);
      if (value !== null) facts.publicDir = { state: 'literal', value };
    }
    // image.service.entrypoint: the same states as publicDir. A service that
    // is a call (Astro's sharpImageService()) or a variable has an entrypoint
    // the doctor cannot read, so it is 'unknown' rather than 'unreadable'.
    const service = getProperty(getProperty(configObject, 'image', resolve), 'service', resolve);
    const entrypoint = getProperty(service, 'entrypoint', resolve);
    if (entrypoint === undefined) facts.imageService = { state: 'unset', value: null };
    else if (entrypoint === UNKNOWN) {
      const serviceIsObject = service === UNKNOWN || resolve(service)?.type === 'ObjectExpression';
      facts.imageService = { state: serviceIsObject ? 'unreadable' : 'unknown', value: null };
    } else {
      const value = staticString(resolve(entrypoint));
      if (value !== null) facts.imageService = { state: 'literal', value };
    }
  } else {
    // The export is not an object literal the doctor can read (a function
    // passed to defineConfig, a helper's result).
    facts.publicDir = { state: 'unreadable', value: null };
    facts.imageService = { state: 'unreadable', value: null };
  }
  return facts;
}

/**
 * @typedef {Object} AdminConfigFacts
 * @property {boolean} present - the site has an astroadmin.config.js
 * @property {string|null} loadError - why it could not be loaded
 * @property {boolean} cropEnabled - `images.crop` is true in it
 */

/**
 * Read the facts the doctor needs from the site's astroadmin.config.js, by
 * loading it as the editor does (server/config.js imports the file; it is the
 * site's own code, trusted like its astro.config). Not through the editor's
 * getConfig(): that is bound to ASTROADMIN_PROJECT_ROOT when its module loads
 * and caches one site's config, while the doctor takes the site as an
 * argument (and its tests run several sites in one process).
 * @param {string} projectRoot
 * @returns {Promise<AdminConfigFacts>}
 */
export async function readAdminConfigFacts(projectRoot) {
  const file = path.join(projectRoot, 'astroadmin.config.js');
  if (!fs.existsSync(file)) return { present: false, loadError: null, cropEnabled: false };
  try {
    const imported = await import(pathToFileURL(file).href);
    const config = imported.default || imported;
    return { present: true, loadError: null, cropEnabled: config?.images?.crop === true };
  } catch (error) {
    return { present: true, loadError: error.message, cropEnabled: false };
  }
}

/**
 * The images whose editor metadata holds a crop, by the key the metadata
 * file stores them under (the image's site path, `/images/x.jpg`, or for an
 * entry written before 1.12.0 its bare file name). Content an editor set,
 * never a server path. A crop of null (cleared) is no crop.
 * @param {string} projectRoot
 * @returns {{present: boolean, parseError: string|null, keys: string[]}}
 */
export function findStoredCrops(projectRoot) {
  let text;
  try {
    text = fs.readFileSync(path.join(projectRoot, IMAGE_METADATA_FILE), 'utf-8');
  } catch {
    return { present: false, parseError: null, keys: [] };
  }
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch (error) {
    return { present: true, parseError: error.message, keys: [] };
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { present: true, parseError: 'not a JSON object', keys: [] };
  const keys = Object.keys(metadata).filter((key) => {
    const entry = metadata[key];
    return entry && typeof entry === 'object' && entry.crop && typeof entry.crop === 'object';
  });
  return { present: true, parseError: null, keys };
}

/** A string literal, or a template literal with no expressions: its text. */
function staticString(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/**
 * How the config can call url's `fileURLToPath`: the local names it is
 * imported under (`import { fileURLToPath as toPath } from 'node:url'`), and
 * the names url itself is imported under (`import * as url` or a default
 * import), for `url.fileURLToPath(...)`.
 * @returns {{functions: Set<string>, modules: Set<string>}}
 */
function urlHelperNames(ast) {
  const functions = new Set();
  const modules = new Set();
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || !['url', 'node:url'].includes(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') {
        modules.add(specifier.local.name);
        continue;
      }
      const imported = specifier.type === 'ImportSpecifier' ? (specifier.imported.name ?? specifier.imported.value) : null;
      if (imported === 'fileURLToPath') functions.add(specifier.local.name);
    }
  }
  return { functions, modules };
}

/** Is the call `fileURLToPath(x)` or `url.fileURLToPath(x)`, by the config's own imports? */
function isFileURLToPathCall(node, urlHelpers) {
  if (node?.type !== 'CallExpression' || node.arguments.length !== 1) return false;
  const callee = node.callee;
  if (callee.type === 'Identifier') return urlHelpers.functions.has(callee.name);
  return callee.type === 'MemberExpression' && !callee.computed
    && callee.object.type === 'Identifier' && urlHelpers.modules.has(callee.object.name)
    && callee.property.type === 'Identifier' && callee.property.name === 'fileURLToPath';
}

/** Is the node `import.meta.url`? */
function isImportMetaUrl(node) {
  return node?.type === 'MemberExpression' && !node.computed
    && node.object.type === 'MetaProperty' && node.object.meta.name === 'import' && node.object.property.name === 'meta'
    && node.property.type === 'Identifier' && node.property.name === 'url';
}

/**
 * A path-valued config option as a path relative to the project root, or null
 * when it cannot be read statically. Reads a string (or expression-free
 * template literal), and `new URL('<string>', import.meta.url)`, bare or
 * inside `fileURLToPath(...)` or `url.fileURLToPath(...)`, resolved against the config file as Node
 * would. A plain string is returned as written (Astro resolves it against
 * the root).
 */
function readPath(node, resolve, urlHelpers, configFile, projectRoot) {
  let value = resolve(node);
  const text = staticString(value);
  if (text !== null) return text;
  if (isFileURLToPathCall(value, urlHelpers)) value = resolve(value.arguments[0]);
  if (value?.type !== 'NewExpression' || value.callee.type !== 'Identifier' || value.callee.name !== 'URL' || value.arguments.length !== 2) return null;
  const relative = staticString(resolve(value.arguments[0]));
  if (relative === null || !isImportMetaUrl(value.arguments[1])) return null;
  try {
    const url = new URL(relative, pathToFileURL(configFile));
    if (url.protocol !== 'file:') return null;
    return path.relative(projectRoot, fileURLToPath(url)) || '.';
  } catch {
    return null;
  }
}

async function git(cwd, args) {
  const stdout = await runGit(cwd, args);
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
 * The committed lockfile, the first of LOCKFILE_NAMES found (in the site's directory or at the repo root, for
 * a site in a subdirectory), relative to the repo root, or null. Read from
 * HEAD, not the index: a lockfile that is only staged is not in what a hosted
 * editor clones. A repository with no commits has none.
 * @param {string} projectRoot
 */
export async function findCommittedLockfile(projectRoot) {
  const topLevel = fs.realpathSync(await git(projectRoot, ['rev-parse', '--show-toplevel']));
  const candidates = [];
  for (const name of LOCKFILE_NAMES) {
    candidates.push(path.relative(topLevel, path.join(fs.realpathSync(projectRoot), name)) || name);
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

/** Source files under src/, skipping node_modules and dot-directories. */
async function* sourceFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
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
    const text = fs.readFileSync(file, 'utf-8');
    if (text.includes('astro:assets') || (/content\.config\.[cm]?[jt]s$/.test(file) && /\bimage\s*\(\s*\)/.test(text))) {
      return path.relative(projectRoot, file);
    }
  }
  return null;
}

/**
 * Does the site's source use AstroAdmin's CmsImage component?
 * @param {string} projectRoot
 * @returns {Promise<string|null>} the first file that does, relative to the site
 */
export function findCmsImageUse(projectRoot) {
  return findImportUse(projectRoot, 'astroadmin/components/CmsImage.astro');
}

/**
 * Does the site's source use AstroAdmin's CmsVideo component?
 * @param {string} projectRoot
 * @returns {Promise<string|null>} the first file that does, relative to the site
 */
export function findCmsVideoUse(projectRoot) {
  return findImportUse(projectRoot, 'astroadmin/components/CmsVideo.astro');
}

async function findImportUse(projectRoot, specifier) {
  for await (const file of sourceFiles(path.join(projectRoot, 'src'))) {
    if (fs.readFileSync(file, 'utf-8').includes(specifier)) return path.relative(projectRoot, file);
  }
  return null;
}

/**
 * The version of a package as a bare import FROM THE SITE ROOT finds it: the
 * first node_modules/<name> in the site's directory or above. This is how
 * `astro build` finds sharp (its bundled image service leaves sharp external,
 * so it resolves from the site), so a newer copy nested inside Astro's own
 * folder is not it. Reads package.json directly, which a package's `exports`
 * may not expose to require.resolve.
 * @param {string} projectRoot
 * @param {string} name
 * @returns {{version: string, file: string}|null}
 */
export function sitePackageVersion(projectRoot, name) {
  let directory = path.resolve(projectRoot);
  for (;;) {
    const file = path.join(directory, 'node_modules', name, 'package.json');
    try {
      const { version } = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof version === 'string') return { version, file };
    } catch {
      // not here: look further up
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Compare two `major.minor.patch` versions (prerelease suffixes ignored).
 * @returns {number} negative, zero or positive
 */
export function compareVersions(left, right) {
  const parts = (version) => String(version).split(/[-+]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
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
