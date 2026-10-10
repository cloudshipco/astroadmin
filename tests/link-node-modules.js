/**
 * Give a throwaway test site a node_modules that links each of this
 * checkout's packages, WITHOUT its dot-directories other than `.bin`.
 *
 * Astro writes its content data store into `node_modules/.astro`. Linking
 * that too would make every test site's dev server or build share one store
 * (and this checkout's), so one test's entries could appear in, or vanish
 * from, another's. CLAUDE.md states the same rule for the publish check.
 *
 * Not a test file: imported by tests that start a real Astro.
 *
 * @param {string} repoRoot - this checkout
 * @param {string} siteDir - the throwaway site
 * @param {{skip?: string[]}} [options] - package names to leave out
 */

import fs from 'fs';
import path from 'path';

/**
 * Where the site's Astro data store would be written, if that is inside this
 * checkout's node_modules; null when the site has its own. Compares RESOLVED
 * paths: a site whose whole node_modules is a link (or sits under a linked
 * parent directory) has a node_modules/.astro that is a real directory, not a
 * link, and is still this checkout's. An lstat of the store alone misses it.
 * @param {string} repoRoot - this checkout
 * @param {string} siteDir - the throwaway site
 * @returns {string|null}
 */
export function sharedAstroStore(repoRoot, siteDir) {
  const checkoutModules = fs.realpathSync(path.join(repoRoot, 'node_modules'));
  const siteModules = path.join(siteDir, 'node_modules');
  if (!fs.existsSync(siteModules)) return null;
  const store = path.join(siteModules, '.astro');
  const resolved = fs.existsSync(store)
    ? fs.realpathSync(store)
    : path.join(fs.realpathSync(siteModules), '.astro');
  const inside = resolved === checkoutModules || resolved.startsWith(checkoutModules + path.sep);
  return inside ? resolved : null;
}

export function linkNodeModules(repoRoot, siteDir, { skip = [] } = {}) {
  const target = path.join(siteDir, 'node_modules');
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(path.join(repoRoot, 'node_modules'))) {
    if (name.startsWith('.') && name !== '.bin') continue;
    if (skip.includes(name)) continue;
    fs.symlinkSync(path.join(repoRoot, 'node_modules', name), path.join(target, name));
  }
}
