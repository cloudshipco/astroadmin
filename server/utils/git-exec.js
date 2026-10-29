/**
 * How the admin runs git: one config and environment rule for every git
 * process, whether it is spawned by simple-git (createGitClient in
 * api/publish.js) or by the small execFile helpers below (the publish check,
 * the doctor, the build failure reader, the astro finder). Never spawn git
 * any other way.
 *
 * The config: HARDENING_CONFIG and filterDriverOverrides, so no code the
 * repository's config or hooks name runs (#67).
 *
 * The environment: of the ambient variables git reads (every GIT_* one), only
 * those an operator sets on purpose reach git (GIT_ENVIRONMENT). A hosted
 * editor (nixos/astroadmin-instance.nix) sets the deploy key's ssh command
 * and the commit identity; anything else (a GIT_DIR or GIT_WORK_TREE left in
 * a shell, a parent git hook's GIT_INDEX_FILE) would point the admin's git at
 * another repository or index. simple-git 4 applies the same rule through its
 * `allowEnvironment` option, and drops the rest itself.
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * The GIT_* variables passed to git, upper case.
 * - GIT_SSH_COMMAND: the hosted editor's deploy key, for pull and push.
 * - GIT_AUTHOR_* / GIT_COMMITTER_*: the hosted editor's commit identity.
 * - GIT_CONFIG_NOSYSTEM: only ever narrows where git reads config from.
 * @type {readonly string[]}
 */
export const GIT_ENVIRONMENT = Object.freeze([
  'GIT_SSH_COMMAND',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_NOSYSTEM',
]);

const ALLOWED = new Set(GIT_ENVIRONMENT);

/**
 * Config every admin git command runs with, as `-c` overrides (which outrank
 * the repository's own config). The site's code runs on this host (the
 * preview, the publish check's build, the content config import), so it can
 * write `.git/hooks/*` and `.git/config`; without these the admin's next git
 * command would run that code with the deploy key (#67).
 * - core.hooksPath=/dev/null: no hooks (pre-commit, post-checkout of the
 *   check's `worktree add`, post-merge, pre-push, reference-transaction...).
 * - core.fsmonitor=false: no fsmonitor command on status, add or checkout.
 * - commit.gpgSign=false: no gpg.program on commit.
 * - protocol.ext.allow=never: no `ext::` transport (a command) on pull/push.
 * Filter drivers have no global off switch: see filterDriverOverrides.
 * External diff and textconv programs are refused per command, with
 * NO_DIFF_PROGRAMS on every diff and show.
 * @type {readonly string[]}
 */
export const HARDENING_CONFIG = Object.freeze([
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'commit.gpgSign=false',
  'protocol.ext.allow=never',
]);

/** Options for every `git diff` / `git show`: no diff.external, no textconv. */
export const NO_DIFF_PROGRAMS = Object.freeze(['--no-ext-diff', '--no-textconv']);

/**
 * The simple-git 4 opt-ins that let HARDENING_CONFIG and the filter
 * overrides through its argument guard (it refuses any `-c` naming these
 * keys, whatever the value, unless allowed).
 */
export const SIMPLE_GIT_UNSAFE = Object.freeze({
  allowUnsafeHooksPath: true,
  allowUnsafeFsMonitor: true,
  allowUnsafeProtocolOverride: true,
  allowUnsafeFilter: true,
});

/**
 * Overrides that switch off every filter driver configured for the
 * repository in any scope (`filter.<name>.*`: smudge on checkout, clean on
 * add and status, a long-running process): empty commands, which git treats
 * as no filter, and required=false, so a disabled driver is not an error.
 * Files then go in and out of git byte for byte.
 *
 * A Git LFS site keeps working for plain files. LFS-tracked files are the
 * cost: a NEW one is committed as its real bytes, not a pointer (LFS's
 * pre-push upload is a hook, off as well, so a pointer would reach the
 * remote with no object behind it), and the publish check's worktree holds
 * the pointer text of existing ones.
 *
 * Read fresh for each git client or command, since site code can add a
 * driver at any time.
 * @param {string} cwd
 * @returns {string[]}
 */
export function filterDriverOverrides(cwd) {
  let output = '';
  try {
    output = execFileSync('git', [
      ...configArgs(HARDENING_CONFIG), 'config', '--null', '--name-only', '--get-regexp', '^filter\\.',
    ], { cwd, env: gitEnvironment(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // exit 1: no filter configured (or not a repository)
  }
  const names = new Set();
  for (const key of output.split('\0')) {
    // filter.<name>.<variable>; the name can itself contain dots.
    const match = /^filter\.(.+)\.[^.]+$/s.exec(key);
    if (!match) continue;
    // `-c` splits at the first '=', so such a name cannot be overridden:
    // refuse to run git at all rather than run it with the driver live.
    if (match[1].includes('=')) {
      throw new Error('A git filter driver in this repository has a name that cannot be disabled; refusing to run git.');
    }
    names.add(match[1]);
  }
  return [...names].flatMap((name) => [
    `filter.${name}.smudge=`,
    `filter.${name}.clean=`,
    `filter.${name}.process=`,
    `filter.${name}.required=false`,
  ]);
}

/** HARDENING_CONFIG plus the repository's filter overrides, as `key=value`. */
export function hardenedConfig(cwd) {
  return [...HARDENING_CONFIG, ...filterDriverOverrides(cwd)];
}

function configArgs(entries) {
  return entries.flatMap((entry) => ['-c', entry]);
}

/**
 * `env` without the GIT_* variables git must not see (see GIT_ENVIRONMENT).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnvironment(env = process.env) {
  const filtered = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') && !ALLOWED.has(upper)) continue;
    filtered[key] = value;
  }
  return filtered;
}

/**
 * Run git in `cwd` and return its stdout. Options are execFile's; `env`
 * defaults to the process environment and is filtered either way.
 * @param {string} cwd
 * @param {string[]} args
 * @param {import('child_process').ExecFileOptions} [options]
 * @returns {Promise<string>}
 */
export async function runGit(cwd, args, options = {}) {
  const { stdout } = await execFileAsync('git', [...configArgs(hardenedConfig(cwd)), ...args], {
    ...options,
    cwd,
    env: gitEnvironment(options.env ?? process.env),
  });
  return stdout;
}

/**
 * runGit, synchronously (the doctor and the publish check read with *Sync
 * calls: see CLAUDE.md on fs/promises under Bun). Returns a Buffer unless an
 * `encoding` is given.
 * @param {string} cwd
 * @param {string[]} args
 * @param {import('child_process').ExecFileSyncOptions} [options]
 */
export function runGitSync(cwd, args, options = {}) {
  return execFileSync('git', [...configArgs(hardenedConfig(cwd)), ...args], {
    ...options,
    cwd,
    env: gitEnvironment(options.env ?? process.env),
  });
}
