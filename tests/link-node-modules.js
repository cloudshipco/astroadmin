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

export function linkNodeModules(repoRoot, siteDir, { skip = [] } = {}) {
  const target = path.join(siteDir, 'node_modules');
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(path.join(repoRoot, 'node_modules'))) {
    if (name.startsWith('.') && name !== '.bin') continue;
    if (skip.includes(name)) continue;
    fs.symlinkSync(path.join(repoRoot, 'node_modules', name), path.join(target, name));
  }
}
