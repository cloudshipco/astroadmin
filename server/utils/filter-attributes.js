/**
 * Whether the site's repository stores files through a git filter driver
 * (Git LFS, or any clean/smudge filter), which publishing refuses.
 *
 * The admin's git switches every filter driver off (git-exec.js: a driver is
 * a command the repository's config names, #67). For a repository whose
 * files really go through one, that is wrong both ways: a file the editor
 * touches is committed as its working-tree bytes rather than what the filter
 * stores (an LFS image recommitted whole, with no pointer), and the publish
 * check's worktree holds what the repository stores (LFS pointer text, which
 * the build then reads as the image). So such a site is not published from
 * the editor at all, rather than published wrongly.
 *
 * "In use" means a file anywhere in the repository, tracked or new (and not
 * ignored), whose `filter` attribute names:
 * - `lfs`, configured or not: without git-lfs the checkout holds pointer
 *   text, which is no site to check or publish either; or
 * - a driver with a clean, smudge or process command configured in any
 *   scope (the same set git-exec.js switches off).
 * An attribute naming a driver nobody configured is inert in git as well,
 * and a driver no attribute uses never runs (git-lfs's own global config,
 * on a machine that has it, is the common case): neither is refused.
 */

const ALWAYS_REFUSED = 'lfs';

/** Driver names a pathspec's `attr:` magic can carry unquoted. */
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The name of the filter driver in use, or null.
 * @param {import('simple-git').SimpleGit} git - a client rooted in the site
 * @returns {Promise<string|null>}
 */
export async function filterDriverInUse(git) {
  const names = new Set([ALWAYS_REFUSED]);
  // `-z`: each entry is `key\nvalue`. No output (exit 1) when none is set.
  const configured = await git.raw(['config', '-z', '--get-regexp', '^filter\\..+\\.(clean|smudge|process)$']).catch(() => '');
  for (const entry of configured.split('\0')) {
    const [key, value = ''] = entry.split('\n');
    const match = /^filter\.(.+)\.[^.]+$/s.exec(key);
    if (!match || value === '') continue;
    // A name the pathspec cannot say: assume the worst rather than miss it.
    if (!PLAIN_NAME.test(match[1])) return match[1];
    names.add(match[1]);
  }

  const refuse = (name, file) => {
    console.error(`Publish refused: files go through the git filter "${name}" (for example ${file})`);
    return name;
  };

  // Tracked files, by pathspec magic. (It does not descend into untracked
  // directories, so new files are asked about one by one below.)
  const tracked = await git.raw([
    'ls-files', '-z', '--cached', '--', ...[...names].map((name) => `:(top,attr:filter=${name})`),
  ]);
  const trackedFile = tracked.split('\0').find(Boolean);
  if (trackedFile) {
    const [[name] = [ALWAYS_REFUSED]] = await filterAttributes(git, [trackedFile]);
    return refuse(name, trackedFile);
  }

  // New files that are not ignored: what the editor's next commit could add.
  const untracked = (await git.raw(['ls-files', '-z', '--others', '--exclude-standard', '--', ':(top)'])).split('\0').filter(Boolean);
  for (let start = 0; start < untracked.length; start += 500) {
    for (const [name, file] of await filterAttributes(git, untracked.slice(start, start + 500))) {
      if (names.has(name)) return refuse(name, file);
    }
  }
  return null;
}

/**
 * The `filter` attribute of each of `files` (relative to the client's
 * directory) that has a value, as [value, file] pairs.
 * @returns {Promise<Array<[string, string]>>}
 */
async function filterAttributes(git, files) {
  const output = await git.raw(['check-attr', '-z', 'filter', '--', ...files]);
  const fields = output.split('\0');
  const pairs = [];
  // -z records: <path> NUL <attribute> NUL <value> NUL
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [file, , value] = fields.slice(index, index + 3);
    if (!['unspecified', 'unset', 'set'].includes(value)) pairs.push([value, file]);
  }
  return pairs;
}
