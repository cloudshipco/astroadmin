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

import { spawn } from 'child_process';
// Synchronous fs on purpose: under Bun 1.3.4 on macOS an fs/promises call made
// while child processes come and go can lose its completion and never settle,
// hanging the process at 0% CPU. These paths run git and builds, so they use
// the sync calls (small files, bounded walks).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ASTRO_NOT_INSTALLED_MESSAGE, DEFAULT_BUILD_ARGS, defaultAstroCommand } from './astro-bin.js';
import { buildProblems, describeRefusedEntries } from './build-failure.js';
import { runGit } from './git-exec.js';

const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * The outcome of a check.
 * @typedef {Object} AstroCheckResult
 * @property {boolean} success
 * @property {string} commit - the SHA that was checked
 * @property {Array<{code: string|null, message: string}>} problems - why, in sentences we wrote
 *   (build-failure.js); empty on success. No text of the build's output.
 * @property {Array<import('./build-failure.js').RefusedEntry>} entries - the entries the build
 *   refused, each with AstroAdmin's own validation of it at the checked commit
 * @property {string} rawOutput - the command's raw output (or our failure's detail),
 *   for the server and tests ONLY: it names server paths, so no response may carry it
 */

// The admin's own secrets and settings, which the site's build has no use for.
const ADMIN_ENV_PATTERN = /^(ASTROADMIN_|ADMIN_|SESSION_SECRET$)/;

async function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

async function exists(target) {
  return (await realpathOrNull(target)) !== null;
}

/**
 * The directories under `dir` (itself included) that hold an .astro file
 * somewhere below them. Symbolic links are not followed.
 * @param {string} dir
 * @param {Set<string>} [found]
 * @returns {Set<string>}
 */
function directoriesHoldingAstroFiles(dir, found = new Set()) {
  let holds = false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (directoriesHoldingAstroFiles(entryPath, found).has(entryPath)) holds = true;
    } else if (entry.isFile() && entry.name.endsWith('.astro')) {
      holds = true;
    }
  }
  if (holds) found.add(dir);
  return found;
}

/**
 * Link `source` at `target`, except along the way to an .astro file, which is
 * copied into real directories (whose other entries are links again).
 * @param {string} source
 * @param {string} target
 * @param {Set<string>} astroDirectories - from directoriesHoldingAstroFiles
 */
function linkOrMirror(source, target, astroDirectories) {
  if (astroDirectories.has(source)) {
    fs.mkdirSync(target);
    for (const entry of fs.readdirSync(source)) {
      linkOrMirror(path.join(source, entry), path.join(target, entry), astroDirectories);
    }
  } else if (source.endsWith('.astro') && fs.lstatSync(source).isFile()) {
    fs.copyFileSync(source, target);
  } else {
    fs.symlinkSync(source, target);
  }
}

/**
 * Give one worktree directory a node_modules that links each package to the
 * live checkout's, so nothing is installed. Dot-directories other than .bin are
 * left out: Astro writes its data store to node_modules/.astro (its default
 * cacheDir) and Vite its caches beside it, and sharing them would let the check
 * overwrite the running preview's.
 *
 * A package's .astro files are COPIED (with real directories down to them, and
 * links for everything else in those directories), so they sit inside the
 * worktree (#89). Vite names a linked module by its real path, which would be
 * in the live checkout, outside the check's root. Astro keys a component's
 * compile metadata by that name but looks it up for the component's <style>
 * and <script> sub-modules through normalizeFilename, which joins an absolute
 * path sharing no directory with the root onto the root as if it were
 * root-relative; the lookup misses and the build fails ("No cached compile
 * metadata found"). Only .astro files are copied: the JavaScript stays linked,
 * so every package still has one instance.
 *
 * A package that is itself a link (pnpm: node_modules/<name> points into the
 * node_modules/.pnpm store) is followed to its real directory. One inside
 * this node_modules is mirrored at that real place, the store's dot-directory
 * included as far as needed, so its own dependencies beside it in the store
 * still resolve; the top-level link then points at the mirror.
 */
async function linkNodeModules(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const realSourceDir = fs.realpathSync(sourceDir);
  // Directories inside a skipped dot-directory (pnpm's .pnpm store) that are
  // mirrored all the same, because a package linked from the top level
  // ships .astro files there.
  const storeDirectories = new Set();

  const linkPackage = (source, target) => {
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      linkOrMirror(source, target, directoriesHoldingAstroFiles(source));
      return;
    }
    const real = stat.isSymbolicLink() ? realDirectoryOrNull(source) : null;
    const astroDirectories = real ? directoriesHoldingAstroFiles(real) : new Set();
    if (astroDirectories.size === 0) {
      fs.symlinkSync(source, target);
      return;
    }
    // A linked package with .astro files (pnpm, or a link to another
    // package). Inside this node_modules, the real directory is mirrored
    // where it is, so the package's own dependencies (pnpm puts them beside
    // it in the store) still resolve, and the top-level link points there.
    const inside = path.relative(realSourceDir, real);
    if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
      const [first] = inside.split(path.sep);
      if (first.startsWith('.')) {
        let ancestor = real;
        while (ancestor !== realSourceDir) {
          storeDirectories.add(ancestor);
          ancestor = path.dirname(ancestor);
        }
        for (const directory of astroDirectories) storeDirectories.add(directory);
      }
      fs.symlinkSync(path.join(targetDir, inside), target);
      return;
    }
    // Elsewhere: mirrored in the link's place.
    linkOrMirror(real, target, astroDirectories);
  };

  for (const entry of fs.readdirSync(sourceDir)) {
    if (entry.startsWith('.') && entry !== '.bin') continue;
    const source = path.join(sourceDir, entry);
    const target = path.join(targetDir, entry);
    const stat = fs.lstatSync(source);
    if (entry.startsWith('@') && stat.isDirectory()) {
      // A scope: its members are packages, linked or real, one by one.
      fs.mkdirSync(target);
      for (const member of fs.readdirSync(source)) linkPackage(path.join(source, member), path.join(target, member));
    } else {
      linkPackage(source, target);
    }
  }

  // Only the parts of a store that lead to .astro files are real directories
  // (everything else in them is linked); the rest of the store is not linked.
  for (const entry of fs.readdirSync(realSourceDir)) {
    const storeRoot = path.join(realSourceDir, entry);
    if (storeDirectories.has(storeRoot)) linkOrMirror(storeRoot, path.join(targetDir, entry), storeDirectories);
  }
}

/** The real path of a link to a directory, or null. */
function realDirectoryOrNull(link) {
  try {
    const real = fs.realpathSync(link);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * A package in node_modules that is a link back into the repository (a
 * workspace package) would resolve to the live checkout's UNCOMMITTED copy,
 * so the check would not be of the commit. Returns the first one found.
 */
async function findWorkspaceLink(nodeModulesDir, realRepoTop) {
  const candidates = [];
  for (const entry of fs.readdirSync(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const member of fs.readdirSync(path.join(nodeModulesDir, entry))) {
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
  for (const entry of fs.readdirSync(projectRoot)) {
    if (entry !== '.env' && !entry.startsWith('.env.')) continue;
    const target = path.join(siteDir, entry);
    if (await exists(target)) continue;
    fs.copyFileSync(path.join(projectRoot, entry), target);
  }
}

async function git(cwd, args) {
  const stdout = await runGit(cwd, args);
  return stdout.trim();
}

// How long a command's output pipes may stay open after its shell exited and
// its process group was killed: only a descendant that left the group can
// still hold them, and it is not waited for.
const EXITED_PIPE_GRACE_MS = 2000;

const isHighSurrogate = (text, index) => /[\uD800-\uDBFF]/.test(text.charAt(index));
const isLowSurrogate = (text, index) => /[\uDC00-\uDFFF]/.test(text.charAt(index));

/**
 * A command's output, capped at `maxLength` characters: the first half and
 * the last half are kept, with a line saying how much was left out between
 * them. The start says what ran; the end is where a build prints its error.
 * A cut never falls inside a surrogate pair (a character outside the BMP,
 * such as an emoji), so a kept part may be one character shorter.
 * Exported for tests.
 * @param {number} maxLength
 */
export function cappedOutput(maxLength) {
  const half = Math.floor(maxLength / 2);
  let head = '';
  let tail = '';
  let omitted = 0;
  // Set once anything has gone to the tail, so the head never takes text
  // that came after it (it may stop one short of `half`, for a pair).
  let headDone = false;
  return {
    add(chunk) {
      let text = String(chunk);
      if (!headDone) {
        let room = half - head.length;
        if (room < text.length && isHighSurrogate(text, room - 1)) room -= 1;
        head += text.slice(0, room);
        text = text.slice(room);
        if (text !== '') headDone = true;
      }
      if (text === '') return;
      tail += text;
      // Trimmed in batches, so a long log is not copied on every chunk.
      if (tail.length > 2 * half) {
        let cut = tail.length - half;
        if (isLowSurrogate(tail, cut)) cut += 1;
        omitted += cut;
        tail = tail.slice(cut);
      }
    },
    text() {
      let extra = Math.max(0, tail.length - half);
      if (extra > 0 && isLowSurrogate(tail, extra)) extra += 1;
      const left = omitted + extra;
      const kept = extra > 0 ? tail.slice(extra) : tail;
      return left > 0 ? `${head}\n[... ${left} characters of output left out ...]\n${kept}` : head + kept;
    },
  };
}

/**
 * Run a shell command in its own process group, and leave nothing of it
 * running. On timeout, kill the WHOLE group (the shell, astro and anything
 * they started) and settle at once: a descendant that left the group can keep
 * the output pipes open, and waiting for them to close would hold the git
 * lock forever. When the shell exits, kill the group too (a daemon the build
 * started would otherwise outlive it, and one holding the output pipe would
 * hold the build open until the timeout), then read what is left in the pipes
 * and settle when they close, or after EXITED_PIPE_GRACE_MS.
 * @param {(child: import('child_process').ChildProcess) => void} [onSpawn] - given the
 *   shell once started (its pid is the group's id): the doctor kills the group
 *   when it is interrupted
 * @returns {Promise<{exitCode: number|null, output: string, timedOut: boolean}>}
 */
export function runCommand(command, cwd, timeoutMs, env, onSpawn = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onSpawn && child.pid !== undefined) onSpawn(child);
    const output = cappedOutput(MAX_OUTPUT_BYTES);
    let settled = false;
    let exitCode = null;
    let graceTimer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(result);
    };
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // the group is already empty
      }
    };
    const stopReading = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    // Decoded per stream, so a character split between two writes (or two
    // reads) arrives whole rather than as two U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', output.add);
    child.stderr.on('data', output.add);

    const timer = setTimeout(() => {
      killGroup();
      stopReading();
      settle({ exitCode: null, output: output.text(), timedOut: true });
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (settled) return;
      exitCode = code;
      // The command is over. What it wrote is still in the pipes and is read
      // to the end; only writers left in the group are stopped.
      killGroup();
      graceTimer = setTimeout(() => {
        stopReading();
        settle({ exitCode, output: output.text(), timedOut: false });
      }, EXITED_PIPE_GRACE_MS);
    });
    child.on('close', (code) => settle({ exitCode: code ?? exitCode, output: output.text(), timedOut: false }));
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
function nodeModulesLevels(realRepoTop, siteSubdir) {
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
  const realRepoTop = fs.realpathSync(await git(projectRoot, ['rev-parse', '--show-toplevel']));
  const siteSubdir = path.relative(realRepoTop, fs.realpathSync(projectRoot));
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
 *   built), else the site's own installed astro (`astro build --outDir dist`, run
 *   from the worktree's node_modules, never fetched: when it is not installed the
 *   check refuses); `build.checkTimeoutMs` overrides the time limit.
 * @param {Object} [options]
 * @param {(build: {siteDir: string, commit: string, command: string}) => Promise<void>} [options.onBuilt] -
 *   called after a check that passed, while its worktree (and the build output
 *   in it) still exists. Errors it throws are logged and ignored: it can never
 *   fail the check. It must bound its own running time.
 * @returns {Promise<AstroCheckResult>}
 */
export async function checkHeadWithAstro(fullConfig, { onBuilt } = {}) {
  const projectRoot = fullConfig.paths.projectRoot;
  let command = fullConfig.build?.check || fullConfig.build?.production || null;
  const timeoutMs = fullConfig.build?.checkTimeoutMs || DEFAULT_CHECK_TIMEOUT_MS;
  let commit = '';
  let tempDir = null;
  let siteDirs = [];
  let checkSiteDir = null; // the site in the check's worktree: the commit's own content config

  // A refusal reaches the editor (publish.js checkRefusalBody), so it is
  // built from structured parts only (build-failure.js): the error codes in
  // the output as sentences we wrote, and the entries it refused with our
  // own validation of each. The output itself goes to the server log.
  const failBuild = async (output) => {
    console.error(`❌ Content check failed for ${commit.slice(0, 7) || 'HEAD'}. The build's output:\n${output}`);
    const entries = await describeRefusedEntries({ output, siteDirs, projectRoot, commit, fullConfig, checkSiteDir });
    return { success: false, commit, problems: buildProblems(output), entries, rawOutput: String(output) };
  };
  // A refusal of ours, in a sentence we wrote (logged with any detail).
  const fail = (message, detail = '') => {
    console.error(`❌ Content check failed for ${commit.slice(0, 7) || 'HEAD'}: ${message}${detail ? `\n${detail}` : ''}`);
    return { success: false, commit, problems: [{ code: null, message }], entries: [], rawOutput: detail };
  };

  try {
    commit = await git(projectRoot, ['rev-parse', 'HEAD']);
    // A site in a subdirectory of its repo (monorepo `subdir`) sits at the same
    // place inside the worktree.
    const { realRepoTop, siteSubdir } = await locateSite(projectRoot);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astroadmin-check-'));
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
    // Where the build names the commit's files (Location: lines), so a refused
    // file can be matched to its entry.
    siteDirs = [siteDir, path.join(await realpathOrNull(tempDir), 'worktree', siteSubdir)];
    checkSiteDir = siteDir;
    for (const { relativeDir, liveNodeModules } of nodeModulesLevels(realRepoTop, siteSubdir)) {
      if (!(await exists(liveNodeModules))) continue;
      const workspaceLink = await findWorkspaceLink(liveNodeModules, realRepoTop);
      if (workspaceLink) {
        return fail(`This site depends on a workspace package (${workspaceLink}) inside its own repository, which the publish check does not support, so nothing was pushed.`);
      }
      await linkNodeModules(liveNodeModules, path.join(worktreeDir, relativeDir, 'node_modules'));
    }
    await copyEnvFiles(projectRoot, siteDir);

    // The default: the astro the worktree's node_modules (links to the live
    // checkout's) resolve to. Never a package runner, which would fetch one.
    if (!command) {
      command = await defaultAstroCommand(siteDir, DEFAULT_BUILD_ARGS.production);
      if (!command) {
        return fail(`${ASTRO_NOT_INSTALLED_MESSAGE} The publish check cannot run without it, so nothing was pushed.`);
      }
    }

    console.log(`🔎 Checking ${commit.slice(0, 7)} with: ${command}`);
    const result = await runCommand(command, siteDir, timeoutMs, buildEnvironment());
    if (result.timedOut) {
      return fail(`The check did not finish within ${Math.max(1, Math.round(timeoutMs / 1000))} seconds, so nothing was pushed.`, result.output);
    }
    if (result.exitCode !== 0) {
      return await failBuild(result.output);
    }
    if (onBuilt) {
      try {
        await onBuilt({ siteDir, commit, command });
      } catch (error) {
        console.error('After-check hook failed (ignored):', error.message);
      }
    }
    console.log(`✅ Content check passed for ${commit.slice(0, 7)}`);
    return { success: true, commit, problems: [], entries: [], rawOutput: result.output };
  } catch (error) {
    // git or the file system, not the build: nothing in it is the editor's to fix.
    return fail('The publish check could not run, so nothing was pushed; see the server log.',
      `${error.stack || error.message}\n${error.stdout || ''}${error.stderr || ''}`);
  } finally {
    // Deleting the directory and pruning removes the worktree and git's record of it.
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best effort: the prune below still drops git's record of the worktree
      }
    }
    await git(projectRoot, ['worktree', 'prune']).catch(() => {});
  }
}
