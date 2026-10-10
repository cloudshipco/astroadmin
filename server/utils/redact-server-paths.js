/**
 * Text that leaves the server names no server path.
 *
 * One place for it: the publish check's output (astro-check.js), the
 * doctor's reasons (doctor/editor.js), and every error message an API route
 * sends (clientErrorMessage). Synchronous fs only, like the doctor and the
 * publish check that import it (see CLAUDE.md: Bun can lose an fs/promises
 * completion while child processes start and exit).
 */

import fs from 'fs';
import path from 'path';

/**
 * Make check output fit to show an editor: no terminal colour codes, no stack
 * trace or stack frames, and no server paths (each given directory becomes
 * relative, including inside file:// URLs).
 * @param {string} text
 * @param {string[]} [serverPaths] - directories to strip
 */
export function cleanCheckOutput(text, serverPaths = []) {
  // eslint-disable-next-line no-control-regex
  let cleaned = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  cleaned = cleaned.replace(/^\s*Stack trace:[\s\S]*$/m, '');
  cleaned = cleaned.replace(/^\s+at .*$\n?/gm, '');
  cleaned = cleaned.replace(/file:\/\/(\S+)/g, (match, encodedPath) => {
    try {
      return decodeURIComponent(encodedPath);
    } catch {
      return encodedPath;
    }
  });
  // Longest first, so a worktree inside a stripped directory is removed whole.
  const prefixes = [...new Set(serverPaths.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    cleaned = cleaned.split(`${prefix}/`).join('').split(prefix).join('.');
  }
  return cleaned.trim();
}

/**
 * A `../../..`-relative path (esbuild names files relative to the process's
 * working directory) as the server would resolve it: made relative to the
 * server directory it falls in, or, when it climbs to the filesystem root
 * and is in none of them, reduced to its last segment. Any other relative
 * path is the site's own (`../assets/x.png`) and is kept.
 */
function redactRelativeClimb(relativePath, directories) {
  const resolved = path.resolve(process.cwd(), relativePath);
  const inside = [...directories].sort((a, b) => b.length - a.length)
    .find((directory) => resolved === directory || resolved.startsWith(`${directory}/`));
  if (inside) return path.relative(inside, resolved) || '.';
  const climbs = relativePath.match(/^(?:\.\.\/)+/)[0].length / 3;
  const depth = process.cwd().split('/').filter(Boolean).length;
  return climbs >= depth ? path.basename(resolved) : relativePath;
}

/**
 * Error text that names no server path: the given server directories (and
 * their resolved paths, so a symlinked checkout is caught) made relative, then
 * any other absolute path reduced to its last segment (an external git
 * directory, a resolved temp dir), and a relative path that climbs out of the
 * working directory to the root treated as the absolute path it is. URLs are
 * kept: `https://host/x` has no path start after a delimiter.
 * @param {string} text
 * @param {Array<string|null|undefined>} serverPaths
 * @returns {string}
 */
export function redactServerPaths(text, serverPaths = []) {
  const directories = serverPaths.filter(Boolean);
  for (const directory of [...directories]) {
    try {
      directories.push(fs.realpathSync(directory));
    } catch {
      // gone: nothing more to strip
    }
  }
  // Climbs first: a climb's tail (`../../private/var/site/x`) holds the
  // directory as a substring, which the prefix strip would cut out of it.
  const climbsResolved = String(text)
    .replace(/(^|[\s"'(=:])((?:\.\.\/)+[^\s"'()]+)/g, (match, lead, relativePath) => lead + redactRelativeClimb(relativePath, directories));
  return cleanCheckOutput(climbsResolved, directories)
    .replace(/(^|[\s"'(=:])\/(?:[^\s"'()/]+\/)+([^\s"'()/]*)/g, '$1$2');
}

/**
 * An error's message as an API response may carry it: server paths redacted
 * (the given directories made relative, any other absolute path reduced to
 * its last segment, so `unlink '/srv/site/public/images/x.png'` reads
 * `unlink 'public/images/x.png'` with the project root given, `'x.png'`
 * without).
 * @param {unknown} error - an Error, or anything with a message, or a string
 * @param {Array<string|null|undefined>} [serverPaths] - e.g. the project root
 * @returns {string}
 */
export function clientErrorMessage(error, serverPaths = []) {
  const text = typeof error === 'string' ? error : String(error?.message ?? error ?? '');
  return redactServerPaths(text, serverPaths).trim();
}
