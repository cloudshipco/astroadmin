/**
 * Git API Router
 * Git operations for version control
 */

import express from 'express';
import path from 'path';
import simpleGit from 'simple-git';
import { config } from '../config.js';

const router = express.Router();
const git = simpleGit(config.paths.projectRoot);

/**
 * Allowed directories for git file operations (relative to project root).
 * These match the directories staged by /publish endpoint.
 */
const ALLOWED_GIT_PATHS = ['src/content', 'src/styles', 'public/images'];

/**
 * Validate that a file path is within allowed directories.
 * Uses path.resolve() + startsWith() for robust traversal prevention.
 * @param {string} filePath - User-provided file path
 * @returns {string} - Normalized path (relative to project root)
 * @throws {Error} - If path is outside allowed directories
 */
function validateFilePath(filePath) {
  // Normalize to handle ., .., // etc.
  const normalized = path.normalize(filePath);

  // Reject obvious traversal attempts early
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('Invalid file path: must be relative to project root');
  }

  // Resolve to absolute path for comparison
  const absolutePath = path.resolve(config.paths.projectRoot, normalized);
  const projectRoot = path.resolve(config.paths.projectRoot);

  // Ensure path is within project root (defense in depth)
  if (!absolutePath.startsWith(projectRoot + path.sep)) {
    throw new Error('Invalid file path: path escapes project root');
  }

  // Check against allowed directories
  const isAllowed = ALLOWED_GIT_PATHS.some(allowedDir => {
    const allowedAbsolute = path.resolve(projectRoot, allowedDir);
    return absolutePath.startsWith(allowedAbsolute + path.sep) ||
           absolutePath === allowedAbsolute;
  });

  if (!isAllowed) {
    throw new Error(
      `Access denied: file operations restricted to ${ALLOWED_GIT_PATHS.join(', ')}`
    );
  }

  return normalized;
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
  if (!/^[a-f0-9]{7,40}$/i.test(commit)) {
    throw new Error('Invalid commit hash format');
  }

  return commit;
}

/**
 * Validate an array of file paths for git.add() operations.
 * @param {string[]} files - Array of file paths
 * @returns {string[]} - Validated paths
 * @throws {Error} - If any path is invalid
 */
function validateFilePaths(files) {
  return files.map(validateFilePath);
}

/**
 * GET /api/git/status
 * Get Git status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await git.status();

    res.json({
      success: true,
      status: {
        modified: status.modified,
        created: status.created,
        deleted: status.deleted,
        renamed: status.renamed,
        staged: status.staged,
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
    const { message, files } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Commit message is required',
      });
    }

    // Add files (default to content directory if not specified)
    // Validate custom file paths if provided; defaults are pre-approved
    const filesToAdd = files ? validateFilePaths(files) : ['src/content/'];
    await git.add(filesToAdd);

    // Commit
    const result = await git.commit(message);

    // Optionally push if configured
    if (config.git.autoPush) {
      try {
        await git.push();
        console.log('✅ Changes pushed to remote');
      } catch (pushError) {
        console.warn('⚠️  Failed to auto-push:', pushError.message);
      }
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
    const result = await git.pull();

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
 * POST /api/git/push
 * Push commits to remote
 */
router.post('/push', async (req, res) => {
  try {
    const result = await git.push();

    res.json({
      success: true,
      result,
      message: 'Pushed changes successfully',
    });
  } catch (error) {
    console.error('Error pushing changes:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to push changes',
      message: error.message,
    });
  }
});

/**
 * POST /api/git/publish
 * Commit any uncommitted changes and push to remote
 */
router.post('/publish', async (req, res) => {
  try {
    const { message } = req.body;
    const commitMessage = message?.trim() || 'Content update';

    // Check for uncommitted changes
    const status = await git.status();
    const hasChanges = status.modified.length > 0 ||
                       status.created.length > 0 ||
                       status.deleted.length > 0 ||
                       status.staged.length > 0;

    let committed = false;
    let commitResult = null;

    // Pull any remote changes first (rebase to keep history clean)
    try {
      await git.pull(['--rebase']);
      console.log('✅ Pulled latest changes');
    } catch (pullError) {
      // Ignore if nothing to pull or not tracking
      console.log('Pull skipped:', pullError.message);
    }

    if (hasChanges) {
      // Stage all content changes
      await git.add(['src/content/', 'src/styles/', 'public/images/']);

      // Commit
      commitResult = await git.commit(commitMessage);
      committed = true;
      console.log(`✅ Committed: ${commitMessage}`);
    }

    // Push to remote
    await git.push();
    console.log('✅ Pushed to remote');

    res.json({
      success: true,
      committed,
      pushed: true,
      commit: commitResult ? {
        hash: commitResult.commit,
        summary: commitResult.summary,
      } : null,
      message: committed
        ? 'Changes committed and published'
        : 'Published (no new changes to commit)',
    });
  } catch (error) {
    console.error('Error publishing:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to publish',
      message: error.message,
    });
  }
});

/**
 * GET /api/git/diff
 * Get diff of uncommitted changes or between commits
 */
router.get('/diff', async (req, res) => {
  try {
    const { file, from, to } = req.query;

    // Validate file path if provided (restrict to content directories)
    const validatedFile = file ? validateFilePath(file) : null;

    // Validate commit references if provided
    const validatedFrom = from ? validateCommitHash(from) : null;
    const validatedTo = to ? validateCommitHash(to) : null;

    let diffResult;

    if (validatedFrom && validatedTo) {
      // Diff between two commits
      diffResult = await git.diff([validatedFrom, validatedTo, '--', validatedFile || '.']);
    } else if (validatedFrom) {
      // Diff from a specific commit to working tree
      diffResult = await git.diff([validatedFrom, '--', validatedFile || '.']);
    } else {
      // Diff of uncommitted changes (staged + unstaged)
      diffResult = await git.diff(['HEAD', '--', validatedFile || '.']);
    }

    res.json({
      success: true,
      diff: diffResult,
    });
  } catch (error) {
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

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'File path is required',
      });
    }

    // Validate file path (restrict to content directories)
    const validatedFile = validateFilePath(file);

    // Validate commit reference
    const ref = commit ? validateCommitHash(commit) : 'HEAD';
    const content = await git.show([`${ref}:${validatedFile}`]);

    res.json({
      success: true,
      content,
      commit: ref,
      file,
    });
  } catch (error) {
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

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'File path is required',
      });
    }

    // Validate file path (restrict to content directories)
    const validatedFile = validateFilePath(file);

    // Restore file from HEAD (discard uncommitted changes)
    await git.checkout(['HEAD', '--', validatedFile]);

    res.json({
      success: true,
      message: `Reverted ${file} to last committed state`,
      file,
    });
  } catch (error) {
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

    if (!file || !commit) {
      return res.status(400).json({
        success: false,
        error: 'File path and commit hash are required',
      });
    }

    // Validate file path (restrict to content directories)
    const validatedFile = validateFilePath(file);

    // Validate commit hash format
    const validatedCommit = validateCommitHash(commit);

    // Restore file from specific commit
    await git.checkout([validatedCommit, '--', validatedFile]);

    res.json({
      success: true,
      message: `Restored ${file} from commit ${commit.substring(0, 7)}`,
      file,
      commit,
    });
  } catch (error) {
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

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'File path is required',
      });
    }

    // Validate file path (restrict to content directories)
    const validatedFile = validateFilePath(file);

    const log = await git.log({ maxCount: limit, file: validatedFile });

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
    console.error('Error getting file history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get file history',
      message: error.message,
    });
  }
});

export default router;
