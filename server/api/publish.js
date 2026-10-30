/**
 * Publish API Router
 *
 * Publishing is build + deploy, with git as an OPTIONAL pre-step. When git is
 * enabled we stage the configured paths (config.git.paths — src/content plus
 * assets in files mode, assets only in db mode), and never the binary content
 * DB unless config.git.includeDb.
 *
 * Pipeline: [git commit/rebase/check/push if enabled] -> build -> deploy (if adapter).
 *
 * Mounted at /api/publish. The handler is also re-exported and aliased at
 * /api/git/publish (git.js) for backwards compatibility when git is enabled.
 */

import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { simpleGit } from 'simple-git';
import { recordDoctorAfterCheck } from '../doctor/editor.js';
import { getConfig } from '../config.js';
import { deploy, validateDeployConfig } from '../utils/deploy.js';
import { runProductionBuild } from '../utils/build.js';
import { checkHeadWithAstro } from '../utils/astro-check.js';
import { listSlugs } from '../utils/content.js';
// Shared with the editor's "View live site" link (ui/ is served to the browser).
import { resolveLiveUrl } from '../../ui/live-url.js';
import { buildProblems } from '../utils/build-failure.js';
import { withCheckoutExclusive } from '../utils/checkout-lock.js';
import { filterDriverInUse } from '../utils/filter-attributes.js';
import { getAllowedGitPaths } from '../utils/git-paths.js';
import { FETCH_PROGRAMS, GIT_PASSED_ENVIRONMENT, NO_DIFF_PROGRAMS, PUSH_PROGRAMS, SIMPLE_GIT_UNSAFE, gitEnvironment, hardenedConfig } from '../utils/git-exec.js';

const router = express.Router();
// (Helpers are exported for reuse by api/git.js — keep one definition.)

/**
 * Every simple-git client the admin uses, with the rules the execFile
 * helpers share (utils/git-exec.js): the hardening `-c` overrides, so no
 * hook, fsmonitor, filter, merge driver, ssh command, credential helper,
 * pack program, gpg or ext:: command the repository names runs (#67), with
 * the simple-git opt-ins that let them through its argument guard; and the
 * environment gitEnvironment() makes (only GIT_ENVIRONMENT's ambient GIT_*
 * variables, GIT_TERMINAL_PROMPT=0). The named-command overrides are read
 * when the client is made, so make a client per request, not one for the
 * process.
 */
export function createGitClient(fullConfig) {
  return gitClientAt(fullConfig.paths.projectRoot, { allowLocalRemote: fullConfig.git?.allowLocalRemote === true });
}

/**
 * A client rooted at `dir` with the same rules. A command for another
 * working tree of the repository (the rebase's throwaway worktree) gets its
 * own client: simple-git refuses `-C` without an unsafe opt-in.
 */
function gitClientAt(dir, { allowLocalRemote = false } = {}) {
  return simpleGit(dir, {
    config: hardenedConfig(dir, { allowLocalRemote }),
    unsafe: { ...SIMPLE_GIT_UNSAFE },
    allowEnvironment: [...GIT_PASSED_ENVIRONMENT],
  }).env(gitEnvironment());
}

async function getStagedFilesForPaths(git, gitPaths) {
  if (gitPaths.length === 0) return [];

  const diffOutput = await git.diff([...NO_DIFF_PROGRAMS, '--name-only', '--cached', '--', ...gitPaths]);
  return diffOutput.split(/\r?\n/).filter(Boolean);
}

async function stageGitPaths(git, gitPaths) {
  const stagedPaths = [];

  for (const gitPath of gitPaths) {
    // A path with nothing on disk and nothing in the index (a default such as
    // src/styles/ in a site without one) matches no pathspec: skip it rather
    // than log git's refusal on every publish. A folder whose tracked files
    // were all deleted is still in the index, so its deletion is staged.
    const matches = await git.raw(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', gitPath]);
    if (!matches) continue;
    try {
      await git.add(['-A', '--', gitPath]);
      stagedPaths.push(gitPath);
    } catch (error) {
      // A configured path may not exist in every project — non-fatal.
      console.log('Staging note:', error.message);
    }
  }

  return stagedPaths;
}

// Publishes and commits run one at a time, so the commit that was checked is
// the commit that gets pushed (a second publish can't commit in between).
let gitQueue = Promise.resolve();

/** Run a task that commits and/or pushes, after any such task already running. */
export function withGitLock(task) {
  const run = gitQueue.then(task, task);
  gitQueue = run.catch(() => {});
  return run;
}

/**
 * Commit, rebase onto the upstream, then push HEAD only if the site's own
 * Astro accepts its content (see utils/astro-check.js). Every route that
 * pushes goes through here.
 *
 * `commit` (optional) stages and commits, returning git's commit result or
 * null when there was nothing to commit; with `onlyIfCommitted`, nothing is
 * rebased, checked or pushed after a null. The commit and the rebase run in
 * ONE exclusive checkout hold (commitInCheckout): the editor's saves are
 * unstaged edits until committed (#57), so saves wait rather than land in
 * between or while the checkout moves. The rebase itself runs in a throwaway
 * worktree and the checkout is then moved to it (rebaseOntoUpstream), so
 * someone's uncommitted changes elsewhere in the repository do not stop it
 * (#83). The check runs after that, outside the hold (it builds in its own
 * worktree), so the combined result is what is checked and pushed. A failed
 * check leaves the commit local and unpushed.
 *
 * Outcomes besides the check: `blocked` when the checkout already holds an
 * unfinished rebase or merge (nothing staged or committed; left as it was),
 * or, with `blockedReason: 'submodules'`, when the checkout has a submodule,
 * or `'filter'`, when the repository's files go through a git filter driver
 * such as Git LFS (filter-attributes.js);
 * `conflict` when OUR rebase conflicted (it is aborted; the commit stays
 * local); `localChanges` when the incoming changes touch files with
 * uncommitted changes in the checkout (nothing moved; the commit stays
 * local); `pushError` when there IS somewhere to push and the push failed (a
 * site with no upstream simply is not pushed, which is not an error).
 * `commitResult.commit` is the commit's hash after the rebase.
 * @param {object} fullConfig
 * @param {import('simple-git').SimpleGit} git
 * @param {{commit?: () => Promise<object|null>, onlyIfCommitted?: boolean}} [options]
 * @returns {Promise<{blocked: boolean, blockedReason: 'submodules'|'filter'|null, conflict: boolean, localChanges: boolean, commitResult: object|null, pushed: boolean, pushError: string|null, check: import('../utils/astro-check.js').AstroCheckResult|null}>}
 */
export async function pushIfAstroAccepts(fullConfig, git, { commit = null, onlyIfCommitted = false } = {}) {
  const outcome = { blocked: false, blockedReason: null, conflict: false, localChanges: false, commitResult: null, pushed: false, pushError: null, check: null };
  const prepared = await commitInCheckout(git, commit, {
    rebase: (commitResult) => !(onlyIfCommitted && !commitResult),
  });
  outcome.blocked = prepared.blocked;
  outcome.blockedReason = prepared.blockedReason;
  outcome.conflict = prepared.conflict;
  outcome.localChanges = prepared.localChanges;
  outcome.commitResult = prepared.commitResult;
  if (!prepared.ready) return outcome;
  const { upstream } = prepared;

  // The check's build is reused for the doctor's click-to-edit scan (capped,
  // never fails the publish), so the editor can show coverage without a build.
  const check = await checkHeadWithAstro(fullConfig, { onBuilt: (build) => recordDoctorAfterCheck(fullConfig, build) });
  outcome.check = check;
  // The rebase replays the commit with a new hash; report the one checked.
  if (outcome.commitResult) outcome.commitResult = { ...outcome.commitResult, commit: check.commit };
  if (!check.success) return outcome;

  if (!upstream) {
    console.log('Push skipped: no upstream branch configured');
    return outcome;
  }

  try {
    await pushCheckedCommit(git, check.commit, upstream);
    console.log('✅ Pushed to remote');
    outcome.pushed = true;
  } catch (pushError) {
    console.error('Push failed:', pushError.message);
    if (/transport 'file' not allowed/.test(pushError.message)) {
      console.error('The remote is a local path or file:// URL, which the admin does not push to unless the site\'s config sets git.allowLocalRemote: true');
    }
    outcome.pushError = pushError.message;
  }
  return outcome;
}

/**
 * In one exclusive checkout hold: refuse a checkout with a submodule, an
 * unfinished git operation or a repository whose files go through a git
 * filter, commit
 * (when `commit` is given) and, when `rebase(commitResult)` says so, rebase
 * onto the upstream. `ready` means go on to check and push. Also the commit
 * route's path when it does not push.
 * @returns {Promise<{blocked: boolean, blockedReason: 'submodules'|'filter'|null, conflict: boolean, localChanges: boolean, ready: boolean, commitResult: object|null, upstream: {remote: string, ref: string}|null}>}
 */
export function commitInCheckout(git, commit, { rebase = () => false } = {}) {
  return withCheckoutExclusive(async () => {
    const prepared = { blocked: false, blockedReason: null, conflict: false, localChanges: false, ready: false, commitResult: null, upstream: null };
    // First, before any git command that could look inside one: a
    // submodule is its own repository, with its own config and hooks, and
    // `git add` runs its filters. (The publish check refuses gitlinks too.)
    const submodules = await gitlinksInIndex(git);
    if (submodules.length > 0) {
      console.error(`Publish refused: the checkout has git submodules (${submodules.join(', ')})`);
      prepared.blocked = true;
      prepared.blockedReason = 'submodules';
      return prepared;
    }
    const unfinished = await unfinishedOperation(git);
    if (unfinished) {
      // Someone else's (an interrupted publish, or a person on the box): not
      // ours to finish or abort. Aborting it would reset to ITS starting point.
      console.error(`Publish refused: the checkout has an unfinished git operation (${unfinished})`);
      prepared.blocked = true;
      return prepared;
    }
    // The checkout's view of the config, and a linked worktree's (an
    // includeIf on the git directory can configure a filter, or the
    // attributes using one, for worktrees only, and the rebase and the
    // check run in worktrees).
    if (await filterDriverInUse(git) || await inLinkedWorktreeView(git, filterDriverInUse)) {
      // Logged with the driver's name; the editor gets a fixed sentence.
      prepared.blocked = true;
      prepared.blockedReason = 'filter';
      return prepared;
    }
    if (commit) prepared.commitResult = await commit();
    if (!rebase(prepared.commitResult)) return prepared;
    prepared.upstream = await findUpstream(git);
    const synced = prepared.upstream ? await rebaseOntoUpstream(git, prepared.upstream) : 'synced';
    if (synced === 'conflict') {
      prepared.conflict = true;
      return prepared;
    }
    if (synced === 'local-changes') {
      prepared.localChanges = true;
      return prepared;
    }
    prepared.ready = true;
    return prepared;
  });
}

/**
 * Run `task` with a client in a throwaway linked worktree of HEAD whose
 * index holds HEAD's tree but whose working tree is empty: nothing is
 * checked out, so no filter runs, yet git reads config (and attributes,
 * from the index) as a linked worktree does. Null for an unborn branch.
 * @template T
 * @param {import('simple-git').SimpleGit} git
 * @param {(client: import('simple-git').SimpleGit) => Promise<T>} task
 * @returns {Promise<T|null>}
 */
async function inLinkedWorktreeView(git, task) {
  const head = (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim();
  if (!head) return null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astroadmin-view-'));
  const worktreeDir = path.join(tempDir, 'worktree');
  try {
    await git.raw(['worktree', 'add', '--quiet', '--no-checkout', '--detach', worktreeDir, head]);
    const worktreeGit = gitClientAt(worktreeDir);
    await worktreeGit.raw(['read-tree', head]);
    return await task(worktreeGit);
  } finally {
    await git.raw(['worktree', 'remove', '--force', worktreeDir]).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
    await git.raw(['worktree', 'prune']).catch(() => {});
  }
}

/** The paths of the gitlinks (submodules) in the checkout's index. */
async function gitlinksInIndex(git) {
  const entries = (await git.raw(['ls-files', '-z', '--stage'])).split('\0').filter(Boolean);
  return entries.filter((entry) => entry.startsWith('160000 ')).map((entry) => entry.slice(entry.indexOf('\t') + 1));
}

/**
 * The unfinished operation in the checkout, or null: a rebase (stopped, or
 * interrupted with HEAD still on the branch), a merge, a cherry-pick or
 * revert, or unmerged index entries.
 */
async function unfinishedOperation(git) {
  for (const name of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (fs.existsSync(await gitPath(git, name))) return name;
  }
  return (await git.raw(['ls-files', '--unmerged'])).trim() ? 'unmerged files' : null;
}

/** A path inside the git directory, absolute (relative output would be relative to the site). */
async function gitPath(git, name) {
  return (await git.raw(['rev-parse', '--path-format=absolute', '--git-path', name])).trim();
}

/**
 * Bring the checkout's branch onto its upstream: fetch the upstream branch,
 * rebase the local commits onto it in a THROWAWAY worktree, then move the
 * live checkout to the result with `git reset --keep`.
 *
 * `git pull --rebase` in the live checkout refused whenever ANY file had an
 * unstaged change (a hand edit of README.md outside the site, or of the
 * site's package.json outside git.paths), so a publish onto a remote that had
 * moved on was always rejected at the push (#83). In the worktree nothing is
 * modified, and `reset --keep` carries such changes across: it updates only
 * the files that differ between the two commits, and refuses, changing
 * nothing, when one of those has a local change or an untracked file is in
 * the way. Unlike a hard reset or a checkout it cannot clobber local work.
 *
 * Returns 'synced' (also when there was nothing to bring in), 'conflict' when
 * the rebase stopped (aborted in the worktree; the live checkout was never
 * touched, so it is on its branch with the local commits intact), or
 * 'local-changes' when the incoming changes touch files with uncommitted
 * changes in the checkout (nothing moved; the commit stays local). A fetch
 * that fails (an unreachable remote, a branch not on the remote yet) is
 * logged and the publish goes on: if the remote has moved, the push is then
 * rejected and reported. Runs inside the exclusive checkout hold, so no save
 * lands while the checkout moves.
 * @param {import('simple-git').SimpleGit} git
 * @param {{remote: string, ref: string}} upstream
 * @returns {Promise<'synced'|'conflict'|'local-changes'>}
 */
async function rebaseOntoUpstream(git, upstream) {
  const localHead = (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim();
  if (!localHead) return 'synced'; // an unborn branch has nothing to rebase
  // What the upstream was known to be BEFORE this fetch moves anything.
  const knownBefore = await knownUpstreamValues(git, upstream);
  let upstreamHead;
  try {
    await git.raw(['fetch', ...FETCH_PROGRAMS, '--no-tags', '--quiet', upstream.remote, upstream.ref]);
    upstreamHead = (await git.raw(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
  } catch (fetchError) {
    console.log('Fetch skipped:', fetchError.message);
    return 'synced';
  }
  await recordUpstream(git, upstream, upstreamHead);
  if (await isAncestor(git, upstreamHead, localHead)) return 'synced';

  // `reset --keep` resets the index. A file staged as one version and
  // changed since (not the editor's: its commit names its own paths) would
  // lose the staged version, so that is refused like any other local change
  // in the way. A wholly staged file only becomes unstaged: its text is in
  // the working tree, which is kept.
  const partlyStaged = await partlyStagedFiles(git);
  if (partlyStaged.length > 0) {
    console.error('Publish refused: files are staged and changed since, outside what the editor commits:', partlyStaged.join(', '));
    return 'local-changes';
  }

  const rebased = await rebaseInWorktree(git, localHead, upstreamHead, await lastKnownBase(git, localHead, knownBefore));
  if (rebased === null) return 'conflict';

  // The exclusive hold keeps the editor out; this keeps a person's commit
  // made meanwhile from being reset away.
  const headNow = (await git.raw(['rev-parse', 'HEAD'])).trim();
  if (headNow !== localHead) throw new Error(`HEAD moved from ${localHead} to ${headNow} during the rebase`);
  try {
    await git.raw(['reset', '--quiet', '--keep', rebased]);
  } catch (resetError) {
    console.error('Publish refused: uncommitted changes in the checkout are in files the upstream changes:', resetError.message);
    return 'local-changes';
  }
  console.log('✅ Rebased onto the latest changes');
  return 'synced';
}

/** Files whose staged version differs from both HEAD and the working tree. */
async function partlyStagedFiles(git) {
  const names = async (args) => new Set((await git.raw(['diff', ...NO_DIFF_PROGRAMS, '--name-only', '-z', '--no-renames', ...args])).split('\0').filter(Boolean));
  const staged = await names(['--cached', 'HEAD']);
  if (staged.size === 0) return [];
  const changedSince = await names([]);
  return [...staged].filter((file) => changedSince.has(file));
}

/**
 * Whether `ancestor` is reachable from `descendant`. Not `merge-base
 * --is-ancestor`: it answers by exit code alone, and simple-git does not
 * reject a failing command that printed nothing to stderr, so it read as
 * true every time.
 */
async function isAncestor(git, ancestor, descendant) {
  const mergeBase = (await git.raw(['merge-base', ancestor, descendant]).catch(() => '')).trim();
  return mergeBase === ancestor;
}

/**
 * Where the admin records the last value it saw the upstream branch have
 * (fetched, or pushed by it): one ref per remote and branch, named by a
 * digest since the remote can be a URL.
 * @param {{remote: string, ref: string}} upstream
 */
function upstreamRecordRef(upstream) {
  const digest = crypto.createHash('sha256').update(`${upstream.remote}\0${upstream.ref}`).digest('hex').slice(0, 32);
  return `refs/astroadmin/upstream/${digest}`;
}

/** Record that the upstream branch was seen at `commit`. Best effort. */
async function recordUpstream(git, upstream, commit) {
  await git.raw(['update-ref', '--no-deref', upstreamRecordRef(upstream), commit])
    .catch((error) => console.log('Could not record the upstream commit:', error.message));
}

/**
 * Commits the upstream branch is known to have pointed at, read before a
 * fetch: the admin's own record (upstreamRecordRef, kept whatever the
 * remote's configuration) and the branch's remote-tracking ref, when it has
 * one (a person's `git fetch` or `git pull` moves it).
 * @returns {Promise<string[]>}
 */
async function knownUpstreamValues(git, upstream) {
  const values = [];
  const resolve = async (name) => (await git.raw(['rev-parse', '--verify', '--quiet', `${name}^{commit}`]).catch(() => '')).trim();
  const recorded = await resolve(upstreamRecordRef(upstream));
  if (recorded) values.push(recorded);
  const trackingRef = (await git.raw(['rev-parse', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim();
  if (trackingRef.startsWith('refs/')) {
    const tracking = await resolve(trackingRef);
    if (tracking) values.push(tracking);
  }
  return values;
}

/**
 * Of the known upstream values, the newest that `localHead` contains, or
 * null. The commits after it are the checkout's own; those before it were
 * the upstream's, so one the upstream has since dropped (a force-push) is
 * not replayed and pushed back. (A value `localHead` does not contain says
 * nothing about it and is skipped.) Null means nothing is known, and the
 * rebase falls back to the merge-base.
 * @param {string[]} candidates
 * @returns {Promise<string|null>}
 */
async function lastKnownBase(git, localHead, candidates) {
  let newest = null;
  for (const candidate of candidates) {
    if (!(await isAncestor(git, candidate, localHead))) continue;
    if (newest === null || await isAncestor(git, newest, candidate)) newest = candidate;
  }
  return newest;
}

/**
 * Rebase `localHead` onto `upstreamHead` in a throwaway detached worktree.
 * Returns the rebased commit, or null when the rebase stopped on a conflict
 * (after aborting it). The worktree is removed either way.
 *
 * With a `base` (lastKnownBase: an upstream commit `localHead` contains) the
 * commits replayed are those after it (`rebase --onto upstreamHead base`),
 * so a commit that was pushed and then force-pushed away upstream is dropped,
 * not replayed and pushed back. `git pull --rebase` did this with the
 * tracking ref's reflog (--fork-point), which a URL remote, a fetch refspec
 * that does not map the branch or a missing reflog left without one. With no
 * base, the rebase is onto `upstreamHead` from the merge-base.
 *
 * `--no-autostash` and `--no-update-refs` override inherited config: the
 * worktree has nothing to stash, and update-refs would move the live
 * checkout's branch (it points at `localHead`) without its files.
 */
export async function rebaseInWorktree(git, localHead, upstreamHead, base = null) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astroadmin-rebase-'));
  const worktreeDir = path.join(tempDir, 'worktree');
  try {
    // Checked out by a client rooted in the worktree, never by `worktree
    // add` itself: its overrides are read as the worktree sees the config
    // (an includeIf on the git directory can name a filter for linked
    // worktrees only, which overrides read in the checkout never saw).
    await git.raw(['worktree', 'add', '--quiet', '--no-checkout', '--detach', worktreeDir, localHead]);
    const worktreeGit = gitClientAt(worktreeDir);
    await worktreeGit.raw(['reset', '--quiet', '--hard', localHead]);
    try {
      const onto = base ? ['--onto', upstreamHead, base] : [upstreamHead];
      await worktreeGit.raw(['rebase', '--quiet', '--no-autostash', '--no-update-refs', ...onto]);
    } catch (rebaseError) {
      // Stopped on a conflict when there is a rebase to abort; any other
      // failure (the worktree could not be written) is not the editor's clash.
      const stopped = await worktreeGit.raw(['rebase', '--abort']).then(() => true, () => false);
      if (!stopped) throw rebaseError;
      console.error('The rebase onto the upstream conflicted; aborted it:', rebaseError.message);
      return null;
    }
    return (await worktreeGit.raw(['rev-parse', 'HEAD'])).trim();
  } finally {
    await git.raw(['worktree', 'remove', '--force', worktreeDir]).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
    await git.raw(['worktree', 'prune']).catch(() => {});
  }
}

/**
 * The current branch's upstream, or null when HEAD is detached or the branch
 * tracks nothing. Reads the full ref name: `--short` can return "heads/main"
 * when a tag is also called "main", which names the wrong config keys.
 * @returns {Promise<{remote: string, ref: string}|null>}
 */
async function findUpstream(git) {
  try {
    const headRef = (await git.raw(['symbolic-ref', '--quiet', 'HEAD'])).trim();
    if (!headRef.startsWith('refs/heads/')) return null;
    const branch = headRef.slice('refs/heads/'.length);
    const remote = (await git.raw(['config', '--get', `branch.${branch}.remote`])).trim();
    const ref = (await git.raw(['config', '--get', `branch.${branch}.merge`])).trim();
    return remote && ref ? { remote, ref } : null;
  } catch {
    return null;
  }
}

/**
 * Push exactly the checked commit to the upstream branch, and nothing else. A
 * bare `git push` can send other refs (a configured remote.<name>.push
 * refspec, push.default=matching, followTags), none of which were checked.
 */
async function pushCheckedCommit(git, commit, upstream) {
  await git.raw(['push', ...PUSH_PROGRAMS, '--no-follow-tags', upstream.remote, `${commit}:${upstream.ref}`]);
  // The upstream is now this commit: the next rebase's base (lastKnownBase).
  await recordUpstream(git, upstream, commit);
}

/**
 * Response body for a checkout left mid-rebase or mid-merge by someone else,
 * a checkout with submodules (reason 'submodules'), or a repository whose
 * files go through a git filter (reason 'filter').
 * @param {'submodules'|'filter'|null} [reason]
 */
export function blockedBody(reason = null) {
  if (reason === 'submodules') {
    return {
      success: false,
      committed: false,
      pushed: false,
      commit: null,
      error: 'This site cannot be published from the editor',
      message: 'Nothing was published: the site\'s repository uses git submodules, '
        + 'which publishing from the editor does not support. Your changes are saved. Contact your site administrator.',
    };
  }
  if (reason === 'filter') {
    return {
      success: false,
      committed: false,
      pushed: false,
      commit: null,
      error: 'This site cannot be published from the editor',
      message: 'Nothing was published: this site stores some files through a git filter (such as Git LFS), '
        + 'which publishing from the editor does not support. Your changes are saved. Contact your site administrator.',
    };
  }
  return {
    success: false,
    committed: false,
    pushed: false,
    commit: null,
    error: 'The site needs attention before it can be published',
    message: 'Nothing was published: the site files are in the middle of another change. '
      + 'Your changes are saved. Contact your site administrator.',
  };
}

/** Response body for a commit whose rebase onto the upstream conflicted. */
export function conflictBody({ committed = false, commitResult = null } = {}) {
  return {
    success: false,
    committed,
    pushed: false,
    commit: commitInfo(commitResult),
    error: 'Your changes clash with newer changes to the site',
    message: 'Your changes are saved and committed, but someone else has since changed the same content, '
      + 'so they were not published. Contact your site administrator to combine the two.',
  };
}

/**
 * Response body for newer changes to the site that touch files someone has
 * changed on the server outside the editor (uncommitted, or new and
 * untracked). Names no file: which ones is for the server log.
 */
export function localChangesBody({ committed = false, commitResult = null } = {}) {
  return {
    success: false,
    committed,
    pushed: false,
    commit: commitInfo(commitResult),
    error: 'Changes made on the server are in the way',
    message: `${committed ? 'Your changes are saved and committed' : 'Your changes are saved'}, but were not published: `
      + 'newer changes to the site touch files that were also changed directly on the server, outside the editor. '
      + 'Contact your site administrator to sort those files out, then publish again.',
  };
}

/** Response body for a checked commit that could not be pushed. */
export function pushFailureBody({ committed = false, commitResult = null } = {}) {
  return {
    success: false,
    committed,
    pushed: false,
    commit: commitInfo(commitResult),
    error: 'Could not send your changes to the site',
    message: 'Your changes are saved and committed, but could not be sent to the site, so they are not live yet. '
      + 'Try publishing again in a moment; if it keeps happening, contact your site administrator.',
  };
}

/**
 * A refused entry is opened from the refusal only when it is an existing slug
 * of its collection (build-failure.js resolves Astro's ids, such as "homefr"
 * for home.fr.md, to the editor's slug and locale when it can).
 */
async function markEditableEntries(entries) {
  const marked = [];
  for (const entry of entries) {
    let slugs = [];
    try {
      slugs = await listSlugs(entry.collection);
    } catch {
      // unknown collection: not openable
    }
    marked.push({ ...entry, editable: slugs.includes(entry.slug) });
  }
  return marked;
}

/** Response body for a push the content check refused. */
export async function checkRefusalBody(check, { committed = false, commitResult = null } = {}) {
  const problems = (check.problems || []).map(({ code, message }) => ({ code, message }));
  const entries = await markEditableEntries(check.entries || []);
  return {
    success: false,
    committed,
    pushed: false,
    commit: commitInfo(commitResult),
    error: "The site's build rejects this content",
    message: committed
      ? 'Your changes are saved and committed, but were not published: the site would not build with them.'
      : 'Nothing was published: the site would not build with the current content.',
    // Structured parts only (build-failure.js): no text of the build's output.
    check: {
      commit: check.commit,
      problems,
      entries,
      // The same, as plain text, for a client that shows one block of text.
      output: refusalText(problems, entries),
    },
  };
}

/**
 * A refusal as plain text: the problems, then each entry with its issues.
 * @param {Array<{message: string}>} problems
 * @param {Array<{collection: string, slug: string, locale?: string|null, issues?: Array}>} entries
 */
export function refusalText(problems, entries) {
  const lines = problems.map((problem) => problem.message);
  for (const entry of entries) {
    lines.push(`${entry.collection}/${entry.slug}${entry.locale ? ` (${entry.locale})` : ''}`);
    for (const issue of entry.issues || []) {
      const accepted = issue.accepted ? ` Accepted: ${issue.accepted.join(', ')}.` : '';
      lines.push(`  ${issue.path || '(the entry)'}: ${issue.message}${accepted}`);
    }
  }
  return lines.join('\n');
}

function commitInfo(commitResult) {
  return commitResult
    ? { hash: commitResult.commit, summary: commitResult.summary }
    : null;
}

/**
 * Run the git pre-step: stage configured paths and commit, then pull --rebase,
 * check the resulting HEAD with Astro and push (all in pushIfAstroAccepts). A
 * missing remote doesn't fail the publish; the check is not best-effort.
 * @returns {ReturnType<typeof pushIfAstroAccepts>}
 */
function runGitStep(fullConfig, commitMessage) {
  const git = createGitClient(fullConfig);
  return pushIfAstroAccepts(fullConfig, git, {
    commit: async () => (await commitConfiguredPaths(fullConfig, git, commitMessage, {
      includeDb: Boolean(fullConfig.git?.includeDb),
    })).result,
  });
}

/**
 * Stage the configured git paths inside the site (getAllowedGitPaths, never
 * the raw list, whose `./` or `../x` staged the whole site or a sibling
 * folder, #84) and, with `includeDb`, the content DB, then commit exactly
 * those. The one staging sequence for Publish and the commit route.
 * @returns {Promise<{result: object|null, stagedFiles: string[]}>} result is
 *   null when nothing in those paths changed
 */
export async function commitConfiguredPaths(fullConfig, git, commitMessage, { includeDb = false } = {}) {
  const commitPaths = [];
  // Optionally force-add the (gitignored) content DB.
  if (includeDb) {
    const relDb = path.relative(fullConfig.paths.projectRoot, fullConfig.database.path);
    try {
      await git.add(['-f', relDb]);
      commitPaths.push(relDb);
    } catch (error) {
      console.log('Could not stage content DB:', error.message);
    }
  }

  commitPaths.push(...await stageGitPaths(git, getAllowedGitPaths(fullConfig)));

  const stagedFiles = await getStagedFilesForPaths(git, commitPaths);
  if (stagedFiles.length === 0) return { result: null, stagedFiles };
  const result = await git.commit(commitMessage, commitPaths);
  console.log(`✅ Committed: ${commitMessage}`);
  return { result, stagedFiles };
}

/**
 * POST /api/publish
 * Build and deploy the site; commit/push to git first when git is enabled.
 */
export async function publishHandler(req, res) {
  try {
    const { message } = req.body;
    const commitMessage = message?.trim() || 'Content update';

    const fullConfig = await getConfig();
    const deployConfig = fullConfig.deploy;
    const gitEnabled = fullConfig.git?.enabled;

    // Validate deploy config up front.
    if (deployConfig?.adapter) {
      const validation = validateDeployConfig(deployConfig, { projectRoot: fullConfig.paths.projectRoot });
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: 'Invalid deploy configuration',
          details: validation.errors,
        });
      }
    }

    // Optional git pre-step.
    let committed = false;
    let pushed = false;
    let commitResult = null;
    if (gitEnabled) {
      const outcome = await withGitLock(() => runGitStep(fullConfig, commitMessage));
      ({ pushed, commitResult } = outcome);
      committed = Boolean(commitResult);
      if (outcome.blocked) {
        return res.status(409).json(blockedBody(outcome.blockedReason));
      }
      if (outcome.conflict) {
        return res.status(409).json(conflictBody({ committed, commitResult }));
      }
      if (outcome.localChanges) {
        return res.status(409).json(localChangesBody({ committed, commitResult }));
      }
      if (!outcome.check.success) {
        return res.status(422).json(await checkRefusalBody(outcome.check, { committed, commitResult }));
      }
      if (outcome.pushError) {
        return res.status(502).json(pushFailureBody({ committed, commitResult }));
      }
    }

    // Build + deploy.
    let buildResult = null;
    let deployResult = null;

    if (deployConfig?.adapter) {
      buildResult = buildResultForEditor(await runProductionBuild());

      if (!buildResult.success) {
        return res.json({
          success: false,
          committed,
          pushed,
          commit: commitInfo(commitResult),
          build: buildResult,
          deploy: null,
          message: gitEnabled ? 'Published to git, but build failed' : 'Build failed',
          error: 'Build failed - deployment skipped',
        });
      }

      try {
        deployResult = deployResultForEditor(await deploy(deployConfig, fullConfig.paths.projectRoot));
        console.log('✅ Deployment completed');
      } catch (deployError) {
        // The adapter's message can carry server paths and command lines.
        console.error('Deployment failed:', deployError);
        return res.json({
          success: false,
          committed,
          pushed,
          commit: commitInfo(commitResult),
          build: buildResult,
          deploy: { success: false, error: DEPLOY_FAILED_MESSAGE },
          message: 'Built, but deployment failed',
          error: DEPLOY_FAILED_MESSAGE,
        });
      }
    }

    res.json({
      success: true,
      committed,
      pushed,
      commit: commitInfo(commitResult),
      build: buildResult,
      deploy: deployResult,
      message: buildPublishMessage({ gitEnabled, committed, pushed, deployResult }),
    });
  } catch (error) {
    console.error('Error publishing:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to publish',
      message: publishFailureMessage(error),
    });
  }
}

const DEPLOY_FAILED_MESSAGE = 'The deployment failed; see the server log.';

/**
 * A production build's result as the editor may see it: whether it worked,
 * how long it took, and on failure a fixed error with the problems its
 * output names as error codes (build-failure.js). The output itself is in
 * the server log (build.js logs it), never in the response.
 * @param {{success: boolean, duration?: number, output?: string, error?: string}|null} buildResult
 */
export function buildResultForEditor(buildResult) {
  if (!buildResult) return buildResult;
  const forEditor = { success: buildResult.success, duration: buildResult.duration };
  if (!buildResult.success) {
    // build.js sets only sentences of ours (a failed command, astro missing).
    forEditor.error = buildResult.error || 'The build failed; see the server log.';
    if (buildResult.output) forEditor.problems = buildProblems(buildResult.output);
  }
  return forEditor;
}

/**
 * A deployment's result as the editor may see it: chosen status fields only.
 * An adapter's output names its destination (rsync's "created directory
 * /srv/..."), so it is logged, never returned.
 * @param {Object|null} deployResult - deploy() result
 */
export function deployResultForEditor(deployResult) {
  if (!deployResult) return deployResult;
  if (deployResult.output) console.log(`Deployment output (${deployResult.adapter || 'no adapter'}):\n${deployResult.output}`);
  const forEditor = { success: deployResult.success === true };
  if (typeof deployResult.adapter === 'string') forEditor.adapter = deployResult.adapter;
  if (typeof deployResult.dryRun === 'boolean') forEditor.dryRun = deployResult.dryRun;
  if (deployResult.skipped === true) forEditor.skipped = true;
  return forEditor;
}

/**
 * What the editor is told when publishing fails outright. A missing git
 * identity (the first publish on a fresh machine or container) gets the fix;
 * anything else a fixed message (publishHandler logs the error).
 * @param {Error} error
 * @returns {string}
 */
export function publishFailureMessage(error) {
  const text = String(error?.message || error || '');
  if (/Author identity unknown|Please tell me who you are|unable to auto-detect email/i.test(text)) {
    return 'Git on this server has no author identity, so the commit was refused. '
      + 'Set one in the site repository (git config user.name "Your Name" and git config user.email you@example.com), '
      + 'or set GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL for AstroAdmin, then publish again.';
  }
  return 'Publishing failed; see the server log.';
}

/**
 * Resolve a requested page path against the configured public site, refusing
 * anything that would escape it (SSRF guard — `path` is client-supplied, e.g.
 * `//evil.com` or `http://internal`). Lives in ui/live-url.js so the editor's
 * link and this check map paths identically; re-exported for existing callers.
 */
export { resolveLiveUrl };

// Stable, fast content hash (djb2) so the editor can tell when a page's live
// HTML changes after a publish without transferring the whole body around.
function hashContent(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * GET /api/publish/live-status?path=/some-page
 * Fetch a page from the configured public (production) site and return a hash of
 * its HTML. The editor captures this before a publish, then polls until the hash
 * changes — i.e. the deploy went live. No-op (configured:false) when publicUrl
 * is unset. Server-side fetch avoids the browser's cross-origin restriction.
 */
export async function liveStatusHandler(req, res) {
  try {
    const fullConfig = await getConfig();
    const publicUrl = fullConfig.publicUrl;
    if (!publicUrl) {
      return res.json({ success: true, configured: false });
    }

    let target;
    try {
      target = resolveLiveUrl(publicUrl, req.query.path);
    } catch (err) {
      console.error('Live status refused a path:', err.message);
      return res.status(400).json({ success: false, configured: true, error: 'That path is not a page on the public site' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(target.href, {
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache' },
      });
      const body = await response.text();
      return res.json({
        success: true,
        configured: true,
        reachable: response.ok,
        status: response.status,
        hash: response.ok ? hashContent(body) : null,
      });
    } catch (fetchError) {
      // Unreachable/timeout is expected mid-deploy — report, don't 500.
      console.warn('Live site not reachable:', fetchError.message);
      return res.json({ success: true, configured: true, reachable: false, error: 'The live site could not be reached' });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.error('Error checking live status:', error);
    res.status(500).json({ success: false, error: 'Failed to check live status', message: 'The live status could not be checked; see the server log.' });
  }
}

router.get('/live-status', liveStatusHandler);

export function buildPublishMessage({ gitEnabled, committed, pushed, deployResult }) {
  const parts = [];
  if (gitEnabled && committed && pushed) parts.push('committed and pushed');
  else if (gitEnabled && committed) parts.push('committed');
  else if (gitEnabled && pushed) parts.push('pushed');
  if (deployResult) parts.push('built and deployed');
  if (parts.length === 0) {
    return gitEnabled
      ? 'Nothing to publish (no git changes, no deploy adapter configured)'
      : 'Nothing to publish (git disabled, no deploy adapter configured)';
  }
  return `Published: ${parts.join(', ')}`;
}

router.post('/', publishHandler);

export default router;
