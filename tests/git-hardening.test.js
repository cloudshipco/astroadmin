/**
 * Git commit-path hardening tests
 *
 * The hosted editor holds a write credential, so a content commit must never
 * execute repo code and must never publish a symlink. Verifies:
 *   - createGitClient disables hooks (a hostile pre-commit hook does NOT block
 *     or run on commit), and commits pass --no-verify;
 *   - assertNoStagedSymlinks rejects a staged symlink under the content path.
 *
 *   bun tests/git-hardening.test.js
 */

import assert from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createGitClient, assertNoStagedSymlinks } from '../server/api/publish.js';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exit(1);
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'aa-githard-'));
const git = createGitClient({ paths: { projectRoot: root } });

try {
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');

  // A pre-commit hook that fails (and would run arbitrary code) — the hardened
  // client must neither run nor be blocked by it.
  mkdirSync(path.join(root, '.git/hooks'), { recursive: true });
  const hookPath = path.join(root, '.git/hooks/pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\necho "HOOK RAN" > "$(dirname "$0")/../../hook-marker"\nexit 1\n');
  chmodSync(hookPath, 0o755);

  mkdirSync(path.join(root, 'src/content'), { recursive: true });
  writeFileSync(path.join(root, 'src/content/page.md'), '# hello\n');

  await check('commit succeeds despite a hostile failing pre-commit hook', async () => {
    await git.add(['src/content/page.md']);
    const res = await git.commit('content update', ['src/content/page.md'], { '--no-verify': null });
    assert.ok(res.commit, 'expected a commit hash');
    // The hook must not have executed at all (hooksPath=/dev/null).
    assert.throws(
      () => require('fs').accessSync(path.join(root, 'hook-marker')),
      'pre-commit hook must not have run'
    );
  });

  await check('assertNoStagedSymlinks rejects a staged symlink', async () => {
    symlinkSync('/etc/passwd', path.join(root, 'src/content/evil'));
    await git.add(['src/content/evil']);
    let threw = null;
    try {
      await assertNoStagedSymlinks(git, ['src/content/']);
    } catch (error) {
      threw = error;
    }
    assert.ok(threw && /symlink/i.test(threw.message), 'expected a symlink rejection');
  });

  await check('assertNoStagedSymlinks passes for regular files only', async () => {
    // Reset the index to just the committed regular file.
    await git.raw(['rm', '--cached', 'src/content/evil']);
    await assertNoStagedSymlinks(git, ['src/content/']); // must not throw
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
