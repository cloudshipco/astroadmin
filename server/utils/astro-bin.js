/**
 * The site's own installed astro, and the commands that run it.
 *
 * A package runner is never used for the default commands: `bunx astro` (even
 * with --no-install) runs an astro from the registry or Bun's global cache when
 * the site has none installed, or has the package but no node_modules/.bin
 * link, so a site would be built (and the publish check would pass or fail) by
 * an Astro it never chose, downloaded and run on the host as the site's user.
 * Instead the bin is read from node_modules/astro/package.json and run by Bun
 * with auto-install off; when it is missing, the caller refuses.
 */

import { execFile } from 'child_process';
// Synchronous fs on purpose: under Bun 1.3.4 on macOS an fs/promises call made
// while child processes come and go can lose its completion and never settle,
// hanging the process at 0% CPU. These paths run git and builds, so they use
// the sync calls (small files, bounded walks).
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const ASTRO_NOT_INSTALLED_MESSAGE = "astro is not installed in this site (no node_modules/astro in its directory or above it in the repository); run the site's install first.";

/** The Bun running the admin (the runtime the builds run under). */
export function bunExecutable() {
  return process.versions.bun ? process.execPath : 'bun';
}

/**
 * A word for /bin/sh: left as it is when it holds only characters the shell
 * does not interpret (so `--outDir dist` stays readable to outDirFor), else
 * single-quoted.
 * @param {string} word
 */
export function shellQuote(word) {
  const text = String(word);
  if (/^[A-Za-z0-9_./=:@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The astro executable the site has installed: the `bin` of node_modules/astro
 * in the site's directory, or in any directory above it up to the repository
 * root (a monorepo with hoisted node_modules). Null when there is none.
 * @param {string} projectRoot
 * @returns {Promise<string|null>} an absolute, real path
 */
export async function findAstroExecutable(projectRoot) {
  let directory = fs.realpathSync(projectRoot);
  let top = directory;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot });
    top = fs.realpathSync(stdout.trim());
  } catch {
    // not a repository: only the site's own node_modules
  }
  for (;;) {
    const packageDir = path.join(directory, 'node_modules', 'astro');
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'));
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.astro;
      if (bin) return fs.realpathSync(path.join(packageDir, bin));
    } catch {
      // not installed at this level
    }
    const parent = path.dirname(directory);
    if (directory === top || parent === directory || !directory.startsWith(`${top}${path.sep}`)) return null;
    directory = parent;
  }
}

/**
 * A /bin/sh command that runs the site's installed astro under Bun with
 * auto-install off, e.g. `'<bun>' --no-install --bun '<astro bin>' build`.
 * @param {string} siteDir - where astro is resolved from (and will run)
 * @param {string[]} args - astro's arguments
 * @returns {Promise<string|null>} null when astro is not installed
 */
export async function defaultAstroCommand(siteDir, args) {
  const astroBin = await findAstroExecutable(siteDir);
  if (!astroBin) return null;
  return [bunExecutable(), '--no-install', '--bun', astroBin, ...args].map(shellQuote).join(' ');
}

/** astro's arguments for the default build commands (a configured one replaces these). */
export const DEFAULT_BUILD_ARGS = {
  staging: ['build', '--outDir', 'staging-dist'],
  production: ['build', '--outDir', 'dist'],
};

/**
 * The command for a build: the configured one if set, else the site's installed
 * astro with the default arguments.
 * @param {string|null|undefined} configured - e.g. config.build.production
 * @param {'staging'|'production'} kind
 * @param {string} siteDir
 * @returns {Promise<{command: string|null, error: string|null}>}
 */
export async function resolveBuildCommand(configured, kind, siteDir) {
  if (configured) return { command: configured, error: null };
  const command = await defaultAstroCommand(siteDir, DEFAULT_BUILD_ARGS[kind]);
  return command ? { command, error: null } : { command: null, error: ASTRO_NOT_INSTALLED_MESSAGE };
}
