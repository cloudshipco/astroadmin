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
 * - the ENTRIES it refused, as collection and slug, each only when it is
 *   CONFIRMED in the checked commit (describeRefusedEntries): a `Location:`
 *   file that is a committed entry, an id exactly one committed entry has,
 *   or an entry whose own image reference resolves to a path the commit
 *   lacks. Otherwise no entry is named, and the code's sentence stands alone;
 * - for each entry, AstroAdmin's own reading of it at the checked commit,
 *   against the commit's own schemas (content-validation.js): field paths,
 *   messages, accepted values.
 *
 * The output itself goes to the server log (the caller logs it).
 *
 * Synchronous fs only, like the publish check that imports it (see CLAUDE.md:
 * Bun can lose an fs/promises completion while child processes come and go).
 * One exception it cannot avoid: the commit's schemas are parsed by
 * schema-parser.js, which uses fs/promises; that load is capped
 * (SCHEMA_LOAD_TIMEOUT_MS), and on a timeout nothing is validated.
 */

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  fileLoaderItems, findImageFields, formatIssuePath, parseCommittedText, validateCommittedText,
} from './content-validation.js';
import { runGit, runGitSync } from './git-exec.js';

const SERVER_LOG_HINT = 'see the server log';

/** The sentence for output that carries no error code, pointing at `outputHint`. */
const noCodeMessage = (outputHint) => `The site's build failed without naming an error; ${outputHint}.`;

/** What the editor is told when the output carries no error code. */
export const NO_CODE_MESSAGE = noCodeMessage(SERVER_LOG_HINT);

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
 * @param {string} [outputHint] - where the reader finds the output
 */
export function describeCode(code, outputHint = SERVER_LOG_HINT) {
  if (Object.hasOwn(CODE_SENTENCES, code)) return CODE_SENTENCES[code];
  return `Astro refused the build (${code}); ${outputHint}.`;
}

/**
 * The problems an editor is shown for a failed build's output: one per code,
 * or one fixed sentence when there is none. Never any text of the output.
 * `outputHint` says where the output is: the server log for the editor, the
 * terminal for the doctor (which prints the output to its own stderr).
 * @param {string} output
 * @param {string} [outputHint]
 * @returns {Array<{code: string|null, message: string}>}
 */
export function buildProblems(output, outputHint = SERVER_LOG_HINT) {
  const codes = findErrorCodes(output);
  if (codes.length === 0) return [{ code: null, message: noCodeMessage(outputHint) }];
  return codes.map((code) => ({ code, message: describeCode(code, outputHint) }));
}

/**
 * What the output says about entries, as raw keys to resolve later. None of
 * these is shown; each is only matched against the commit's own entries.
 *
 * - ids: Astro's `[InvalidContentEntryDataError] <collection> → <id> data does
 *   not match collection schema.` The id runs to that suffix, so it may hold
 *   spaces (a file() item named `Jane Doe`). When the same error names a file
 *   in its `Location:` (Astro does, for a glob entry and a file() collection's
 *   file), that file is kept with the id: it is Astro's own word for which file.
 * - files: the other `Location:` files, under the site's directory only.
 * - images: the paths in `[ImageNotFound]` messages, exactly as the entry wrote them.
 *
 * @param {string} output
 * @param {string[]} siteDirs - the site's directory in the check (and its resolved path)
 * @returns {{ids: Array<{collection: string, id: string, file: string|null}>, files: string[], images: string[]}}
 */
export function parseFailureKeys(output, siteDirs = []) {
  const lines = stripAnsi(output).split('\n');
  const roots = [...new Set(siteDirs.filter(Boolean))].sort((a, b) => b.length - a.length);
  const siteRelative = (located) => {
    const root = roots.find((directory) => located.startsWith(`${directory}${path.sep}`));
    if (!root) return null;
    const relative = located.slice(root.length + 1).split(path.sep).join('/');
    return relative.split('/').includes('..') ? null : relative;
  };

  const ids = [];
  const files = [];
  const images = [];
  let current = null; // the id error whose block we are in
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // An error's own lines are indented; an unindented line starts another.
    if (/^\S/.test(line)) current = null;
    const id = /^\[(?:InvalidContentEntryDataError|ContentEntryDataError)\]\s+(.+?) → (.+?) data does not match collection schema\.?\s*$/.exec(line);
    if (id) {
      current = ids.find((known) => known.collection === id[1] && known.id === id[2]);
      if (!current) {
        current = { collection: id[1], id: id[2], file: null };
        ids.push(current);
      }
      continue;
    }
    const image = /^\[ImageNotFound\][^`\n]*`([^`\n]+)`/.exec(line);
    if (image && !images.includes(image[1])) images.push(image[1]);
    if (/^\s*Location:\s*$/.test(line)) {
      const where = /^\s*(?:file:\/\/)?(.+?):\d+:\d+\s*$/.exec(lines[index + 1] ?? '');
      const relative = where ? siteRelative(where[1]) : null;
      if (!relative) continue;
      if (current && current.file === null) current.file = relative;
      else if (!files.includes(relative)) files.push(relative);
    }
  }
  // A file paired with an id is not listed again on its own.
  const paired = new Set(ids.map((entry) => entry.file).filter(Boolean));
  return { ids, files: files.filter((file) => !paired.has(file)), images };
}

/** Lower-case, drop what github-slugger drops, spaces to hyphens: Astro's glob id for a path segment. */
function slugifySegment(segment) {
  return segment.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/**
 * Astro's default id for a glob entry's file (relative to its base): each
 * path segment slugified, the extension dropped. An entry whose data has a
 * `slug` has that id instead (globEntryId).
 */
export function astroIdForFile(relativeFile) {
  const withoutExtension = relativeFile.slice(0, relativeFile.length - path.extname(relativeFile).length);
  return withoutExtension.split('/').map(slugifySegment).join('/').replace(/\/index$/, '');
}

/**
 * The id Astro's glob loader gives an entry (generateIdDefault in
 * astro/dist/content/loaders/glob.js): its data's `slug` when that is truthy,
 * else the id from its path. null when the data cannot be read, since then
 * Astro assigns it no id either. A loader's own `generateId` is not known
 * here; a Location line still identifies such an entry.
 * @param {string} inner - the file relative to the collection's base
 * @param {string} text - its committed text
 */
export function globEntryId(inner, text) {
  const parsed = parseCommittedText(inner, text);
  if (parsed.issue) return null;
  const slug = parsed.data && typeof parsed.data === 'object' ? parsed.data.slug : undefined;
  return slug ? String(slug) : astroIdForFile(inner);
}

/** The file's extensions the id lookup can read (markdown frontmatter, JSON). */
const READABLE_ENTRY = /\.(?:md|mdx|markdown|json)$/i;

/** Body images can only be read in markdown: MDX is compiled by its own pipeline. */
const MARKDOWN_BODY = /\.(?:md|markdown)$/i;

/** How long the commit's content config may take to load before it is given up. */
const SCHEMA_LOAD_TIMEOUT_MS = 20000;

/**
 * Resolve a failure's keys to entries of the checked commit, and read each one
 * there with AstroAdmin's own validator. An entry is listed only when it is
 * CONFIRMED: a Location naming a regular file committed in a collection, an id
 * that exactly one committed entry has, or an image reference of the entry's
 * own that resolves to a path absent from the commit. Anything less lists no
 * entry, and the editor reads only the code's sentence. Never throws.
 * @param {Object} options
 * @param {string} options.output - the failed build's output
 * @param {string[]} options.siteDirs - the site's directory in the check
 * @param {string} options.projectRoot - the live site directory
 * @param {string} options.commit - the checked commit
 * @param {Object} options.fullConfig - getConfig() result (content store, i18n)
 * @param {string|null} [options.checkSiteDir] - the site's directory in the
 *   check's worktree (the commit checked out), to load the commit's schemas from
 * @param {(siteDir: string) => Promise<Object>} [options.loadCommitSchemas] - tests only
 * @returns {Promise<Array<RefusedEntry>>}
 *
 * @typedef {Object} RefusedEntry
 * @property {string} collection
 * @property {string} slug - the editor's slug (only entries found in the commit are listed)
 * @property {string|null} locale
 * @property {'invalid'|'valid'|'unchecked'} validation - AstroAdmin's reading at the commit
 * @property {Array<{path: string, message: string, accepted?: string[]}>} issues
 */
export async function describeRefusedEntries({ output, siteDirs, projectRoot, commit, fullConfig, checkSiteDir = null, loadCommitSchemas = null }) {
  const keys = parseFailureKeys(output, siteDirs);
  if (keys.ids.length === 0 && keys.files.length === 0 && keys.images.length === 0) return [];
  try {
    const site = await commitSite({ projectRoot, commit, fullConfig, checkSiteDir, loadCommitSchemas });
    const found = [];
    const addEntry = (entry) => {
      if (!entry || found.length >= MAX_ENTRIES) return null;
      const key = `${entry.collection}\u0000${entry.slug}\u0000${entry.locale || ''}`;
      const existing = found.find((candidate) => candidate.key === key);
      if (existing) return existing;
      const added = { ...entry, key, imageIssues: [] };
      found.push(added);
      return added;
    };
    // A Location in the same error is Astro's own word for the file; without
    // one, the id must belong to exactly one committed entry.
    for (const { collection, id, file } of keys.ids) {
      addEntry(file ? site.entryForLocatedId(collection, id, file) : site.entryForId(collection, id));
    }
    for (const file of keys.files) addEntry(site.entryForCommittedFile(file));
    for (const image of keys.images) {
      for (const { entry, issues } of await site.entriesMissingImage(image)) {
        const added = addEntry(entry);
        if (added) added.imageIssues.push(...issues);
      }
    }
    const entries = [];
    for (const { key, file, imageIssues, itemId, ...entry } of found) {
      const reading = await site.validate({ ...entry, itemId }, file, imageIssues);
      entries.push({ ...entry, validation: reading.status, issues: reading.issues });
    }
    return entries;
  } catch (error) {
    console.error('Could not read the refused entries at the checked commit:', error);
    return [];
  }
}

async function gitOutput(cwd, args) {
  return runGit(cwd, args, { maxBuffer: 20 * 1024 * 1024 });
}

/**
 * The commit's own collection schemas, loaded from the check's worktree (the
 * commit checked out) and never through the live schema cache. null when they
 * cannot be loaded in time: then nothing is validated against a schema.
 */
async function loadSchemasAtCommit(checkSiteDir, loadCommitSchemas) {
  if (!checkSiteDir) return null;
  let timer;
  try {
    const load = loadCommitSchemas
      ? loadCommitSchemas(checkSiteDir)
      : import('./schema-parser.js').then(({ parseAstroSchemas }) => parseAstroSchemas(checkSiteDir));
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${SCHEMA_LOAD_TIMEOUT_MS / 1000} s`)), SCHEMA_LOAD_TIMEOUT_MS);
    });
    return await Promise.race([load, timeout]);
  } catch (error) {
    console.error('Could not load the content schemas at the checked commit; refused entries are listed without validation:', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The image paths the site's own markdown processor collects from a body as
 * local images (Astro 7's satteri processor, else @astrojs/markdown-remark):
 * so a path mentioned in prose or in code is not an image reference. null
 * when no processor can be loaded: then no body is blamed.
 */
async function siteMarkdownImages(projectRoot) {
  try {
    const fromSite = createRequire(path.join(projectRoot, 'package.json'));
    const fromAstro = createRequire(fromSite.resolve('astro/package.json'));
    let processor = null;
    try {
      const satteri = await import(pathToFileURL(fromAstro.resolve('@astrojs/markdown-satteri')).href);
      processor = await satteri.createSatteriMarkdownProcessor({ syntaxHighlight: false });
    } catch {
      const remark = await import(pathToFileURL(fromAstro.resolve('@astrojs/markdown-remark')).href);
      processor = await remark.createMarkdownProcessor({ syntaxHighlight: false });
    }
    return async (body) => {
      const result = await processor.render(body, { frontmatter: {} });
      return result.metadata.localImagePaths ?? result.metadata.imagePaths ?? [];
    };
  } catch (error) {
    console.error("Could not load the site's markdown processor; no entry body is blamed for a missing image:", error.message);
    return null;
  }
}

/**
 * The site-relative path an entry's image reference names, when it is one we
 * can resolve exactly: `./` or `../` relative to the entry's file, staying in
 * the site. Anything else (an alias, a root path, a bare name Vite resolves
 * as a package) is not resolved, so it confirms nothing.
 */
function resolveEntryImage(entryFile, reference) {
  if (typeof reference !== 'string' || !/^\.\.?\//.test(reference)) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryFile), reference.split(/[?#]/)[0]));
  return resolved.startsWith('../') || resolved === '..' ? null : resolved;
}

/**
 * The site's collections as files in a commit: which committed file is which
 * entry, and each entry's stored data at that commit.
 */
async function commitSite({ projectRoot, commit, fullConfig, checkSiteDir, loadCommitSchemas }) {
  const { loadSchemas } = await import('./collections.js');
  const { getGlobBaseDirectory, getGlobPatterns, matchesAnyPattern, resolveProjectPath, splitLocale } = await import('./glob-files.js');
  const commitSchemas = await loadSchemasAtCommit(checkSiteDir, loadCommitSchemas);
  // Which files are which collection: the commit's config, or (when it could
  // not be loaded) the live one, which is what the editor itself opens by.
  const layoutSchemas = commitSchemas || await loadSchemas();
  const i18n = fullConfig.i18n || { enabled: false, locales: [] };
  const repoTop = fs.realpathSync((await gitOutput(projectRoot, ['rev-parse', '--show-toplevel'])).trim());
  const siteInRepo = path.relative(repoTop, fs.realpathSync(projectRoot)).split(path.sep).join('/');
  const inRepo = (siteRelative) => (siteInRepo ? `${siteInRepo}/${siteRelative}` : siteRelative);
  const siteRelativeOf = (absolute) => path.relative(projectRoot, absolute).split(path.sep).join('/');

  // Every regular file committed under the site, site-relative. A symlink,
  // a gitlink or a file only the build produced is not a committed entry.
  const committed = new Set();
  {
    const listed = await gitOutput(projectRoot, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', inRepo('.')]);
    const prefix = siteInRepo ? `${siteInRepo}/` : '';
    for (const record of listed.split('\0')) {
      const match = /^(\d+) (\w+) [0-9a-f]+\t(.+)$/s.exec(record);
      if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) continue;
      if (match[3].startsWith(prefix)) committed.add(match[3].slice(prefix.length));
    }
  }

  // Each collection's files, relative to the site: a glob() base with its
  // patterns, or a file() collection's one file.
  const layouts = Object.entries(layoutSchemas).map(([collection, schema]) => (
    schema.loaderType === 'file' && schema.loaderFilePath
      ? { collection, file: siteRelativeOf(resolveProjectPath(schema.loaderFilePath)) }
      : { collection, base: siteRelativeOf(getGlobBaseDirectory(collection, schema)), patterns: getGlobPatterns(schema) }
  )).filter((layout) => !(layout.base ?? layout.file).startsWith('..'));

  /** The glob entry a site-relative file is, committed or not (null if none). */
  const globEntryForFile = (file) => {
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
      return { collection: layout.collection, slug, locale, file, inner };
    }
    return null;
  };
  const entryForCommittedFile = (file) => {
    if (!committed.has(file)) return null;
    const entry = globEntryForFile(file);
    if (!entry) return null;
    const { inner, ...rest } = entry;
    return rest;
  };

  // Committed texts, read in one git process per batch.
  const texts = new Map();
  const readAll = (files) => {
    const wanted = files.filter((file) => !texts.has(file));
    if (wanted.length === 0) return;
    const raw = runGitSync(projectRoot, ['cat-file', '--batch'], {
      input: wanted.map((file) => `${commit}:${inRepo(file)}\n`).join(''),
      maxBuffer: 100 * 1024 * 1024,
    });
    let offset = 0;
    for (const file of wanted) {
      const headerEnd = raw.indexOf(0x0a, offset);
      const header = raw.subarray(offset, headerEnd).toString('utf-8');
      offset = headerEnd + 1;
      const object = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!object) {
        texts.set(file, null); // missing
        continue;
      }
      const size = Number(object[2]);
      texts.set(file, object[1] === 'blob' ? raw.subarray(offset, offset + size).toString('utf-8') : null);
      offset += size + 1;
    }
  };
  const textOf = (file) => {
    readAll([file]);
    return texts.get(file) ?? null;
  };

  /** A file() collection's item ids, read as Astro reads them; null if unreadable. */
  const fileItemIds = (layout) => {
    if (!committed.has(layout.file) || !/\.json$/i.test(layout.file)) return null;
    const text = textOf(layout.file);
    if (text === null) return null;
    const parsed = parseCommittedText(layout.file, text);
    return parsed.issue ? null : fileLoaderItems(parsed.data).map((item) => item.id);
  };
  const fileEntry = (layout, id) => {
    const ids = fileItemIds(layout);
    if (!ids || ids.filter((candidate) => candidate === id).length !== 1) return null;
    return { collection: layout.collection, slug: id, locale: null, file: layout.file, itemId: id };
  };

  let markdownImages; // loaded on first use
  const bodyImagesOf = async (body) => {
    if (markdownImages === undefined) markdownImages = await siteMarkdownImages(projectRoot);
    if (!markdownImages) return null;
    try {
      return await markdownImages(body);
    } catch (error) {
      console.error('Could not read an entry body for its images:', error.message);
      return null;
    }
  };

  return {
    entryForCommittedFile,

    /** The entry an id error's own Location names, when it is a committed file of that collection. */
    entryForLocatedId(collection, id, file) {
      const layout = layouts.find((candidate) => candidate.collection === collection);
      if (!layout) return null;
      if (layout.file !== undefined) return layout.file === file ? fileEntry(layout, id) : null;
      const entry = entryForCommittedFile(file);
      return entry && entry.collection === collection ? entry : null;
    },

    /** The one committed entry Astro calls `id` in `collection`, or null (none, or more than one). */
    entryForId(collection, id) {
      const layout = layouts.find((candidate) => candidate.collection === collection);
      if (!layout) return null;
      if (layout.file !== undefined) return fileEntry(layout, id);
      const prefix = layout.base ? `${layout.base}/` : '';
      const files = [...committed].filter((file) => file.startsWith(prefix) && matchesAnyPattern(file.slice(prefix.length), layout.patterns));
      // A file whose id cannot be worked out (a format not read here) could
      // be the one: then nothing is confirmed.
      if (files.some((file) => !READABLE_ENTRY.test(file))) return null;
      readAll(files);
      const matches = files.filter((file) => {
        const text = texts.get(file);
        return text !== null && text !== undefined && globEntryId(file.slice(prefix.length), text) === id;
      });
      return matches.length === 1 ? entryForCommittedFile(matches[0]) : null;
    },

    /**
     * The committed entries one of whose OWN image references (an image()
     * field, or an image in a markdown body as the site's processor reads
     * it) is `image` and resolves, from the entry's file, to a path the
     * commit does not have; each with the issues that say where.
     */
    async entriesMissingImage(image) {
      const resolvedFrom = (file) => resolveEntryImage(file, image);
      const bases = layouts.filter((layout) => layout.base !== undefined).map((layout) => inRepo(layout.base || '.'));
      if (bases.length === 0) return [];
      let listed = '';
      try {
        listed = await gitOutput(projectRoot, ['grep', '-l', '-F', '--full-name', '-e', image, commit, '--', ...bases]);
      } catch (error) {
        if (error.code === 1) return []; // no match
        throw error;
      }
      const prefix = `${commit}:${siteInRepo ? `${siteInRepo}/` : ''}`;
      const candidates = listed.split('\n').filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
      const results = [];
      for (const file of candidates) {
        const entry = entryForCommittedFile(file);
        if (!entry) continue;
        const resolved = resolvedFrom(file);
        if (resolved === null || committed.has(resolved)) continue; // not ours to confirm, or present
        const text = textOf(file);
        if (text === null) continue;
        const parsed = parseCommittedText(file, text);
        if (parsed.issue) continue;
        const issues = [];
        const schema = commitSchemas?.[entry.collection]?.schema;
        if (schema) {
          for (const field of findImageFields(schema, parsed.data)) {
            if (field.value === image) issues.push({ path: formatIssuePath(field.path), message: `The image file ${image} was not found.` });
          }
        }
        if (typeof parsed.body === 'string' && MARKDOWN_BODY.test(file)) {
          const bodyImages = await bodyImagesOf(parsed.body);
          if (bodyImages?.includes(image)) issues.push({ path: 'body', message: `The body uses the image file ${image}, which was not found.` });
        }
        if (issues.length > 0) results.push({ entry, issues });
      }
      return results;
    },

    /** AstroAdmin's validation of one entry as stored at the commit, against the commit's schemas. */
    async validate(entry, file, imageIssues) {
      const text = textOf(file);
      if (text === null) {
        console.error(`Could not read ${file} at ${commit.slice(0, 7)}.`);
        return { status: 'unchecked', issues: [] };
      }
      return validateCommittedText({ schemas: commitSchemas, collection: entry.collection, file, text, itemId: entry.itemId ?? null, extraIssues: imageIssues });
    },
  };
}
