/**
 * The admin's throwaway linked worktrees (the publish check's build, the
 * rebase, the filter view), and their cleanup.
 *
 * Cleanup touches only what the admin made. `git worktree prune` is never
 * run: it drops EVERY stale worktree record in the repository, including a
 * person's whose directory is on a disk that is not mounted, which they can
 * no longer repair. Instead each worktree is removed by its own path, and a
 * record the admin left behind (the process stopped before cleaning up, and
 * the directory has since gone) is recognised by where it pointed: a
 * `worktree` directory inside a temporary directory named with one of
 * WORKTREE_PREFIXES, under the system temporary directory.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** The temporary directory name prefixes the admin's worktrees live under. */
export const WORKTREE_PREFIXES = Object.freeze(['astroadmin-check-', 'astroadmin-rebase-', 'astroadmin-view-']);

/**
 * Make a temporary directory for a worktree of `kind` (one of
 * WORKTREE_PREFIXES without its dash) and return it with the worktree's path
 * inside it. The worktree itself is added by the caller, which knows how
 * (checked out or not).
 * @param {'astroadmin-check'|'astroadmin-rebase'|'astroadmin-view'} kind
 * @returns {{tempDir: string, worktreeDir: string}}
 */
export function makeWorktreeDir(kind) {
  if (!WORKTREE_PREFIXES.includes(`${kind}-`)) throw new Error(`Unknown worktree kind ${kind}`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${kind}-`));
  return { tempDir, worktreeDir: path.join(tempDir, 'worktree') };
}

/**
 * The worktree's administrative directory (`<common dir>/worktrees/<id>`),
 * read from its `.git` file, or null.
 * @param {string} worktreeDir
 */
export function worktreeAdminDir(worktreeDir) {
  try {
    const text = fs.readFileSync(path.join(worktreeDir, '.git'), 'utf-8');
    const match = /^gitdir: (.+)$/m.exec(text);
    return match ? path.resolve(worktreeDir, match[1].trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Remove a worktree the admin added, and only it: `worktree remove --force`
 * by its path; then its temporary directory, and its administrative
 * directory if git's removal left one (the directory could not be read).
 * Never throws.
 * @param {(args: string[]) => Promise<string>} runGit - git in the checkout
 * @param {{tempDir: string, worktreeDir: string}} worktree
 * @param {string|null} adminDir - from worktreeAdminDir, read once added
 */
export async function removeWorktree(runGit, { tempDir, worktreeDir }, adminDir) {
  await runGit(['worktree', 'remove', '--force', worktreeDir]).catch(() => {});
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort: the record goes below whatever happens to the directory
  }
  if (adminDir && path.basename(path.dirname(adminDir)) === 'worktrees') {
    try {
      fs.rmSync(adminDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Could not remove the record of a throwaway worktree:', error.message);
    }
  }
}

/**
 * Drop the records of the admin's own worktrees whose directories are gone
 * (left by a process that stopped before cleaning up). A record whose
 * directory still exists may be another process's check in progress (the
 * doctor CLI), and a locked record is left alone, as is anything not made by
 * the admin. Never throws.
 * @param {(args: string[]) => Promise<string>} runGit - git in the checkout
 */
export async function removeOwnStaleWorktrees(runGit) {
  try {
    const commonDir = (await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const recordsDir = path.join(commonDir, 'worktrees');
    if (!fs.existsSync(recordsDir)) return;
    const tempRoots = new Set([os.tmpdir(), realpathOrSelf(os.tmpdir())]);
    for (const id of fs.readdirSync(recordsDir)) {
      const record = path.join(recordsDir, id);
      if (fs.existsSync(path.join(record, 'locked'))) continue;
      let gitFile;
      try {
        gitFile = fs.readFileSync(path.join(record, 'gitdir'), 'utf-8').trim();
      } catch {
        continue;
      }
      const worktreeDir = path.dirname(gitFile);
      const tempDir = path.dirname(worktreeDir);
      const ours = path.basename(gitFile) === '.git'
        && path.basename(worktreeDir) === 'worktree'
        && WORKTREE_PREFIXES.some((prefix) => path.basename(tempDir).startsWith(prefix))
        && tempRoots.has(path.dirname(tempDir));
      if (!ours || fs.existsSync(worktreeDir)) continue;
      fs.rmSync(record, { recursive: true, force: true });
      console.log(`Removed the record of a throwaway worktree left behind earlier (${worktreeDir})`);
    }
  } catch (error) {
    console.error('Could not look for throwaway worktrees left behind:', error.message);
  }
}

function realpathOrSelf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}
