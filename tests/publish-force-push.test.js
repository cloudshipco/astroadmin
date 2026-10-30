/**
 * A commit that was published and then force-pushed away upstream is not
 * brought back by the next publish's rebase, however the branch's upstream
 * is configured.
 *
 * The rebase replays only the commits after the last upstream commit the
 * checkout is known to be based on. `git pull --rebase` (and the first
 * worktree rebase) found that through the remote-tracking ref's reflog
 * (--fork-point), which does not exist when `branch.<b>.remote` is a URL,
 * when the remote's fetch refspec does not map the branch, or when the
 * reflog is gone; each then fell back to the merge-base and replayed the
 * removed commit, and the push put it back.
 *
 * Each scenario: the checkout publishes a commit (the mistake); a
 * developer force-pushes it away and pushes their own work; the editor
 * commits and publishes again. The remote must have the developer's and
 * the editor's work, and not the mistake. pushIfAstroAccepts with a
 * trivial check, against a local bare remote (git.allowLocalRemote). ~5 s.
 *
 *   bun tests/publish-force-push.test.js
 */

import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-force-push-')));
const cleanEnv = () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL') delete env[key];
  return env;
};
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8', env: cleanEnv() }).trim();
const has = (cwd, spec) => spawnSync('/usr/bin/git', ['cat-file', '-e', spec], { cwd, env: cleanEnv() }).status === 0;
const identity = (dir, name) => {
  git(dir, 'config', 'user.name', name);
  git(dir, 'config', 'user.email', `${name.toLowerCase()}@example.com`);
};
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

/** Commit `file` in the checkout and publish it as the editor's routes do. */
async function publish(checkout, file) {
  const fullConfig = { paths: { projectRoot: checkout }, build: { check: 'true' }, doctor: { enabled: false }, git: { allowLocalRemote: true } };
  writeFile(checkout, file, `${file}\n`);
  const client = createGitClient(fullConfig);
  return pushIfAstroAccepts(fullConfig, client, {
    commit: async () => {
      await client.add(['--', file]);
      return client.commit(file, [file]);
    },
  });
}

async function scenario(name, configure) {
  const root = fs.mkdtempSync(path.join(tempRoot, 'scenario-'));
  const remote = path.join(root, 'remote.git');
  const checkout = path.join(root, 'checkout');
  const developer = path.join(root, 'developer');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  fs.mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  identity(checkout, 'Editor');
  writeFile(checkout, 'a.md', 'a\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'initial');
  git(checkout, 'remote', 'add', 'origin', remote);
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  await configure({ checkout, remote });

  await check(`${name}: a published commit force-pushed away stays away`, async () => {
    const mistake = await publish(checkout, 'mistake.md');
    assert.equal(mistake.pushed, true, `the mistake was published: ${JSON.stringify(mistake)}`);
    const mistakeCommit = git(remote, 'rev-parse', 'main');

    git(root, 'clone', '-q', remote, developer);
    identity(developer, 'Developer');
    git(developer, 'reset', '-q', '--hard', `${mistakeCommit}~1`);
    writeFile(developer, 'developer.md', 'developer\n');
    git(developer, 'add', '-A');
    git(developer, 'commit', '-qm', 'developer');
    git(developer, 'push', '-q', '--force', 'origin', 'main');

    const edit = await publish(checkout, 'edit.md');
    assert.equal(edit.pushed, true, `the edit was published: ${JSON.stringify(edit)}`);
    assert.ok(has(remote, 'main:edit.md'), "the editor's commit is on the remote");
    assert.ok(has(remote, 'main:developer.md'), "the developer's commit is underneath");
    assert.equal(has(remote, 'main:mistake.md'), false, `the removed commit came back: ${git(remote, 'log', '--format=%s', 'main')}`);
  });
}

try {
  console.log('\n🧪 A force-pushed-away commit is not published again\n' + '='.repeat(40));
  await scenario('a named remote with the default refspec (control)', () => {});
  await scenario('branch.main.remote is a URL', ({ checkout, remote }) => {
    git(checkout, 'config', 'branch.main.remote', remote);
  });
  await scenario("the remote's fetch refspec does not map the branch", ({ checkout }) => {
    git(checkout, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other');
  });
  await scenario('no reflog is kept', ({ checkout }) => {
    git(checkout, 'config', 'core.logAllRefUpdates', 'false');
    git(checkout, 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all');
    fs.rmSync(path.join(checkout, '.git/logs'), { recursive: true, force: true });
  });
  console.log(`\n📊 ${passed} passed, ${failed} failed.`);
} catch (error) {
  console.error(error);
  failed++;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.exitCode = failed > 0 ? 1 : 0;
