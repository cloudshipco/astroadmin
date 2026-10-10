/**
 * Build output an editor may read, and nothing else.
 *
 * Error text reaches an editor in two ways, and only one of them is free text:
 *
 * - API errors: every route sends a fixed, route-specific message and logs
 *   the error itself (console.error). Nothing here: an error's message is
 *   never sent, so there is nothing to scrub.
 * - Build output: the publish check's refusal (astro-check.js), a production
 *   build's output (publish.js, api/build.js) and the doctor's build output.
 *   Astro's own message is the point of it (it names the entry and field to
 *   fix), so it is shown, cleaned by cleanCheckOutput below.
 *
 * cleanCheckOutput removes only what it KNOWS: terminal colour codes, stack
 * frames, and the directories the caller names (the check's worktree, the
 * project root, their resolved paths), as a plain prefix where a path starts.
 * It rewrites nothing else. If what is left still names a server path (an
 * absolute path into this server's filesystem, a `file://` URL, a climb to
 * the filesystem root, or a known directory somewhere a prefix strip does not
 * reach), the whole output is replaced by a fixed message and the original is
 * logged. Scrubbing arbitrary text was tried and could not be made complete;
 * an allowlist with a fallback can.
 *
 * Synchronous fs only, like the doctor and the publish check that import it
 * (see CLAUDE.md: Bun can lose an fs/promises completion while child
 * processes start and exit).
 */

import fs from 'fs';
import path from 'path';

/** What the editor sees when build output names a server path. */
export const HIDDEN_OUTPUT_MESSAGE = 'The publish check failed; see the server log.';

/**
 * Top-level directories a server path starts with: this machine's own (`/`
 * listed once) and the usual ones elsewhere, so a path from another layout
 * (a container's /srv on a Mac) is recognised too. A page path such as
 * `/blog/[slug]` starts with none of them, so it is the site's, and stays.
 */
const COMMON_TOP_LEVEL = [
  'Applications', 'Library', 'System', 'Users', 'Volumes', 'bin', 'boot', 'cores', 'dev', 'etc',
  'home', 'lib', 'lib32', 'lib64', 'mnt', 'nix', 'opt', 'private', 'proc', 'root', 'run',
  'sbin', 'snap', 'srv', 'sys', 'tmp', 'usr', 'var', 'workspace',
];
let topLevelCache = null;
function topLevelDirectories() {
  if (!topLevelCache) {
    let own = [];
    try {
      own = fs.readdirSync('/');
    } catch {
      // unreadable root: the common names still apply
    }
    topLevelCache = new Set([...COMMON_TOP_LEVEL, ...own]);
  }
  return topLevelCache;
}

/**
 * The caller's directories, absolute, with the resolved path of each,
 * de-duplicated and longest first (a worktree inside the project root is
 * removed whole). `/` is never a root.
 * @param {Array<string|null|undefined>} roots
 * @returns {string[]}
 */
function knownRoots(roots) {
  const candidates = roots.filter(Boolean).map((directory) => path.resolve(String(directory)));
  for (const directory of [...candidates]) {
    try {
      candidates.push(fs.realpathSync(directory));
    } catch {
      // gone: nothing more to strip
    }
  }
  return [...new Set(candidates)].filter((directory) => directory !== path.sep)
    .sort((a, b) => b.length - a.length);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Where a path starts: the start of a line, or after whitespace, a quote, a
// backtick or an opening bracket. Not after `=` or `:`: a known directory
// inside a URL's query is left in place, and then hides the output (below).
const PATH_START = '(?<=^|[\\s\'"`(\\[<{,;])';
// Where a server path is DETECTED: the same, plus `=` and `:` (a query value,
// `error:/srv/x`).
const DETECT_START = '(?<=^|[\\s\'"`(\\[<{,;=:])';

/** Remove each known root where a path starts: `root/x` -> `x`, a bare `root` -> `.`. */
function stripRoots(text, roots) {
  let cleaned = text;
  for (const root of roots) {
    const encoded = root.split('/').map(encodeURIComponent).join('/');
    for (const form of new Set([`file://${encoded}`, `file://${root}`, root])) {
      const escaped = escapeRegExp(form);
      cleaned = cleaned
        .replace(new RegExp(`${PATH_START}${escaped}/`, 'gm'), '')
        // The bare directory only where its path ends: not `/srv/site-b`,
        // `/srv/site backup` or `/srv/site+x`.
        .replace(new RegExp(`${PATH_START}${escaped}(?=$|[\\n'"\`:,;)\\]]|\\.(?:\\s|$))`, 'gm'), '.');
    }
  }
  return cleaned;
}

/**
 * The first thing in `text` that names a server path, or null.
 * @param {string} text - after stripRoots
 * @param {string[]} roots - knownRoots() result
 * @returns {string|null}
 */
export function findServerPath(text, roots = []) {
  const fileUrl = text.match(/file:\/\/?[^\s'"`]*/i);
  if (fileUrl) return fileUrl[0];
  const root = roots.find((directory) => text.includes(directory));
  if (root) return root;
  const topLevel = topLevelDirectories();
  for (const match of text.matchAll(new RegExp(`${DETECT_START}\\/([^\\s/'"\`]+)\\/`, 'gm'))) {
    if (topLevel.has(match[1])) return match[0];
  }
  const home = text.match(new RegExp(`${DETECT_START}~\\/`, 'm'));
  if (home) return home[0];
  // A relative path that climbs out (esbuild names files relative to its
  // working directory) names server directories when it reaches the
  // filesystem root, or when what it names beside the directory it climbed
  // to exists (`../site-b/...`, a sibling checkout). One that names nothing
  // here, such as an image's `../assets/x.png`, is the site's own.
  const bases = [...roots, process.cwd()];
  const shallowest = Math.min(...bases.map((directory) => directory.split('/').filter(Boolean).length));
  for (const match of text.matchAll(new RegExp(`${DETECT_START}((?:\\.\\.\\/)+)(.*)`, 'gm'))) {
    const [token, climb, rest] = match;
    if (climb.length / 3 >= shallowest) return token;
    // The name may hold spaces or quotes (`../my site/...`), so compare the
    // directory's entries with the text rather than cutting the text at one.
    if (bases.some((base) => namesEntryOf(path.resolve(base, climb), rest))) return token;
  }
  return null;
}

/** Whether `rest` starts with the name of something in `directory`, followed by a path end. */
function namesEntryOf(directory, rest) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return false;
  }
  return entries.some((entry) => rest.startsWith(entry)
    && (rest.length === entry.length || /[/\s'"`:,;)\]]/.test(rest[entry.length])));
}

/**
 * Build output fit to show an editor: no colour codes, no stack trace, the
 * known directories removed; or, if a server path is left in it, the
 * fallback message (and the original goes to the server log).
 * @param {string} text
 * @param {Array<string|null|undefined>} [roots] - the directories to remove (the check's worktree, the project root)
 * @param {{hiddenMessage?: string, label?: string}} [options]
 * @returns {string}
 */
export function cleanCheckOutput(text, roots = [], { hiddenMessage = HIDDEN_OUTPUT_MESSAGE, label = 'Build output' } = {}) {
  const directories = knownRoots(roots);
  // eslint-disable-next-line no-control-regex
  let cleaned = String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  cleaned = cleaned.replace(/^\s*Stack trace:[\s\S]*$/m, '');
  cleaned = cleaned.replace(/^\s+at .*$\n?/gm, '');
  cleaned = stripRoots(cleaned, directories).trim();
  const serverPath = findServerPath(cleaned, directories);
  if (serverPath) {
    console.error(`${label} named a server path, so the editor was shown "${hiddenMessage}" instead. The output:\n${text}`);
    return hiddenMessage;
  }
  return cleaned;
}
