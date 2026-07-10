/**
 * Git API subdirectory-checkout scoping test
 *
 * The hosted layout clones a repo and points projectRoot at a SUBDIRECTORY
 * (`checkout/site`). `git status` reports repo-root-relative paths (`site/...`),
 * but the git API (diff/revert/show) works in projectRoot-relative terms. This
 * test builds a temp `site/`-subdirectory repo and asserts that:
 *   - status paths are translated to projectRoot-relative (src/content/...),
 *   - only files within the configured git paths survive (bun.lock/package.json
 *     and repo-root files are dropped),
 *   - newly-created (untracked) content files show up, and
 *   - a scoped content path actually diffs (the bug: `site/...` did not).
 *
 *   bun tests/git-subdir.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';
import {
  getRepoPrefix,
  scopeStatusFiles,
  isWithinAllowedGitPaths,
  toProjectRelative,
} from '../server/api/git.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-gitsubdir-'));
const repoRoot = tmpRoot;                     // git repo root
const projectRoot = path.join(tmpRoot, 'site'); // astroadmin projectRoot (subdir)
const allowedGitPaths = ['src/content', 'src/styles', 'public/images'];

let passed = 0;
class CheckFailed extends Error {}
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    throw new CheckFailed(name);
  }
}

function write(rel, content) {
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

try {
  // --- Build a repo whose site/ subdirectory is the astroadmin project ---
  write('README.md', '# repo root\n');
  write('site/package.json', '{ "name": "site", "dependencies": {} }\n');
  write('site/bun.lock', 'lock-v1\n');
  write('site/src/content/pages/home.md', '---\ntitle: Home\n---\nHello\n');
  write('site/src/styles/global.css', 'body { color: black; }\n');

  // Production clones the repo at `checkout/` and points projectRoot at
  // `checkout/site`, so the .git lives at the PARENT of projectRoot. Init at the
  // repo root, then drive all ops through simpleGit(projectRoot) exactly as
  // createGitClient(fullConfig) does — git discovers the repo upward.
  await simpleGit(repoRoot).init();
  const git = simpleGit(projectRoot);
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.add(['-A']);
  await git.commit('initial');

  // --- Make a mix of changes: content, assets, and non-editor files ---
  write('site/src/content/pages/home.md', '---\ntitle: Home\n---\nHello EDITED\n');
  write('site/src/content/pages/about.md', '---\ntitle: About\n---\nNew page\n'); // untracked
  write('site/package.json', '{ "name": "site", "dependencies": { "x": "1" } }\n'); // like a bun update
  write('site/bun.lock', 'lock-v2\n');
  write('README.md', '# repo root edited\n');

  const status = await git.status();
  const repoPrefix = await getRepoPrefix(git);

  await check('repo prefix is the subdirectory (site/)', () => {
    assert.strictEqual(repoPrefix, 'site/');
  });

  await check('git status reports repo-root-relative (site/-prefixed) paths', () => {
    // This is the raw behaviour the fix compensates for.
    assert.ok(
      status.modified.includes('site/src/content/pages/home.md'),
      `expected site/-prefixed path, got: ${JSON.stringify(status.modified)}`
    );
  });

  const scopedModified = scopeStatusFiles(status.modified, repoPrefix, allowedGitPaths);
  const scopedCreated = scopeStatusFiles(
    [...status.created, ...status.not_added],
    repoPrefix,
    allowedGitPaths
  );

  await check('modified is scoped + projectRoot-relative', () => {
    assert.deepStrictEqual(scopedModified, ['src/content/pages/home.md']);
  });

  await check('untracked new content file appears (projectRoot-relative)', () => {
    assert.ok(scopedCreated.includes('src/content/pages/about.md'));
  });

  await check('package.json / bun.lock are excluded from the change set', () => {
    const all = [...scopedModified, ...scopedCreated];
    assert.ok(!all.some((f) => f.endsWith('package.json')), 'package.json leaked');
    assert.ok(!all.some((f) => f.endsWith('bun.lock')), 'bun.lock leaked');
  });

  await check('repo-root files (outside the subdir) are excluded', () => {
    const all = [...scopedModified, ...scopedCreated];
    assert.ok(!all.some((f) => f.endsWith('README.md')), 'README.md leaked');
  });

  await check('scoped content path actually diffs (the original bug)', async () => {
    // Pre-fix, the UI sent `site/src/content/pages/home.md` and got an empty /
    // rejected diff. The scoped, projectRoot-relative path must return content.
    const good = await git.diff(['HEAD', '--', 'src/content/pages/home.md']);
    assert.ok(good.includes('EDITED'), 'projectRoot-relative diff should show the edit');

    const bad = await git.diff(['HEAD', '--', 'site/src/content/pages/home.md']);
    assert.strictEqual(bad, '', 'site/-prefixed path resolves to nothing from projectRoot');
  });

  await check('root-checkout (empty prefix) is a no-op passthrough', () => {
    // When projectRoot === repo root, prefix is '' and paths are already scoped.
    const scoped = scopeStatusFiles(
      ['src/content/pages/x.md', 'package.json'],
      '',
      allowedGitPaths
    );
    assert.deepStrictEqual(scoped, ['src/content/pages/x.md']);
  });

  await check('helpers handle edge inputs', () => {
    assert.strictEqual(toProjectRelative('site/a.md', 'site/'), 'a.md');
    assert.strictEqual(toProjectRelative('other/a.md', 'site/'), 'other/a.md');
    assert.ok(isWithinAllowedGitPaths('src/content/x.md', allowedGitPaths));
    assert.ok(!isWithinAllowedGitPaths('src/contentX/x.md', allowedGitPaths)); // prefix, not dir
  });

  console.log(`\n${passed} checks passed`);
} catch (error) {
  if (!(error instanceof CheckFailed)) console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
