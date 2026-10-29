/**
 * How the admin runs git: one environment rule for every git process, whether
 * it is spawned by simple-git (createGitClient in api/publish.js) or by the
 * small execFile helpers below (the publish check, the doctor, the build
 * failure reader, the astro finder).
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
  const { stdout } = await execFileAsync('git', args, {
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
  return execFileSync('git', args, {
    ...options,
    cwd,
    env: gitEnvironment(options.env ?? process.env),
  });
}
