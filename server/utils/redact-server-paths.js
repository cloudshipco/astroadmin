/**
 * Text that leaves the server names no server path.
 *
 * One place for it: the publish check's output (astro-check.js), the
 * doctor's reasons (doctor/editor.js), and every error message an API route
 * sends (clientErrorMessage). Synchronous fs only, like the doctor and the
 * publish check that import it (see CLAUDE.md: Bun can lose an fs/promises
 * completion while child processes start and exit).
 *
 * The server's own directories are ALWAYS stripped, whatever a caller passes:
 * the project root (ASTROADMIN_PROJECT_ROOT, else the working directory, as
 * config.js resolves it), the working directory, anything registered with
 * addServerPaths (createServer registers the configured root), and the
 * resolved path of each. A caller adds to that list; it cannot forget it.
 * The home directory and anything above it are never used as a prefix: a
 * path under them would come out naming the folders below it (`Code/x/y`),
 * where the absolute-path rule reduces it to its last segment.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const registeredServerPaths = new Set();

/**
 * Register more directories every redaction in this process strips (e.g. the
 * project root a site's astroadmin.config.js configured).
 * @param {...(string|null|undefined)} directories
 */
export function addServerPaths(...directories) {
  for (const directory of directories) {
    if (directory) registeredServerPaths.add(path.resolve(String(directory)));
  }
}

/** `/`, the home directory and its ancestors: too broad to make paths relative to. */
function isTooBroad(directory) {
  if (!directory || directory === path.sep) return true;
  const home = os.homedir();
  return Boolean(home) && (home === directory || home.startsWith(`${directory}/`));
}

/**
 * The directories to strip: the defaults, the caller's, and the resolved
 * path of each, absolute and de-duplicated, longest first (so a worktree
 * inside a stripped directory is removed whole).
 * @param {Array<string|null|undefined>} serverPaths
 * @returns {string[]}
 */
function serverDirectories(serverPaths = []) {
  const candidates = [
    process.env.ASTROADMIN_PROJECT_ROOT || process.cwd(),
    process.cwd(),
    ...registeredServerPaths,
    ...serverPaths,
  ].filter(Boolean).map((directory) => path.resolve(String(directory)));
  for (const directory of [...candidates]) {
    try {
      candidates.push(fs.realpathSync(directory));
    } catch {
      // gone: nothing more to strip
    }
  }
  return [...new Set(candidates)].filter((directory) => !isTooBroad(directory))
    .sort((a, b) => b.length - a.length);
}

/**
 * Make check output fit to show an editor: no terminal colour codes, no stack
 * trace or stack frames, and no server paths (each server directory becomes
 * relative, including inside file:// URLs).
 * @param {string} text
 * @param {Array<string|null|undefined>} [serverPaths] - directories to strip, beyond the defaults
 */
export function cleanCheckOutput(text, serverPaths = []) {
  return stripDirectories(text, serverDirectories(serverPaths));
}

function stripDirectories(text, directories) {
  // eslint-disable-next-line no-control-regex
  let cleaned = String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  cleaned = cleaned.replace(/^\s*Stack trace:[\s\S]*$/m, '');
  cleaned = cleaned.replace(/^\s+at .*$\n?/gm, '');
  cleaned = cleaned.replace(/file:\/\/(\S+)/g, (match, encodedPath) => {
    try {
      return decodeURIComponent(encodedPath);
    } catch {
      return encodedPath;
    }
  });
  // A quoted absolute path is one token, spaces and the other quote character
  // included ("/srv/client's site/x", '/srv/site backup/x'): redact it whole.
  cleaned = cleaned.replace(/'(\/[^'\n]*)'|"(\/[^"\n]*)"/g, (match, single, double) => {
    const quote = single !== undefined ? "'" : '"';
    return quote + redactAbsoluteToken(single ?? double, directories) + quote;
  });
  for (const prefix of directories) {
    // Only at a path start (not inside a URL or another path), and the bare
    // directory only where the path ends: `/srv/site` must not match inside
    // `/srv/site-b/x` or `http://host/srv/site/x`.
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned
      .replace(new RegExp(`(?<![\\w./:~-])${escaped}/`, 'g'), '')
      .replace(new RegExp(`(?<![\\w./:~-])${escaped}(?=$|[\\s'"\`:,;)\\]])`, 'g'), '.');
  }
  return cleaned.trim();
}

/**
 * One whole absolute path: relative to the server directory it is inside, the
 * directory itself as `.`, anything else reduced to its last segment.
 */
function redactAbsoluteToken(absolutePath, directories) {
  for (const directory of directories) {
    if (absolutePath === directory) return '.';
    if (absolutePath.startsWith(`${directory}/`)) return absolutePath.slice(directory.length + 1);
  }
  return absolutePath.includes('/', 1) ? path.basename(absolutePath) : absolutePath;
}

/**
 * A `../`-relative path (esbuild names files relative to the process's
 * working directory), resolved against the working directory:
 * - inside a server directory: made relative to it (`src/content.config.ts`);
 * - climbing to the filesystem root, or into a directory that EXISTS beside
 *   the one it climbed to (`../site-a/...`, a sibling checkout): reduced to
 *   its last segment, since anything more names server directories;
 * - otherwise kept: it names nothing on this server, so it is the site's own
 *   relative value (`../assets/images/x.png` from a content file).
 */
function redactRelativeClimb(relativePath, directories) {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, relativePath);
  const inside = directories.find((directory) => resolved === directory || resolved.startsWith(`${directory}/`));
  if (inside) return path.relative(inside, resolved) || '.';
  const climbPrefix = relativePath.match(/^(?:\.\.\/)+/)[0];
  const climbs = climbPrefix.length / 3;
  const depth = cwd.split('/').filter(Boolean).length;
  if (climbs >= depth) return path.basename(resolved);
  const firstSegment = relativePath.slice(climbPrefix.length).split('/')[0];
  if (firstSegment && fs.existsSync(path.join(path.resolve(cwd, climbPrefix), firstSegment))) {
    return path.basename(resolved);
  }
  return relativePath;
}

/**
 * Error text that names no server path: the server directories (the defaults
 * above plus the caller's, and their resolved paths) made relative, then any
 * other absolute path reduced to its last segment (an external git directory,
 * a resolved temp dir), and a relative path that climbs out of the working
 * directory handled as redactRelativeClimb says. A quoted path ('...' or
 * "...") is one path even with spaces in it; an unquoted one ends at the first
 * space (a server directory's own path is matched whole even so; an unknown,
 * unquoted, spaced path is the one thing that can leave a fragment). URLs are kept: `https://host/x` has no path start after a delimiter.
 * @param {string} text
 * @param {Array<string|null|undefined>} [serverPaths] - directories to strip, beyond the defaults
 * @returns {string}
 */
export function redactServerPaths(text, serverPaths = []) {
  const directories = serverDirectories(serverPaths);
  // Each server directory's own climb (`../my site/`, as esbuild names it)
  // goes first and whole, since an unquoted one would end at the space.
  // Only at a path start: `../../my site/` is somewhere else.
  let withoutOwnClimbs = String(text);
  for (const directory of directories) {
    const climb = path.relative(process.cwd(), directory);
    if (!climb.startsWith('../')) continue;
    const escaped = climb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    withoutOwnClimbs = withoutOwnClimbs.replace(new RegExp(`(?<![./])${escaped}/`, 'g'), '');
  }
  // Climbs next: a climb's tail (`../../private/var/site/x`) holds the
  // directory as a substring, which the prefix strip would cut out of it.
  const climbsResolved = withoutOwnClimbs
    .replace(/(['"])((?:\.\.\/)+[^'"\n]+)\1/g, (match, quote, relativePath) => quote + redactRelativeClimb(relativePath, directories) + quote)
    .replace(/(^|[\s"'(=:])((?:\.\.\/)+[^\s"'()]+)/g, (match, lead, relativePath) => lead + redactRelativeClimb(relativePath, directories));
  return stripDirectories(climbsResolved, directories)
    // Any other unquoted absolute path (quoted ones were redacted whole above).
    .replace(/(^|[\s"'(=:])\/(?:[^\s"'()/]+\/)+([^\s"'()/]*)/g, '$1$2');
}

/**
 * An error's message as an API response may carry it: server paths redacted
 * (the server directories made relative, any other absolute path reduced to
 * its last segment, so `unlink '/srv/site/public/images/x.png'` reads
 * `unlink 'public/images/x.png'` when /srv/site is the project root, `'x.png'`
 * when it is not).
 * @param {unknown} error - an Error, or anything with a message, or a string
 * @param {Array<string|null|undefined>} [serverPaths] - directories to strip, beyond the defaults
 * @returns {string}
 */
export function clientErrorMessage(error, serverPaths = []) {
  const text = typeof error === 'string' ? error : String(error?.message ?? error ?? '');
  return redactServerPaths(text, serverPaths).trim();
}
