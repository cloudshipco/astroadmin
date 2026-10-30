/**
 * The admin's throwaway worktrees (the filter view, the rebase, the publish
 * check) clean up only after themselves (server/utils/throwaway-worktree.js),
 * and the filter view fails closed once it exists.
 *
 * 1. A person's stale worktree record (its directory is gone: a disk not
 *    mounted, a folder moved) survives a publish that rebases and checks.
 *    `git worktree prune`, which every one of them ran, dropped it.
 * 2. A record the admin left behind (its directory under the system
 *    temporary directory, named astroadmin-view-/-rebase-/-check-, gone) is
 *    removed; a record of ours whose directory still exists (another
 *    process's check in progress) is not.
 * 3. After a publish, none of the admin's worktrees remain registered.
 * 4. Config that only linked worktrees see and that git cannot read (an
 *    includeIf on the git directory naming a broken file) refuses the
 *    publish before anything is committed: the view exists, so whether a
 *    filter is in use could not be answered, and that is not a yes.
 *
 * pushIfAstroAccepts with a trivial check, against a local bare remote
 * (git.allowLocalRemote). ~3 s.
 *
 *   bun tests/publish-worktrees.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-publish-worktrees-')));
const cleanEnv = () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL') delete env[key];
  return env;
};
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const writeFile = (root, relativePath, content) => {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), content);
};

const { createGitClient, pushIfAstroAccepts } = await import('../server/api/publish.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
  }
}

const remote = path.join(tempRoot, 'remote.git');
const checkout = path.join(tempRoot, 'checkout');
const developer = path.join(tempRoot, 'developer');
const fullConfig = { paths: { projectRoot: checkout }, build: { check: 'test -f a.md' }, doctor: { enabled: false }, git: { allowLocalRemote: true } };
git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remote);
fs.mkdirSync(checkout);
git(checkout, 'init', '-q', '-b', 'main');
git(checkout, 'config', 'user.name', 'Editor');
git(checkout, 'config', 'user.email', 'editor@example.com');
writeFile(checkout, 'a.md', 'a\n');
git(checkout, 'add', '-A');
git(checkout, 'commit', '-qm', 'initial');
git(checkout, 'remote', 'add', 'origin', remote);
git(checkout, 'push', '-q', '-u', 'origin', 'main');
git(tempRoot, 'clone', '-q', remote, developer);
git(developer, 'config', 'user.name', 'Developer');
git(developer, 'config', 'user.email', 'developer@example.com');

const recordsDir = path.join(checkout, '.git', 'worktrees');
const records = () => (fs.existsSync(recordsDir) ? fs.readdirSync(recordsDir).sort() : []);
const recordPointingAt = (dir) => records().find((id) => fs.readFileSync(path.join(recordsDir, id, 'gitdir'), 'utf-8').trim().startsWith(dir));

/** The developer pushes, so the next publish rebases (a rebase worktree too). */
function developerPushes(name) {
  writeFile(developer, `${name}.md`, `${name}\n`);
  git(developer, 'add', '-A');
  git(developer, 'commit', '-qm', name);
  git(developer, 'pull', '-q', '--rebase');
  git(developer, 'push', '-q');
}
async function publish(file) {
  writeFile(checkout, file, `${file}\n`);
  const client = createGitClient(fullConfig);
  return pushIfAstroAccepts(fullConfig, client, {
    commit: async () => {
      await client.add(['--', file]);
      return client.commit(file, [file]);
    },
  });
}

try {
  console.log('\n🧪 Throwaway worktrees clean up only after themselves\n' + '='.repeat(40));

  // A person's worktree whose directory has gone (git calls it prunable).
  const foreignDir = path.join(tempRoot, 'elsewhere', 'feature');
  git(checkout, 'worktree', 'add', '-q', '--detach', foreignDir, 'HEAD');
  fs.rmSync(path.dirname(foreignDir), { recursive: true, force: true });
  // One the admin left behind (a process that stopped before cleaning up),
  // its directory since swept from the temporary directory.
  const leftover = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astroadmin-rebase-')));
  git(checkout, 'worktree', 'add', '-q', '--detach', path.join(leftover, 'worktree'), 'HEAD');
  fs.rmSync(leftover, { recursive: true, force: true });
  // One of ours whose directory still exists: another process's, in use.
  const inUse = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astroadmin-check-')));
  git(checkout, 'worktree', 'add', '-q', '--detach', path.join(inUse, 'worktree'), 'HEAD');

  await check('control: the three records are registered before the publish', async () => {
    assert.ok(recordPointingAt(foreignDir), records().join(', '));
    assert.ok(recordPointingAt(leftover), records().join(', '));
    assert.ok(recordPointingAt(inUse), records().join(', '));
    assert.equal(records().length, 3, records().join(', '));
  });

  developerPushes('developer');
  const before = records();
  const outcome = await publish('edit.md');

  await check('control: the publish rebased, checked and pushed', async () => {
    assert.equal(outcome.pushed, true, JSON.stringify(outcome));
    assert.equal(git(remote, 'show', 'main:edit.md'), 'edit.md');
    assert.equal(git(remote, 'show', 'main:developer.md'), 'developer');
  });

  await check("a person's stale worktree record survives the publish", async () => {
    assert.ok(recordPointingAt(foreignDir), `gone: ${before.join(', ')} -> ${records().join(', ')}`);
  });

  await check("the record of the admin's own leftover worktree is removed", async () => {
    assert.equal(recordPointingAt(leftover), undefined, records().join(', '));
  });

  await check("a worktree of the admin's still on disk is left alone (another process may be using it)", async () => {
    assert.ok(fs.existsSync(path.join(inUse, 'worktree', 'a.md')));
    assert.ok(recordPointingAt(inUse), records().join(', '));
  });

  await check('none of the worktrees the publish added is still registered', async () => {
    const listing = git(checkout, 'worktree', 'list', '--porcelain');
    const ours = listing.split('\n').filter((line) => line.startsWith('worktree ') && /astroadmin-(view|rebase|check)-/.test(line) && !line.includes(path.basename(inUse)));
    assert.deepEqual(ours, []);
    assert.equal(records().length, 2, records().join(', '));
  });
  git(checkout, 'worktree', 'remove', '--force', path.join(inUse, 'worktree'));
  fs.rmSync(inUse, { recursive: true, force: true });

  // Config only linked worktrees see, which git cannot read.
  const brokenInclude = path.join(tempRoot, 'worktree-only.config');
  writeFile(tempRoot, 'worktree-only.config', '[broken\n');
  git(checkout, 'config', 'includeIf.gitdir:**/worktrees/**.path', brokenInclude);
  await check("control: the checkout itself reads its config (only linked worktrees see the broken file)", async () => {
    assert.equal(git(checkout, 'config', 'user.name'), 'Editor');
  });
  await check('config only linked worktrees see and git cannot read refuses the publish before anything is committed', async () => {
    developerPushes('developer-2');
    const headBefore = git(checkout, 'rev-parse', 'HEAD');
    const remoteBefore = git(remote, 'rev-parse', 'main');
    let outcome2 = null;
    let thrown = null;
    try {
      outcome2 = await publish('refused.md');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown || outcome2?.blocked, `refused: ${JSON.stringify(outcome2)}`);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), headBefore, 'nothing committed');
    assert.equal(git(remote, 'rev-parse', 'main'), remoteBefore, 'nothing pushed');
    assert.deepEqual(records(), [recordPointingAt(foreignDir)], `no worktree of ours left: ${records().join(', ')}`);
  });
  git(checkout, 'config', '--unset', 'includeIf.gitdir:**/worktrees/**.path');

  console.log(`\n📊 ${passed} passed, ${failed} failed.`);
} catch (error) {
  console.error(error);
  failed++;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.exitCode = failed > 0 ? 1 : 0;
