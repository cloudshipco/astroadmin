/**
 * Check a commit with the site's own Astro before it is pushed.
 *
 * The site's host (e.g. Netlify) builds every pushed commit, and an entry its
 * collection schema rejects fails that build. Rather than re-implement Astro's
 * loading (glob discovery, YAML parsing, file() collections, reference(),
 * image()...), which drifts from Astro in both directions, we run the site's
 * own `astro build`: the same check the host will run, and for these small
 * sites barely slower than `astro sync`, which skips some of it (a missing
 * image() file passes sync and fails the build).
 *
 * It runs in a throwaway git worktree checked out at the exact commit about to
 * be pushed, so what passes is precisely what leaves the box: not the working
 * tree (which an autosave can change mid-publish, and which can hold a fix that
 * was never committed), and after any rebase onto the remote. Like the host's
 * build, it sees only committed files.
 *
 * TRUST BOUNDARY: the site's code (its config, integrations, build scripts) is
 * trusted — it is ours; editors change content only. The worktree keeps an
 * honest build from reading the live checkout's uncommitted state or writing
 * over its caches. It is not a sandbox against hostile site code (that is the
 * hosted platform's isolation work). Layouts it cannot reproduce faithfully
 * (git submodules, workspace packages linked back into the repo) are refused
 * rather than checked approximately.
 */

import { execFile, spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_CHECK_COMMAND = 'bunx --bun astro build';
const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * The outcome of a check.
 * @typedef {Object} AstroCheckResult
 * @property {boolean} success
 * @property {string} commit - the SHA that was checked
 * @property {string} output - the command's output, cleaned for an editor to read
 * @property {Array<{collection: string, slug: string}>} entries - entries Astro named as invalid (Astro IDs)
 */

// The admin's own secrets and settings, which the site's build has no use for.
const ADMIN_ENV_PATTERN = /^(ASTROADMIN_|ADMIN_|SESSION_SECRET$)/;

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
 * Entries named in Astro's errors, e.g.
 * "[InvalidContentEntryDataError] pages → home data does not match collection schema."
 * These are Astro IDs, which are not always the editor's slugs.
 * @param {string} output
 * @returns {Array<{collection: string, slug: string}>}
 */
export function parseInvalidEntries(output) {
  const entries = [];
  const seen = new Set();
  for (const match of output.matchAll(/\[InvalidContentEntryDataError\]\s+(\S+)\s+→\s+(\S+)/g)) {
    const key = `${match[1]}/${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ collection: match[1], slug: match[2] });
  }
  return entries;
}

async function realpathOrNull(target) {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

async function exists(target) {
  return (await realpathOrNull(target)) !== null;
}

/**
 * Give one worktree directory a node_modules that links each package to the
 * live checkout's, so nothing is installed. Dot-directories other than .bin are
 * left out: Astro writes its data store to node_modules/.astro (its default
 * cacheDir) and Vite its caches beside it, and sharing them would let the check
 * overwrite the running preview's.
 */
async function linkNodeModules(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of await fs.readdir(sourceDir)) {
    if (entry.startsWith('.') && entry !== '.bin') continue;
    await fs.symlink(path.join(sourceDir, entry), path.join(targetDir, entry));
  }
}

/**
 * A package in node_modules that is a link back into the repository (a
 * workspace package) would resolve to the live checkout's UNCOMMITTED copy,
 * so the check would not be of the commit. Returns the first one found.
 */
export async function findWorkspaceLink(nodeModulesDir, realRepoTop) {
  const candidates = [];
  for (const entry of await fs.readdir(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const member of await fs.readdir(path.join(nodeModulesDir, entry))) {
        candidates.push(path.join(nodeModulesDir, entry, member));
      }
    } else {
      candidates.push(path.join(nodeModulesDir, entry));
    }
  }
  for (const candidate of candidates) {
    const real = await realpathOrNull(candidate);
    if (real !== null && real.startsWith(`${realRepoTop}${path.sep}`)
      && !path.relative(realRepoTop, real).split(path.sep).includes('node_modules')) {
      return path.relative(nodeModulesDir, candidate);
    }
  }
  return null;
}

/**
 * Copy the site's gitignored .env files, which a worktree does not have and
 * the site's config may need to load. A .env the commit tracks is already in
 * the worktree and is the committed version, so it is never overwritten.
 */
async function copyEnvFiles(projectRoot, siteDir) {
  for (const entry of await fs.readdir(projectRoot)) {
    if (entry !== '.env' && !entry.startsWith('.env.')) continue;
    const target = path.join(siteDir, entry);
    if (await exists(target)) continue;
    await fs.copyFile(path.join(projectRoot, entry), target);
  }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/**
 * Run a shell command in its own process group. On timeout, kill the WHOLE
 * group (the shell, bunx, astro and anything they started) and settle at once:
 * a descendant that left the group can keep the output pipes open, and waiting
 * for them to close would hold the git lock forever.
 * @returns {Promise<{exitCode: number|null, output: string, timedOut: boolean}>}
 */
export function runCommand(command, cwd, timeoutMs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const collect = (chunk) => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      child.stdout.destroy();
      child.stderr.destroy();
      settle({ exitCode: null, output, timedOut: true });
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => settle({ exitCode, output, timedOut: false }));
  });
}

/** The admin's environment minus its own secrets and settings. */
export function buildEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !ADMIN_ENV_PATTERN.test(name)));
}

/**
 * Paths of the git submodules (gitlinks, mode 160000) in a commit's tree.
 * @param {string} projectRoot
 * @param {string} revision
 * @returns {Promise<string[]>}
 */
export async function listGitlinks(projectRoot, revision) {
  const tree = await git(projectRoot, ['ls-tree', '-r', '--full-tree', revision]);
  return tree.split('\n').filter((line) => line.startsWith('160000 ')).map((line) => line.split('\t')[1]);
}

/**
 * Where node_modules can live for a site: its own directory or any directory
 * above it up to the repository root (hoisted monorepo installs).
 * @param {string} realRepoTop
 * @param {string} siteSubdir - the site's directory relative to the repo root
 * @returns {Array<{relativeDir: string, liveNodeModules: string}>}
 */
export function nodeModulesLevels(realRepoTop, siteSubdir) {
  const levels = siteSubdir ? siteSubdir.split(path.sep) : [];
  const result = [];
  for (let depth = 0; depth <= levels.length; depth++) {
    const relativeDir = levels.slice(0, depth).join(path.sep);
    result.push({ relativeDir, liveNodeModules: path.join(realRepoTop, relativeDir, 'node_modules') });
  }
  return result;
}

/** The repository's real top and the site's directory within it. */
async function locateSite(projectRoot) {
  const realRepoTop = await fs.realpath(await git(projectRoot, ['rev-parse', '--show-toplevel']));
  const siteSubdir = path.relative(realRepoTop, await fs.realpath(projectRoot));
  return { realRepoTop, siteSubdir };
}

/**
 * The first workspace package linked back into the site's repository, from
 * any node_modules the site resolves from, or null.
 * @param {string} projectRoot
 */
export async function findWorkspaceLinkForProject(projectRoot) {
  const { realRepoTop, siteSubdir } = await locateSite(projectRoot);
  for (const { liveNodeModules } of nodeModulesLevels(realRepoTop, siteSubdir)) {
    if (!(await exists(liveNodeModules))) continue;
    const workspaceLink = await findWorkspaceLink(liveNodeModules, realRepoTop);
    if (workspaceLink) return workspaceLink;
  }
  return null;
}

/**
 * Run the site's check against HEAD in a throwaway worktree.
 * Never throws: any failure to run the check is a failed check (fail closed).
 * @param {Object} fullConfig - getConfig() result. The command is `build.check`,
 *   else the site's `build.production` (so the check builds the way the site is
 *   built), else `astro build`; `build.checkTimeoutMs` overrides the time limit.
 * @param {Object} [options]
 * @param {(build: {siteDir: string, commit: string, command: string}) => Promise<void>} [options.onBuilt] -
 *   called after a check that passed, while its worktree (and the build output
 *   in it) still exists. Errors it throws are logged and ignored: it can never
 *   fail the check. It must bound its own running time.
 * @returns {Promise<AstroCheckResult>}
 */
export async function checkHeadWithAstro(fullConfig, { onBuilt } = {}) {
  const projectRoot = fullConfig.paths.projectRoot;
  const command = fullConfig.build?.check || fullConfig.build?.production || DEFAULT_CHECK_COMMAND;
  const timeoutMs = fullConfig.build?.checkTimeoutMs || DEFAULT_CHECK_TIMEOUT_MS;
  let commit = '';
  let tempDir = null;
  const serverPaths = [projectRoot, await realpathOrNull(projectRoot)];

  const fail = (output) => {
    const cleaned = cleanCheckOutput(output, serverPaths);
    console.error(`❌ Content check failed for ${commit.slice(0, 7) || 'HEAD'}`);
    return { success: false, commit, output: cleaned.slice(-4000), entries: parseInvalidEntries(cleaned) };
  };

  try {
    commit = await git(projectRoot, ['rev-parse', 'HEAD']);
    // A site in a subdirectory of its repo (monorepo `subdir`) sits at the same
    // place inside the worktree.
    const { realRepoTop, siteSubdir } = await locateSite(projectRoot);
    serverPaths.push(realRepoTop);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astroadmin-check-'));
    serverPaths.push(tempDir, await realpathOrNull(tempDir));
    const worktreeDir = path.join(tempDir, 'worktree');
    await git(projectRoot, ['worktree', 'add', '--detach', worktreeDir, commit]);

    // A worktree does not populate submodules (gitlinks, mode 160000), so
    // content kept in one would silently be checked as empty. Refuse instead.
    if ((await listGitlinks(projectRoot, commit)).length > 0) {
      return fail('This site uses git submodules, which the publish check does not support, so nothing was pushed.');
    }

    // node_modules can live in the site's directory or any directory above it
    // up to the repository root (hoisted monorepo installs); mirror each one.
    const siteDir = path.join(worktreeDir, siteSubdir);
    for (const { relativeDir, liveNodeModules } of nodeModulesLevels(realRepoTop, siteSubdir)) {
      if (!(await exists(liveNodeModules))) continue;
      const workspaceLink = await findWorkspaceLink(liveNodeModules, realRepoTop);
      if (workspaceLink) {
        return fail(`This site depends on a workspace package (${workspaceLink}) inside its own repository, which the publish check does not support, so nothing was pushed.`);
      }
      await linkNodeModules(liveNodeModules, path.join(worktreeDir, relativeDir, 'node_modules'));
    }
    await copyEnvFiles(projectRoot, siteDir);

    console.log(`🔎 Checking ${commit.slice(0, 7)} with: ${command}`);
    const result = await runCommand(command, siteDir, timeoutMs, buildEnvironment());
    if (result.timedOut) {
      return fail(`${result.output}\nThe check did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    if (result.exitCode !== 0) {
      return fail(result.output);
    }
    if (onBuilt) {
      try {
        await onBuilt({ siteDir, commit, command });
      } catch (error) {
        console.error('After-check hook failed (ignored):', error.message);
      }
    }
    return { success: true, commit, output: cleanCheckOutput(result.output, serverPaths).slice(-4000), entries: [] };
  } catch (error) {
    return fail(`${error.stdout || ''}${error.stderr || ''}` || error.message);
  } finally {
    // Deleting the directory and pruning removes the worktree and git's record of it.
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await git(projectRoot, ['worktree', 'prune']).catch(() => {});
  }
}
