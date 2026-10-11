/**
 * What an editor is told when a build fails: built from structured parts only.
 *
 * A build's output names server paths (the check's worktree, the project, a
 * sibling directory, an external git directory, a mount point this machine
 * does not have), and on a shared server a sibling directory names another
 * site. Guessing which text in it is a path was tried for six review rounds
 * and could not be made complete in either direction: it leaked paths it did
 * not recognise and hid schema values that looked like paths ('/home/about').
 * So no text from the output reaches an HTTP response. What does:
 *
 * - the error CODES found in it (an identifier such as `ImageNotFound`, read
 *   from Astro's `[Code]` / `Code:` lines and checked to be a bare
 *   identifier), each mapped to a sentence we wrote (describeCode);
 * - the ENTRIES it refused, as collection and slug: Astro's own ids, files
 *   named in its `Location:` lines (only under the site's own directory, and
 *   only when the file is a collection's entry), and entries whose committed
 *   content holds an image path Astro could not find;
 * - for each entry, AstroAdmin's own reading of it at the checked commit
 *   (content-validation.js): field paths, messages, accepted values.
 *
 * The output itself goes to the server log (the caller logs it).
 *
 * Synchronous fs only, like the publish check that imports it (see CLAUDE.md:
 * Bun can lose an fs/promises completion while child processes come and go).
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** What the editor is told when the output carries no error code. */
export const NO_CODE_MESSAGE = "The site's build failed without naming an error; see the server log.";

/** The most entries a refusal lists (and validates). */
const MAX_ENTRIES = 20;

/**
 * Plain sentences for the codes an editor's content can cause. A code not
 * listed reads "Astro refused the build (<code>); see the server log."
 * `YAMLException` is js-yaml's error name (Astro prints the message without
 * a code); `MdxSyntaxError` is ours, for the MDX compiler's codeless errors.
 */
const CODE_SENTENCES = {
  InvalidContentEntryDataError: "An entry's data does not match its collection's schema.",
  ContentEntryDataError: "An entry's data does not match its collection's schema.",
  ContentLoaderInvalidDataError: "An entry's data does not match its collection's schema.",
  InvalidContentEntryFrontmatterError: "An entry's frontmatter could not be read.",
  MarkdownFrontmatterParseError: "An entry's frontmatter is not valid YAML.",
  YAMLException: "An entry's frontmatter is not valid YAML.",
  DataCollectionEntryParseError: "A data entry's file could not be read: its JSON (or YAML) is not valid.",
  ImageNotFound: 'An image an entry uses was not found in the site.',
  NoImageMetadata: 'An image an entry uses could not be read as an image.',
  UnsupportedImageFormat: 'An image an entry uses is in a format the site cannot use.',
  CouldNotTransformImage: 'An image an entry uses could not be processed.',
  ImageMissingAlt: 'An image on the site has no alt text.',
  MdxSyntaxError: 'An MDX entry has a syntax error (an unclosed tag or brace, say). The build does not say which entry.',
  MdxIntegrationMissingError: 'An entry is an MDX file, but the site is not set up to build MDX.',
  UnknownMarkdownError: "An entry's markdown could not be processed.",
  InvalidContentEntrySlugError: "An entry's slug is not valid.",
  DuplicateContentEntrySlugError: 'Two entries in one collection have the same slug.',
  ContentLoaderReturnsInvalidId: "An entry's id is not valid.",
  GetStaticPathsInvalidRouteParam: "A page's address, made from an entry's slug, is not valid.",
  PrerenderRouteConflict: 'Two pages would have the same address.',
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
// A code is a bare identifier: nothing that could carry a path or a value.
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{1,63}$/;

/** The output without terminal colour codes. */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/**
 * The error codes in a build's output, in order of appearance, de-duplicated.
 * Astro prints an AstroError as `[ErrorName] message` at the start of a line
 * (`[ERROR]`/`[vite]` logger tags are not codes: all capitals, or lower case),
 * and some errors as `ErrorName: message`. Two failures print no code at
 * all, and are recognised by what they do print: js-yaml's frontmatter
 * errors (its stack frames) and the MDX compiler's syntax errors (a rule id
 * such as `(mdx-jsx:unexpected-character)`).
 * @param {string} output
 * @returns {string[]}
 */
export function findErrorCodes(output) {
  const text = stripAnsi(output);
  const codes = [];
  const add = (code) => {
    // A bare `Error` names nothing: it counts as no code.
    if (code !== 'Error' && IDENTIFIER.test(code) && !codes.includes(code)) codes.push(code);
  };
  for (const match of text.matchAll(/^\[([A-Z][a-z][A-Za-z0-9]*|[A-Z][A-Za-z0-9]*Error)\]/gm)) add(match[1]);
  for (const match of text.matchAll(/^([A-Z][A-Za-z0-9]*(?:Error|Exception)):\s/gm)) add(match[1]);
  if (/^YAMLException\b/m.test(text) || /[/\\]js-yaml[/\\]/.test(text)) add('YAMLException');
  if (/\((?:mdx-[a-z-]+|micromark-extension-mdx[a-z-]*):[a-z-]+\)/.test(text)) add('MdxSyntaxError');
  return codes;
}

/**
 * The sentence for one code.
 * @param {string} code - an identifier from findErrorCodes
 */
export function describeCode(code) {
  if (Object.hasOwn(CODE_SENTENCES, code)) return CODE_SENTENCES[code];
  return `Astro refused the build (${code}); see the server log.`;
}

/**
 * The problems an editor is shown for a failed build's output: one per code,
 * or one fixed sentence when there is none. Never any text of the output.
 * @param {string} output
 * @returns {Array<{code: string|null, message: string}>}
 */
export function buildProblems(output) {
  const codes = findErrorCodes(output);
  if (codes.length === 0) return [{ code: null, message: NO_CODE_MESSAGE }];
  return codes.map((code) => ({ code, message: describeCode(code) }));
}

/**
 * What the output says about entries, as raw keys to resolve later: Astro
 * ids (`[InvalidContentEntryDataError] pages → home`), files named in
 * `Location:` lines, and image paths Astro could not find. None of these is
 * shown; each is only matched against the site's own entries.
 * @param {string} output
 * @param {string[]} siteDirs - the site's directory in the check (and its resolved path)
 * @returns {{ids: Array<{collection: string, id: string}>, files: string[], images: string[]}}
 */
export function parseFailureKeys(output, siteDirs = []) {
  const text = stripAnsi(output);
  const ids = [];
  for (const match of text.matchAll(/^\[(?:InvalidContentEntryDataError|ContentEntryDataError)\]\s+(\S+)\s+→\s+(\S+)/gm)) {
    if (!ids.some((known) => known.collection === match[1] && known.id === match[2])) {
      ids.push({ collection: match[1], id: match[2] });
    }
  }
  const files = [];
  const roots = [...new Set(siteDirs.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const match of text.matchAll(/^\s*Location:\s*\n\s*(?:file:\/\/)?(.+?):\d+:\d+\s*$/gm)) {
    const located = match[1];
    const root = roots.find((directory) => located.startsWith(`${directory}${path.sep}`));
    if (!root) continue;
    const relative = located.slice(root.length + 1).split(path.sep).join('/');
    if (!relative.split('/').includes('..') && !files.includes(relative)) files.push(relative);
  }
  const images = [];
  for (const match of text.matchAll(/^\[ImageNotFound\][^`\n]*`([^`\n]+)`/gm)) {
    if (!images.includes(match[1])) images.push(match[1]);
  }
  return { ids, files, images };
}

/** Lower-case, drop what github-slugger drops, spaces to hyphens: Astro's glob id for a path segment. */
function slugifySegment(segment) {
  return segment.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/**
 * Astro's default id for a glob entry's file (relative to its base): each
 * path segment slugified, the extension dropped. An entry with a `slug` in
 * its frontmatter has that id instead, which is matched separately.
 */
export function astroIdForFile(relativeFile) {
  const withoutExtension = relativeFile.slice(0, relativeFile.length - path.extname(relativeFile).length);
  return withoutExtension.split('/').map(slugifySegment).join('/').replace(/\/index$/, '');
}

/**
 * Resolve a failure's keys to entries, and read each one at the checked
 * commit with AstroAdmin's own validator. Never throws: an entry that cannot
 * be read is listed without issues (and the reason logged).
 * @param {Object} options
 * @param {string} options.output - the failed build's output
 * @param {string[]} options.siteDirs - the site's directory in the check
 * @param {string} options.projectRoot - the live site directory
 * @param {string} options.commit - the checked commit
 * @param {Object} options.fullConfig - getConfig() result (content store, i18n)
 * @returns {Promise<Array<RefusedEntry>>}
 *
 * @typedef {Object} RefusedEntry
 * @property {string} collection
 * @property {string} slug - the editor's slug (only entries found in the commit are listed)
 * @property {string|null} locale
 * @property {'invalid'|'valid'|'unchecked'} validation - AstroAdmin's reading at the commit
 * @property {Array<{path: string, message: string, accepted?: string[]}>} issues
 */
export async function describeRefusedEntries({ output, siteDirs, projectRoot, commit, fullConfig }) {
  const keys = parseFailureKeys(output, siteDirs);
  if (keys.ids.length === 0 && keys.files.length === 0 && keys.images.length === 0) return [];
  try {
    const site = await commitSite({ projectRoot, commit, fullConfig });
    const found = [];
    const addEntry = (entry) => {
      if (!entry || found.length >= MAX_ENTRIES) return null;
      const key = `${entry.collection}\u0000${entry.slug}\u0000${entry.locale || ''}`;
      const existing = found.find((candidate) => candidate.key === key);
      if (existing) return existing;
      const added = { ...entry, key, images: [] };
      found.push(added);
      return added;
    };
    // Only an id that is an entry of the commit is listed: an unresolved one
    // is Astro's text, which is never shown.
    for (const { collection, id } of keys.ids) addEntry(await site.entryForId(collection, id));
    for (const file of keys.files) addEntry(site.entryForFile(file));
    for (const image of keys.images) {
      for (const file of await site.filesContaining(image)) {
        addEntry(site.entryForFile(file))?.images.push(image);
      }
    }
    const entries = [];
    for (const { key, file, images, itemId, ...entry } of found) {
      const reading = await site.validate({ ...entry, itemId }, file, images);
      entries.push({ ...entry, validation: reading.status, issues: reading.issues });
    }
    return entries;
  } catch (error) {
    console.error('Could not read the refused entries at the checked commit:', error);
    return [];
  }
}

async function gitOutput(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

/**
 * The site's collections as files in a commit: which file is which entry, and
 * each entry's stored data at that commit.
 */
async function commitSite({ projectRoot, commit, fullConfig }) {
  const { loadSchemas } = await import('./collections.js');
  const { getGlobBaseDirectory, getGlobPatterns, matchesAnyPattern, resolveProjectPath, splitLocale } = await import('./glob-files.js');
  const schemas = await loadSchemas();
  const i18n = fullConfig.i18n || { enabled: false, locales: [] };
  const repoTop = fs.realpathSync((await gitOutput(projectRoot, ['rev-parse', '--show-toplevel'])).trim());
  const siteInRepo = path.relative(repoTop, fs.realpathSync(projectRoot)).split(path.sep).join('/');
  const inRepo = (siteRelative) => (siteInRepo ? `${siteInRepo}/${siteRelative}` : siteRelative);
  const siteRelativeOf = (absolute) => path.relative(projectRoot, absolute).split(path.sep).join('/');

  // Each collection's files, relative to the site: a glob() base with its
  // patterns, or a file() collection's one file.
  const layouts = Object.entries(schemas).map(([collection, schema]) => (
    schema.loaderType === 'file' && schema.loaderFilePath
      ? { collection, file: siteRelativeOf(resolveProjectPath(schema.loaderFilePath)) }
      : { collection, base: siteRelativeOf(getGlobBaseDirectory(collection, schema)), patterns: getGlobPatterns(schema) }
  )).filter((layout) => !(layout.base ?? layout.file).startsWith('..'));

  const entryForFile = (file) => {
    for (const layout of layouts) {
      if (layout.file !== undefined) {
        if (layout.file === file) return null; // a file() collection's file: no one entry
        continue;
      }
      const prefix = layout.base ? `${layout.base}/` : '';
      if (!file.startsWith(prefix)) continue;
      const inner = file.slice(prefix.length);
      if (!matchesAnyPattern(inner, layout.patterns)) continue;
      const { slug, locale } = splitLocale(inner.slice(0, inner.length - path.extname(inner).length), i18n);
      return { collection: layout.collection, slug, locale, file };
    }
    return null;
  };

  const filesCache = new Map();
  const filesOf = async (layout) => {
    if (!filesCache.has(layout.collection)) {
      const listed = await gitOutput(projectRoot, ['ls-tree', '-r', '--name-only', '--full-tree', commit, '--', inRepo(layout.base || '.')]);
      const prefix = siteInRepo ? `${siteInRepo}/` : '';
      filesCache.set(layout.collection, listed.split('\n').filter(Boolean).map((name) => name.slice(prefix.length)));
    }
    return filesCache.get(layout.collection);
  };

  const readAtCommit = (file) => gitOutput(projectRoot, ['show', `${commit}:${inRepo(file)}`]);

  return {
    entryForFile,

    /** The entry Astro calls `id` in `collection`, or null. */
    async entryForId(collection, id) {
      const layout = layouts.find((candidate) => candidate.collection === collection);
      if (!layout) return null;
      if (layout.file !== undefined) {
        let items;
        try {
          const parsed = JSON.parse(await readAtCommit(layout.file));
          items = Array.isArray(parsed) ? parsed.map((item) => item?.id ?? item?.slug) : Object.keys(parsed || {});
        } catch {
          return null;
        }
        return items.includes(id) ? { collection, slug: id, locale: null, file: layout.file, itemId: id } : null;
      }
      for (const file of await filesOf(layout)) {
        const entry = entryForFile(file);
        if (!entry) continue;
        const inner = file.slice(layout.base ? layout.base.length + 1 : 0);
        if (astroIdForFile(inner) === id || inner.slice(0, inner.length - path.extname(inner).length) === id) return entry;
      }
      return null;
    },

    /** Site-relative files in the commit's collections whose text contains `value`. */
    async filesContaining(value) {
      const bases = layouts.map((layout) => inRepo(layout.base ?? layout.file));
      if (bases.length === 0) return [];
      let listed = '';
      try {
        listed = await gitOutput(projectRoot, ['grep', '-l', '-F', '--full-name', '-e', value, commit, '--', ...bases]);
      } catch (error) {
        if (error.code === 1) return []; // no match
        throw error;
      }
      const prefix = `${commit}:${siteInRepo ? `${siteInRepo}/` : ''}`;
      return listed.split('\n').filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
    },

    /** AstroAdmin's validation of one entry as stored at the commit. */
    async validate(entry, file, images) {
      const { validateCommittedText } = await import('./content-validation.js');
      let text;
      try {
        text = await readAtCommit(file);
      } catch (error) {
        console.error(`Could not read ${file} at ${commit.slice(0, 7)}:`, error.message);
        return { status: 'unchecked', issues: [] };
      }
      return validateCommittedText({ schemas, collection: entry.collection, file, text, itemId: entry.itemId ?? null, missingImages: images });
    },
  };
}
