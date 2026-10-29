/**
 * The site's configured git paths (config.git.paths): what Publish and the
 * commit route stage, and what status, diff and revert are scoped to.
 *
 * In its own module because api/git.js imports api/publish.js, and both need
 * the same list: an import the other way would be circular.
 */

import path from 'path';

// Conservative fallback for a malformed config; an explicitly-configured
// empty array means "stage nothing" and is respected.
const DEFAULT_GIT_PATHS = ['src/styles/', 'public/images/'];

/** The configured list as written (unfiltered). Use getAllowedGitPaths to act on it. */
export function getGitPaths(fullConfig) {
  return Array.isArray(fullConfig.git?.paths) ? fullConfig.git.paths : DEFAULT_GIT_PATHS;
}

/**
 * The configured git paths that are strictly INSIDE the project root, relative
 * to it: the only ones anything stages, lists, diffs or reverts.
 *
 * `path.normalize('')` and `path.normalize('./')` are `.`, so an empty, `./`
 * or `src/..` entry would otherwise widen the git API to the whole project
 * (and Publish once committed the whole site with it, #84), and `../x` would
 * reach outside it into the rest of the repository. Such entries are dropped,
 * so a list of nothing but them scopes nothing, like `[]`. Kept entries come
 * back project-relative without a trailing slash (`src/content/` -> `src/content`).
 * @returns {string[]}
 */
export function getAllowedGitPaths(fullConfig) {
  const projectRoot = path.resolve(fullConfig.paths.projectRoot);
  return getGitPaths(fullConfig)
    .filter((gitPath) => typeof gitPath === 'string')
    .map((gitPath) => path.relative(projectRoot, path.resolve(projectRoot, gitPath)))
    .filter((relative) => relative !== '' && relative !== '..'
      && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
