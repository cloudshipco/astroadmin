/**
 * How the admin runs git: one config and environment rule for every git
 * process, whether it is spawned by simple-git (createGitClient in
 * api/publish.js) or by the small execFile helpers below (the publish check,
 * the doctor, the build failure reader, the astro finder). Never spawn git
 * any other way.
 *
 * The config: HARDENING_CONFIG and namedCommandOverrides, so no code the
 * repository's config or hooks name runs (#67).
 *
 * The environment (gitEnvironment): of the ambient variables git reads
 * (every GIT_* one), only those an operator sets on purpose reach git
 * (GIT_ENVIRONMENT), and GIT_TERMINAL_PROMPT is always 0. A hosted editor
 * (nixos/astroadmin-instance.nix) sets the deploy key's ssh command and the
 * commit identity; anything else (a GIT_DIR or GIT_WORK_TREE left in a
 * shell, a parent git hook's GIT_INDEX_FILE) would point the admin's git at
 * another repository or index. simple-git clients are given the same
 * environment explicitly, and its `allowEnvironment` guard lets exactly
 * those variables through.
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * The GIT_* variables passed to git from the admin's environment, upper case.
 * - GIT_SSH_COMMAND: the hosted editor's deploy key, for fetch and push. The
 *   one way to choose an ssh command: the repository's core.sshCommand is
 *   overridden, and GIT_SSH is not passed (core.sshCommand outranks it).
 * - GIT_ASKPASS: a program that answers HTTPS credential prompts. The one way
 *   to give an HTTPS remote credentials: every credential.helper is cleared,
 *   since a helper is a command the repository's config can name.
 * - GIT_SSL_CAINFO / GIT_SSL_CAPATH: certificates to trust for an HTTPS
 *   remote behind a private CA. (Proxy variables such as HTTPS_PROXY are not
 *   GIT_* and pass as they are.)
 * - GIT_PROXY_COMMAND: a git:// proxy. Unset, it is passed EMPTY, which makes
 *   git ignore core.gitProxy (first match wins there, so `-c` cannot).
 * - GIT_AUTHOR_* / GIT_COMMITTER_*: the hosted editor's commit identity.
 * - GIT_CONFIG_NOSYSTEM: only ever narrows where git reads config from.
 * GIT_TERMINAL_PROMPT is always 0 (FORCED_ENVIRONMENT).
 * @type {readonly string[]}
 */
export const GIT_ENVIRONMENT = Object.freeze([
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'GIT_PROXY_COMMAND',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_NOSYSTEM',
]);

/**
 * Set for every git command whatever the environment says. A credential
 * prompt with no answer must fail, not wait on a terminal while Publish holds
 * the checkout lock.
 */
const FORCED_ENVIRONMENT = Object.freeze({ GIT_TERMINAL_PROMPT: '0' });

/** Defaults for GIT_ENVIRONMENT variables the operator has not set. */
const DEFAULT_ENVIRONMENT = Object.freeze({ GIT_PROXY_COMMAND: '' });

/**
 * Variables git (or simple-git's guard) treats as commands, that are not
 * GIT_*: an interactive editor or pager, or an askpass for ssh. Never needed
 * by the admin's non-interactive git, so never passed.
 */
const DROPPED_ENVIRONMENT = Object.freeze(['EDITOR', 'VISUAL', 'PAGER', 'SSH_ASKPASS', 'PREFIX']);

/** Every GIT_* variable git may see: GIT_ENVIRONMENT and the forced ones. */
export const GIT_PASSED_ENVIRONMENT = Object.freeze([...GIT_ENVIRONMENT, ...Object.keys(FORCED_ENVIRONMENT)]);

const ALLOWED = new Set(GIT_ENVIRONMENT);
const DROPPED = new Set(DROPPED_ENVIRONMENT);

/**
 * Config every admin git command runs with, as `-c` overrides (which outrank
 * the repository's own config). The site's code runs on this host (the
 * preview, the publish check's build, the content config import), so it can
 * write `.git/hooks/*` and `.git/config`; without these the admin's next git
 * command would run that code with the deploy key (#67).
 * - core.hooksPath=/dev/null: no hooks (pre-commit, post-checkout of the
 *   check's `worktree add`, post-merge, pre-push, reference-transaction...).
 * - core.fsmonitor=false: no fsmonitor command on status, add or checkout.
 * - commit.gpgSign=false, push.gpgSign=false: nothing is signed.
 * - log.showSignature=false: `git log` (the history routes) does not verify
 *   a signed commit's signature, which runs the signature program.
 * - gpg.program=false and gpg.<format>.program=false (openpgp, x509, ssh):
 *   any signing or verifying left (a `%G?` format, `--show-signature`) runs
 *   `false`, never a program the repository names.
 * - core.alternateRefsCommand=true: with `objects/info/alternates`, a fetch
 *   runs this to list the other object store's refs; `true` lists none (an
 *   empty value is run as a command and fails noisily).
 * - protocol.ext.allow=never: no `ext::` transport (a command) on fetch/push.
 * - core.sshCommand=ssh: plain ssh, not a command the repository names.
 *   GIT_SSH_COMMAND still outranks it. (An empty value is not "unset": git
 *   runs the empty command and the transport fails.)
 * - credential.helper= (empty clears the list): no helper command for an
 *   HTTPS remote; core.askPass= (empty is "none"): no askpass program from
 *   config. GIT_ASKPASS is the operator's way to supply credentials.
 * Drivers named per repository (filters, merge drivers) have no global off
 * switch: see namedCommandOverrides. Some keys cannot be overridden by `-c`
 * at all, since git keeps the first value it reads: core.gitProxy (an empty
 * GIT_PROXY_COMMAND switches it off, see GIT_ENVIRONMENT) and a remote's
 * uploadpack/receivepack (FETCH_PROGRAMS and PUSH_PROGRAMS on every fetch
 * and push). External diff and textconv programs are refused per command,
 * with NO_DIFF_PROGRAMS on every diff and show.
 * @type {readonly string[]}
 */
export const HARDENING_CONFIG = Object.freeze([
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'commit.gpgSign=false',
  'push.gpgSign=false',
  'log.showSignature=false',
  'gpg.program=false',
  'gpg.openpgp.program=false',
  'gpg.x509.program=false',
  'gpg.ssh.program=false',
  'core.alternateRefsCommand=true',
  'protocol.ext.allow=never',
  'core.sshCommand=ssh',
  'credential.helper=',
  'core.askPass=',
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
  allowUnsafeSshCommand: true,
  allowUnsafeCredentialHelper: true,
  allowUnsafeAskPass: true,
  allowUnsafeMergeDriver: true,
  allowUnsafePack: true,
  allowUnsafeGitProxy: true,
  allowUnsafeGpgProgram: true,
});

/**
 * The built-in three-way text merge, as a merge driver command: `git
 * merge-file` from the admin's PATH, on the temporary files git names.
 */
const TEXT_MERGE_DRIVER = 'git merge-file --marker-size=%L %A %O %B';

/**
 * Config keys whose name part the repository chooses, each naming a command,
 * and the overrides that neutralise one name. The name can itself contain
 * dots, so it is everything between the section and the last dot.
 * - filter.<name>.*: smudge on checkout, clean on add and status, a
 *   long-running process. Emptied (git treats an empty command as no filter)
 *   and required=false, so a disabled driver is not an error: files go in
 *   and out of git byte for byte. A repository whose attributes USE a
 *   configured filter, or Git LFS's, is refused for publishing
 *   (filter-attributes.js), since those bytes are not what git would store.
 * - merge.<name>.driver: run for a file both sides changed (the publish
 *   rebase). Replaced with git's own text merge: an empty driver is not
 *   "none" but a command that fails, which would turn every such merge into
 *   a conflict. A legitimate driver (a lockfile merger, say) can then
 *   conflict where it would not have, which is refused as a conflict.
 * (A remote's pack programs are per command: FETCH_PROGRAMS, PUSH_PROGRAMS.)
 */
const NAMED_COMMANDS = Object.freeze([
  {
    section: 'filter',
    pattern: /^filter\.(.+)\.[^.]+$/s,
    overrides: (name) => [`filter.${name}.smudge=`, `filter.${name}.clean=`, `filter.${name}.process=`, `filter.${name}.required=false`],
  },
  {
    section: 'merge',
    pattern: /^merge\.(.+)\.driver$/s,
    overrides: (name) => [`merge.${name}.driver=${TEXT_MERGE_DRIVER}`],
  },
]);

/**
 * Options for every `git fetch` / `git push`: git's own pack programs.
 * remote.<name>.uploadpack and receivepack name the program run (through a
 * shell, on this host for a local-path remote) and cannot be overridden with
 * `-c`, since git keeps the FIRST value it reads; a command-line option
 * outranks them.
 */
export const FETCH_PROGRAMS = Object.freeze(['--upload-pack=git-upload-pack']);
export const PUSH_PROGRAMS = Object.freeze(['--receive-pack=git-receive-pack']);

/**
 * Overrides for every named command (NAMED_COMMANDS) configured for the
 * repository in any scope. Read fresh for each git client or command, since
 * site code can add one at any time.
 * @param {string} cwd
 * @returns {string[]}
 */
export function namedCommandOverrides(cwd) {
  let output = '';
  try {
    output = execFileSync('git', [
      ...configArgs(HARDENING_CONFIG), 'config', '--null', '--name-only', '--get-regexp',
      `^(${NAMED_COMMANDS.map(({ section }) => section).join('|')})\\.`,
    ], { cwd, env: gitEnvironment(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // exit 1: none configured (or not a repository)
  }
  const overrides = new Set();
  for (const key of output.split('\0')) {
    for (const { pattern, overrides: overridesFor } of NAMED_COMMANDS) {
      const match = pattern.exec(key);
      if (!match) continue;
      // `-c` splits at the first '=', so such a name cannot be overridden:
      // refuse to run git at all rather than run it with the command live.
      if (match[1].includes('=')) {
        throw new Error('A git driver or remote in this repository has a name that cannot be overridden; refusing to run git.');
      }
      for (const override of overridesFor(match[1])) overrides.add(override);
    }
  }
  return [...overrides];
}

/** HARDENING_CONFIG plus the repository's named-command overrides, as `key=value`. */
export function hardenedConfig(cwd) {
  return [...HARDENING_CONFIG, ...namedCommandOverrides(cwd)];
}

function configArgs(entries) {
  return entries.flatMap((entry) => ['-c', entry]);
}

/**
 * `env` as git gets it: without the GIT_* variables git must not see (see
 * GIT_ENVIRONMENT) or DROPPED_ENVIRONMENT, with DEFAULT_ENVIRONMENT filling
 * in and FORCED_ENVIRONMENT on top.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnvironment(env = process.env) {
  const filtered = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') && !ALLOWED.has(upper)) continue;
    if (DROPPED.has(upper)) continue;
    filtered[key] = value;
  }
  for (const [key, value] of Object.entries(DEFAULT_ENVIRONMENT)) {
    if (filtered[key] === undefined) filtered[key] = value;
  }
  return { ...filtered, ...FORCED_ENVIRONMENT };
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
