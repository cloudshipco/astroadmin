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
import crypto from 'crypto';
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

/** Publish with nothing new to commit. */
async function publishNothingNew(checkout) {
  const fullConfig = { paths: { projectRoot: checkout }, build: { check: 'true' }, doctor: { enabled: false }, git: { allowLocalRemote: true } };
  return pushIfAstroAccepts(fullConfig, createGitClient(fullConfig), { commit: async () => null });
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

/**
 * The same, with a publish in between that is REFUSED after its fetch
 * (`mode`): 'local-changes' (the developer's commit changes a file the
 * checkout has an uncommitted change in) or 'conflict' (the editor's commit
 * clashes with the developer's). The fetch moved what the admin knows of the
 * upstream while the branch stayed on its old base; the record of the
 * upstream must not move until the branch is on it, or the next publish
 * finds no known base and replays the removed commit. Checked by file.
 */
async function refusedScenario(mode) {
  const root = fs.mkdtempSync(path.join(tempRoot, 'refused-'));
  const remote = path.join(root, 'remote.git');
  const checkout = path.join(root, 'checkout');
  const developer = path.join(root, 'developer');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  fs.mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  identity(checkout, 'Editor');
  writeFile(checkout, 'a.md', 'a\n');
  writeFile(checkout, 'shared.md', 'shared\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'initial');
  git(checkout, 'remote', 'add', 'origin', remote);
  git(checkout, 'push', '-q', '-u', 'origin', 'main');

  await check(`a publish refused for ${mode} does not let the next one bring a force-pushed-away commit back`, async () => {
    const mistake = await publish(checkout, 'mistake.md');
    assert.equal(mistake.pushed, true, `the mistake was published: ${JSON.stringify(mistake)}`);
    const mistakeCommit = git(remote, 'rev-parse', 'main');

    git(root, 'clone', '-q', remote, developer);
    identity(developer, 'Developer');
    git(developer, 'reset', '-q', '--hard', `${mistakeCommit}~1`);
    writeFile(developer, 'shared.md', 'developer\n');
    git(developer, 'add', '-A');
    git(developer, 'commit', '-qm', 'developer');
    git(developer, 'push', '-q', '--force', 'origin', 'main');

    if (mode === 'local-changes') {
      writeFile(checkout, 'shared.md', 'changed on the server\n');
      const refused = await publish(checkout, 'edit1.md');
      assert.equal(refused.localChanges, true, `refused for local changes: ${JSON.stringify(refused)}`);
      git(checkout, 'checkout', '--', 'shared.md');
    } else {
      const refused = await publish(checkout, 'shared.md');
      assert.equal(refused.conflict, true, `refused for a conflict: ${JSON.stringify(refused)}`);
      git(checkout, 'reset', '-q', '--hard', 'HEAD~1');
    }

    const edit = await publish(checkout, 'edit2.md');
    assert.equal(edit.pushed, true, `the edit was published: ${JSON.stringify(edit)}`);
    assert.ok(has(remote, 'main:edit2.md'), "the editor's commit is on the remote");
    assert.equal(git(remote, 'show', 'main:shared.md'), 'developer', "the developer's commit is underneath");
    assert.equal(has(remote, 'main:mistake.md'), false, `the removed commit came back: ${git(remote, 'log', '--format=%s', 'main')}`);
  });
}

/**
 * A known upstream value that reaches the editor's own commit must not be
 * taken as the base: it would replay nothing, drop the commit and still
 * report it pushed. Site code can write refs, so the admin's record (or the
 * tracking ref) can be made a symbolic ref to the branch itself, which
 * follows it to whatever the editor commits. `which` is 'record' or
 * 'tracking'. With `committedEarlier`, the editor's commit was made before
 * this publish (the commit route without autoPush, or a refused publish), so
 * this publish commits nothing and the symbolic ref already reaches it.
 */
async function symrefScenario(which, { committedEarlier = false } = {}) {
  const root = fs.mkdtempSync(path.join(tempRoot, 'symref-'));
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

  await check(`the ${which} ref made a symbolic ref to the branch does not drop the editor's commit${committedEarlier ? ' (committed earlier)' : ''}`, async () => {
    git(root, 'clone', '-q', remote, developer);
    identity(developer, 'Developer');
    writeFile(developer, 'developer.md', 'developer\n');
    git(developer, 'add', '-A');
    git(developer, 'commit', '-qm', 'developer');
    git(developer, 'push', '-q', 'origin', 'main');

    const recordName = `refs/astroadmin/upstream/${crypto.createHash('sha256').update('origin\0refs/heads/main').digest('hex').slice(0, 32)}`;
    git(checkout, 'symbolic-ref', which === 'record' ? recordName : 'refs/remotes/origin/main', 'refs/heads/main');

    if (committedEarlier) {
      writeFile(checkout, 'edit.md', 'edit\n');
      git(checkout, 'add', '--', 'edit.md');
      git(checkout, 'commit', '-qm', 'edit');
    }
    const edit = committedEarlier ? await publishNothingNew(checkout) : await publish(checkout, 'edit.md');
    assert.equal(edit.pushed, true, `the edit was published: ${JSON.stringify(edit)}`);
    assert.ok(has(remote, 'main:developer.md'), "the developer's commit is on the remote");
    assert.ok(has(remote, 'main:edit.md'), `the editor's commit was dropped: ${git(remote, 'log', '--format=%s', 'main')}`);
    assert.ok(has(checkout, 'HEAD:edit.md'), "the editor's commit is still on the checkout's branch");
  });
}

/**
 * A remote that pushes somewhere other than it fetches from (`how`:
 * 'pushurl', 'pushInsteadOf' on a named remote, or 'pushInsteadOf' on a URL
 * branch.<b>.remote) is refused before anything is committed: the pushed
 * commit never appears where the next publish fetches, so its rebase would
 * drop it from the branch.
 */
async function triangularScenario(how) {
  const root = fs.mkdtempSync(path.join(tempRoot, 'triangular-'));
  const fetchRemote = path.join(root, 'fetch.git');
  const pushRemote = path.join(root, 'push.git');
  const checkout = path.join(root, 'checkout');
  git(root, 'init', '-q', '--bare', '-b', 'main', fetchRemote);
  git(root, 'init', '-q', '--bare', '-b', 'main', pushRemote);
  fs.mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  identity(checkout, 'Editor');
  writeFile(checkout, 'a.md', 'a\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'initial');
  git(checkout, 'remote', 'add', 'origin', fetchRemote);
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  git(checkout, 'push', '-q', pushRemote, 'main');
  if (how === 'pushurl') git(checkout, 'config', 'remote.origin.pushurl', pushRemote);
  if (how.startsWith('pushInsteadOf')) git(checkout, 'config', `url.${pushRemote}.pushInsteadOf`, fetchRemote);
  if (how === 'pushInsteadOf, URL remote') git(checkout, 'config', 'branch.main.remote', fetchRemote);

  await check(`a remote that pushes elsewhere than it fetches (${how}) is refused before anything is committed`, async () => {
    const head = git(checkout, 'rev-parse', 'HEAD');
    const outcome = await publish(checkout, 'edit.md');
    assert.equal(outcome.blocked, true, JSON.stringify(outcome));
    assert.equal(outcome.blockedReason, 'remote');
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), head, 'nothing committed');
    assert.equal(git(pushRemote, 'rev-parse', 'main'), head, 'nothing pushed');
    assert.equal(git(fetchRemote, 'rev-parse', 'main'), head, 'nothing pushed');
  });
}

try {
  console.log('\n🧪 A force-pushed-away commit is not published again\n' + '='.repeat(40));
  await triangularScenario('pushurl');
  await triangularScenario('pushInsteadOf');
  await triangularScenario('pushInsteadOf, URL remote');
  await symrefScenario('record');
  await symrefScenario('tracking');
  await symrefScenario('record', { committedEarlier: true });
  await refusedScenario('local-changes');
  await refusedScenario('conflict');
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
