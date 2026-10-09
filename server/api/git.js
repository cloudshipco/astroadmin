/**
 * Git API Router
 * Git operations for version control
 */

import express from 'express';
import path from 'path';
import { getConfig } from '../config.js';
import { assertContainedPath, isContentPathError } from '../utils/glob-files.js';
import {
  publishHandler,
  withGitLock,
  pushIfAstroAccepts,
  checkRefusalBody,
  pushFailureBody,
  createGitClient,
  getGitPaths,
  stageGitPaths,
  getStagedFilesForPaths,
} from './publish.js';

const router = express.Router();

export async function commitConfiguredGitPaths(fullConfig, message) {
  const git = createGitClient(fullConfig);
  const gitPaths = getGitPaths(fullConfig);
  const stagedPaths = await stageGitPaths(git, gitPaths);
  const stagedFiles = await getStagedFilesForPaths(git, stagedPaths);

  if (stagedFiles.length === 0) {
    return { result: null, stagedFiles };
  }

  const result = await git.commit(message, stagedPaths);
  return { result, stagedFiles };
}

/**
 * Allowed directories for git file operations (relative to project root) —
 * the configured git paths: src/content plus assets in files mode, assets
 * only in db mode (see config.js defaultGitPathsForStore).
 *
 * Only entries strictly INSIDE the project root count. `path.normalize('')`
 * and `path.normalize('./')` are `.`, so an empty, `./` or `src/..` entry
 * would otherwise widen diff, revert and status to the whole project (and
 * `../x` would reach outside it). Such entries are dropped, so a list of
 * nothing but them scopes nothing, like `[]`. Kept entries come back
 * project-relative without a trailing slash (`src/content/` -> `src/content`).
 */
function getAllowedGitPaths(fullConfig) {
  const projectRoot = path.resolve(fullConfig.paths.projectRoot);
  return getGitPaths(fullConfig)
    .filter((gitPath) => typeof gitPath === 'string')
    .map((gitPath) => path.relative(projectRoot, path.resolve(projectRoot, gitPath)))
    .filter((relative) => relative !== '' && relative !== '..'
      && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/**
 * The project root can be a SUBDIRECTORY of the git repository (the common
 * hosted layout: `git clone repo checkout && projectRoot = checkout/site`).
 * `git status` reports paths relative to the repo ROOT (e.g. `site/src/...`),
 * but the rest of this API — validateFilePath, diff, revert, show — works in
 * projectRoot-relative terms. `git rev-parse --show-prefix` gives the path from
 * the repo root down to projectRoot (`site/`, or `''` when they coincide), so we
 * can translate status paths back to projectRoot-relative before using them.
 * @returns {Promise<string>} prefix with a trailing slash, or '' at the repo root
 */
export async function getRepoPrefix(git) {
  const prefix = (await git.revparse(['--show-prefix'])).trim();
  // Normalise to forward slashes; git already emits them, but be defensive.
  return prefix.replace(/\\/g, '/');
}

/**
 * Translate a repo-root-relative path (as reported by `git status`) to a
 * projectRoot-relative path by stripping the subdirectory prefix. Paths outside
 * the project subdirectory are returned unchanged (they get dropped by the
 * git-path scoping that follows).
 */
export function toProjectRelative(repoRelativePath, repoPrefix) {
  if (repoPrefix && repoRelativePath.startsWith(repoPrefix)) {
    return repoRelativePath.slice(repoPrefix.length);
  }
  return repoRelativePath;
}

/**
 * Whether a projectRoot-relative path falls within one of the configured git
 * paths. The Changes panel and its badge should reflect exactly what Publish
 * stages (config.git.paths — content + assets), not every stray working-tree
 * change (e.g. a `bun update` touching package.json/bun.lock).
 */
export function isWithinAllowedGitPaths(projectRelativePath, allowedGitPaths) {
  const normalized = path.normalize(projectRelativePath);
  return allowedGitPaths.some(
    (dir) => normalized === dir || normalized.startsWith(dir + path.sep) || normalized.startsWith(dir + '/')
  );
}

/**
 * Reduce a `git status` result to the files the editor actually manages:
 * translate repo-root-relative paths to projectRoot-relative, then keep only
 * those within the configured git paths. Fixes both (a) the subdirectory
 * path mismatch that made diff/revert reject every content file, and (b) the
 * panel listing files outside the editor's remit.
 */
export function scopeStatusFiles(files, repoPrefix, allowedGitPaths) {
  return files
    .map((file) => toProjectRelative(file, repoPrefix))
    .filter((file) => isWithinAllowedGitPaths(file, allowedGitPaths));
}

/** A file path or commit the request named that the git API refuses (400). */
export class GitRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitRequestError';
    this.status = 400;
  }
}

/** Answer a refused file path or commit with a 400; true when sent. */
function refusedGitRequest(error, res) {
  if (!(error instanceof GitRequestError)) return false;
  res.status(400).json({ success: false, error: 'Invalid git request', message: error.message });
  return true;
}

/**
 * A validated path as a git pathspec that matches only itself: without the
 * `:(literal)` magic, `src/content/*.md` would be a glob and revert-file would
 * discard every matching file's unpublished edits.
 */
function literalPathspec(validatedFile) {
  return `:(literal)${validatedFile}`;
}

/**
 * Validate that a file path is within allowed directories.
 * Uses path.resolve() + startsWith() for robust traversal prevention.
 * @param {string} filePath - User-provided file path
 * @param {{ allowGitPathRoot?: boolean }} [options] - allowGitPathRoot false
 *   refuses a configured git path itself (`src/content`), for routes that
 *   change files; they also check the path is a file with assertBlobAt.
 * @returns {Promise<string>} - Normalized path (relative to project root)
 * @throws {GitRequestError} - If path is outside allowed directories
 */
async function validateFilePath(filePath, fullConfig, { allowGitPathRoot = true } = {}) {
  // A repeated query parameter arrives as an array, a JSON body can send anything.
  if (typeof filePath !== 'string' || filePath === '' || /[\u0000-\u001f\u007f]/.test(filePath)) {
    throw new GitRequestError('Invalid file path');
  }
  // Normalize to handle ., .., // etc.
  const normalized = path.normalize(filePath);

  // Reject obvious traversal attempts early
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new GitRequestError('Invalid file path: must be relative to project root');
  }

  // Resolve to absolute path for comparison
  const absolutePath = path.resolve(fullConfig.paths.projectRoot, normalized);
  const projectRoot = path.resolve(fullConfig.paths.projectRoot);

  // Ensure path is within project root (defense in depth)
  if (!absolutePath.startsWith(projectRoot + path.sep)) {
    throw new GitRequestError('Invalid file path: path escapes project root');
  }

  // Check against allowed directories
  const allowedGitPaths = getAllowedGitPaths(fullConfig);
  const isAllowed = allowedGitPaths.some(allowedDir => {
    const allowedAbsolute = path.resolve(projectRoot, allowedDir);
    return absolutePath.startsWith(allowedAbsolute + path.sep) ||
           (allowGitPathRoot && absolutePath === allowedAbsolute);
  });

  if (!isAllowed) {
    throw new GitRequestError(
      `Access denied: file operations restricted to ${allowedGitPaths.join(', ')}`
    );
  }

  // Through symlinks too: git itself will not follow a path beyond a symlink,
  // but the API should not depend on that.
  try {
    await assertContainedPath(projectRoot, absolutePath);
  } catch (error) {
    if (isContentPathError(error)) throw new GitRequestError('Invalid file path: path escapes project root');
    throw error;
  }

  return normalized;
}

/**
 * `<rev>:<path>` for `git show`. A bare path there is relative to the REPO
 * root, not the working directory, so with projectRoot in a subdirectory
 * (`site/`) `HEAD:src/content/x.md` would read `<repo>/src/content/x.md`, a
 * file outside the project. `./` makes it relative to projectRoot, the frame
 * validateFilePath checked.
 */
export function showObjectSpec(ref, validatedFile) {
  return `${ref}:./${validatedFile}`;
}

/**
 * Validate commit hash format (hex string, 7-40 chars).
 * @param {string} commit - User-provided commit reference
 * @returns {string} - Validated commit hash
 * @throws {Error} - If format is invalid
 */
function validateCommitHash(commit) {
  // Allow HEAD as special reference
  if (commit === 'HEAD') return commit;

  // Standard git short/full hash: 7-40 hex characters
  if (typeof commit !== 'string' || !/^[a-f0-9]{7,40}$/i.test(commit)) {
    throw new GitRequestError('Invalid commit hash format');
  }

  return commit;
}

/**
 * A commit reference the request named, checked twice: its FORMAT (HEAD or a
 * hex hash, so it can never start with `-` and be read as an option) and that
 * it names a commit in this repository, so a typo is a 400 rather than a git
 * error passed through as a 500.
 */
async function validateCommitRef(git, commit) {
  const ref = validateCommitHash(commit);
  // `--quiet` makes a miss exit 1 with no stderr, which simple-git resolves
  // rather than rejects, so the answer is read from the output.
  let resolved = '';
  try {
    resolved = (await git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  } catch {
    // treated as unknown below
  }
  if (!/^[0-9a-f]{40,64}$/.test(resolved)) {
    throw new GitRequestError('Unknown commit');
  }
  return ref;
}

/**
 * Refuse a path that is not a FILE at `ref`. validateFilePath accepts a folder
 * (a diff or history of a folder is harmless), but a checkout of a folder
 * discards every unpublished edit beneath it. Asking git about `ref` rather
 * than the working tree still allows reverting a file deleted since.
 */
async function assertBlobAt(git, ref, validatedFile) {
  let type = '';
  try {
    type = (await git.raw(['cat-file', '-t', showObjectSpec(ref, validatedFile)])).trim();
  } catch {
    // not in that commit at all
  }
  if (type !== 'blob') {
    throw new GitRequestError('Invalid file path: not a file in that commit');
  }
}

/**
 * GET /api/git/status
 * Get Git status
 */
router.get('/status', async (req, res) => {
  try {
    const fullConfig = await getConfig();
    const git = createGitClient(fullConfig);
    const status = await git.status();

    // Translate repo-root-relative paths to projectRoot-relative and keep only
    // files within the configured git paths (what Publish actually stages).
    const repoPrefix = await getRepoPrefix(git);
    const allowedGitPaths = getAllowedGitPaths(fullConfig);
    const scope = (files) => scopeStatusFiles(files, repoPrefix, allowedGitPaths);
    // renamed entries are { from, to } objects; scope on the destination path.
    const scopeRenamed = (renamed) =>
      (renamed || [])
        .map((entry) => ({
          from: toProjectRelative(entry.from, repoPrefix),
          to: toProjectRelative(entry.to, repoPrefix),
        }))
        .filter((entry) => isWithinAllowedGitPaths(entry.to, allowedGitPaths));

    res.json({
      success: true,
      status: {
        modified: scope(status.modified),
        // `created` = staged-new; `not_added` = untracked. The editor stages
        // only at Publish time, so newly-created entries live in not_added —
        // include them (Publish's `git add -A` will stage them too).
        created: [...new Set([...scope(status.created), ...scope(status.not_added)])],
        deleted: scope(status.deleted),
        renamed: scopeRenamed(status.renamed),
        staged: scope(status.staged),
        ahead: status.ahead,
        behind: status.behind,
        current: status.current,
        tracking: status.tracking,
      },
    });
  } catch (error) {
    console.error('Error getting git status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get git status',
      message: error.message,
    });
  }
});

/**
 * POST /api/git/commit
 * Create a Git commit
 */
router.post('/commit', async (req, res) => {
  try {
    const { message } = req.body;
    const fullConfig = await getConfig();
    const git = createGitClient(fullConfig);

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Commit message is required',
      });
    }

    const outcome = await withGitLock(async () => {
      const { result } = await commitConfiguredGitPaths(fullConfig, message);
      if (!result || !fullConfig.git.autoPush) return { result, check: null, pushError: null };
      // A local commit is harmless; pushing it is publishing, so it is checked.
      const { check, pushError } = await pushIfAstroAccepts(fullConfig, git);
      return { result, check, pushError };
    });
    const { result } = outcome;

    if (!result) {
      return res.status(400).json({
        success: false,
        error: 'No configured git changes to commit',
      });
    }

    if (outcome.check && !outcome.check.success) {
      return res.status(422).json(await checkRefusalBody(outcome.check, { committed: true, commitResult: result }));
    }
    if (outcome.pushError) {
      return res.status(502).json(pushFailureBody({ committed: true, commitResult: result }));
    }

    res.json({
      success: true,
      commit: {
        hash: result.commit,
        summary: result.summary,
      },
      message: 'Changes committed successfully',
    });
  } catch (error) {
    console.error('Error creating commit:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create commit',
      message: error.message,
    });
  }
});

/**
 * GET /api/git/log
 * Get commit history
 */
router.get('/log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const fullConfig = await getConfig();
    const git = createGitClient(fullConfig);

    const log = await git.log({ maxCount: limit });

    const commits = log.all.map(commit => ({
      hash: commit.hash,
      hashShort: commit.hash.substring(0, 7),
      message: commit.message,
      author: commit.author_name,
      email: commit.author_email,
      date: commit.date,
    }));

    res.json({
      success: true,
      commits,
      total: log.total,
    });
  } catch (error) {
    console.error('Error getting git log:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get git log',
      message: error.message,
    });
  }
});

/**
 * POST /api/git/pull
 * Pull latest changes from remote
 */
router.post('/pull', async (req, res) => {
  try {
    const fullConfig = await getConfig();
    const git = createGitClient(fullConfig);
    // Under the git lock: a pull that moved HEAD during a publish's check would
    // make the pushed commit differ from the checked one.
    const result = await withGitLock(() => git.pull());

    res.json({
      success: true,
      result: {
        files: result.files,
        insertions: result.insertions,
        deletions: result.deletions,
        summary: result.summary,
      },
      message: 'Pulled latest changes successfully',
    });
  } catch (error) {
    console.error('Error pulling changes:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to pull changes',
      message: error.message,
    });
  }
});

/**
 * POST /api/git/publish
 * Backwards-compatible alias for POST /api/publish. The publish pipeline
 * (git pre-step -> build -> deploy) lives in api/publish.js; this alias is only
 * mounted when git is enabled.
 */
router.post('/publish', publishHandler);

/**
 * GET /api/git/diff
 * Get diff of uncommitted changes or between commits
 */
router.get('/diff', async (req, res) => {
  try {
    const { file, from, to } = req.query;
    const fullConfig = await getConfig();
    const git = createGitClient(fullConfig);

    // Validate file path if provided (restrict to configured git paths)
    const validatedFile = file ? await validateFilePath(file, fullConfig) : null;

    // Validate commit references if provided
    const validatedFrom = from ? await validateCommitRef(git, from) : null;
    const validatedTo = to ? await validateCommitRef(git, to) : null;

    // With no file, the diff covers the configured git paths only — never `.`,
    // which would show every tracked file in the project and its history.
    // An empty list after `--` would mean the whole tree, so it is no diff.
    const pathspecs = validatedFile
      ? [literalPathspec(validatedFile)]
      : getAllowedGitPaths(fullConfig).filter(Boolean).map(literalPathspec);
    if (pathspecs.length === 0) {
      return res.json({ success: true, diff: '' });
    }
    let diffResult;

    if (validatedFrom && validatedTo) {
      // Diff between two commits
      diffResult = await git.diff([validatedFrom, validatedTo, '--', ...pathspecs]);
    } else if (validatedFrom) {
      // Diff from a specific commit to working tree
      diffResult = await git.diff([validatedFrom, '--', ...pathspecs]);
    } else {
      // Diff of uncommitted changes (staged + unstaged)
      diffResult = await git.diff(['HEAD', '--', ...pathspecs]);
    }

    res.json({
      success: true,
      diff: diffResult,
    });
  } catch (error) {
    if (refusedGitRequest(error, res)) return;
    console.error('Error getting diff:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get diff',
      message: error.message,
    });
  }
});

/**
 * GET /api/git/show
 * Show content of a file at a specific commit
 */
router.get('/show', async (req, res) => {
  try {
    const { commit, file } = req.query;
    const fullConfig = await getConfig();
    const git = createGitClient(fullConfig);

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'File path is required',
      });
    }

    // Validate file path (restrict to configured git paths)
    const validatedFile = await validateFilePath(file, fullConfig);

    // Validate commit reference
    const ref = commit ? await validateCommitRef(git, commit) : 'HEAD';
    const content = await git.show([showObjectSpec(ref, validatedFile)]);

    res.json({
      success: true,
      content,
      commit: ref,
      file,
    });
  } catch (error) {
    if (refusedGitRequest(error, res)) return;
    console.error('Error showing file:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to show file content',
      message: error.message,
    });
  }
});

/**
 * POST /api/git/revert-file
 * Revert a specific file to its last committed state (discard changes)
 */
router.post('/revert-file', async (req, res) => {
  try {
    const { file } = req.body;
    const fullConfig = await getConfig();
    const git = createGitClient(fullConfig);

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'File path is required',
      });
    }

    // Validate file path (restrict to configured git paths); a FILE, never a
    // folder, whose checkout would discard every unpublished edit under it.
    const validatedFile = await validateFilePath(file, fullConfig, { allowGitPathRoot: false });
    await assertBlobAt(git, 'HEAD', validatedFile);

    // Restore file from HEAD (discard uncommitted changes)
    await git.checkout(['HEAD', '--', literalPathspec(validatedFile)]);

    res.json({
      success: true,
      message: `Reverted ${file} to last committed state`,
      file,
    });
  } catch (error) {
    if (refusedGitRequest(error, res)) return;
    console.error('Error reverting file:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to revert file',
      message: error.message,
    });
  }
});

/**
 * POST /api/git/restore-from-commit
 * Restore a file from a specific commit
 */
router.post('/restore-from-commit', async (req, res) => {
  try {
    const { file, commit } = req.body;
    const fullConfig = await getConfig();
    const git = createGitClient(fullConfig);

    if (!file || !commit) {
      return res.status(400).json({
        success: false,
        error: 'File path and commit hash are required',
      });
    }

    // Validate file path (restrict to configured git paths); a FILE at that
    // commit, never a folder.
    const validatedFile = await validateFilePath(file, fullConfig, { allowGitPathRoot: false });

    // Validate the commit, then that the path is a file in it
    const validatedCommit = await validateCommitRef(git, commit);
    await assertBlobAt(git, validatedCommit, validatedFile);

    // Restore file from specific commit
    await git.checkout([validatedCommit, '--', literalPathspec(validatedFile)]);

    res.json({
      success: true,
      message: `Restored ${file} from commit ${commit.substring(0, 7)}`,
      file,
      commit,
    });
  } catch (error) {
    if (refusedGitRequest(error, res)) return;
    console.error('Error restoring file:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to restore file',
      message: error.message,
    });
  }
});

/**
 * GET /api/git/file-history
 * Get commit history for a specific file
 */
router.get('/file-history', async (req, res) => {
  try {
    const { file } = req.query;
    const limit = parseInt(req.query.limit) || 10;
    const fullConfig = await getConfig();
    const git = createGitClient(fullConfig);

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'File path is required',
      });
    }

    // Validate file path (restrict to configured git paths)
    const validatedFile = await validateFilePath(file, fullConfig);

    const log = await git.log({ maxCount: limit, file: literalPathspec(validatedFile) });

    const commits = log.all.map(commit => ({
      hash: commit.hash,
      hashShort: commit.hash.substring(0, 7),
      message: commit.message,
      author: commit.author_name,
      date: commit.date,
    }));

    res.json({
      success: true,
      commits,
      file,
    });
  } catch (error) {
    if (refusedGitRequest(error, res)) return;
    console.error('Error getting file history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get file history',
      message: error.message,
    });
  }
});

export default router;
