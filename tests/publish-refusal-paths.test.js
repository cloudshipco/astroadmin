/**
 * The publish check's 422 refusal names no server path, even for a path the
 * check did not know to strip.
 *
 * checkHeadWithAstro made its known directories (the project, the repo top,
 * its temp dir) relative and nothing else, and checkRefusalBody forwarded the
 * output as it was. A site whose git directory lives elsewhere
 * (`git init --separate-git-dir`, a bare store under /srv) failing to add the
 * check's worktree answered `fatal: could not create directory of
 * '/srv/git-store/site.git/worktrees/worktree'`. The failure here is real: the
 * external git directory's worktrees/ folder is read-only.
 *
 * Runs the real publishHandler with git enabled (no remote: the pull and push
 * are skipped, the commit and the check are not).
 *
 *   bun tests/publish-refusal-paths.test.js     (~2 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-publish-refusal-paths-')));
const projectRoot = path.join(scratch, 'site');
const externalGitDir = path.join(scratch, 'git-store', 'site.git');
fs.mkdirSync(projectRoot);
fs.mkdirSync(path.dirname(externalGitDir));

for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
delete process.env.ASTROADMIN_CONTENT_STORE;

const gitIn = (...args) => execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf-8' });
execFileSync('git', ['init', '-q', '--separate-git-dir', externalGitDir, projectRoot]);
gitIn('config', 'user.name', 'Test');
gitIn('config', 'user.email', 'test@example.com');
fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
fs.mkdirSync(path.join(projectRoot, 'src/content/pages'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'src/content/pages/home.md'), '---\ntitle: Home\n---\n');
gitIn('add', '-A');
gitIn('commit', '-q', '-m', 'first');
fs.writeFileSync(path.join(projectRoot, 'src/content/pages/home.md'), '---\ntitle: Home again\n---\n');

const worktreesDir = path.join(externalGitDir, 'worktrees');
fs.mkdirSync(worktreesDir);
fs.chmodSync(worktreesDir, 0o555);

const { publishHandler, checkRefusalBody } = await import('../server/api/publish.js');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function jsonResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const SERVER_PATH_SIGNS = [scratch, os.tmpdir(), fs.realpathSync(os.tmpdir()), '/private/', '/var/folders/', '/srv/'];
function assertNoServerPath(label, text) {
  for (const sign of SERVER_PATH_SIGNS) {
    assert.equal(text.includes(sign), false, `${label} names a server path (${sign}): ${text}`);
  }
}

try {
  console.log('\n🧪 publish refusals name no server path\n' + '='.repeat(40));

  await check('a worktree the external git directory refuses: a 422 that names no server path', async () => {
    const res = jsonResponse();
    await publishHandler({ body: { message: 'Edit home' } }, res);
    // Positive controls: the check really ran and refused, for this reason.
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
    assert.equal(res.body.committed, true, 'the commit happened first');
    assert.equal(res.body.pushed, false);
    assert.match(res.body.check.output, /worktrees|could not create|Permission denied/i, `the git failure is reported: ${res.body.check.output}`);
    assertNoServerPath('the 422 body', JSON.stringify(res.body));
  });

  await check('checkRefusalBody redacts output that reaches it unredacted', async () => {
    const body = await checkRefusalBody({
      commit: 'abc1234',
      output: `fatal: could not create '/srv/git-store/repo.git/worktrees/check' and '${scratch}/x/y'`,
      entries: [],
    });
    assert.match(body.check.output, /fatal: could not create/, 'control: the message is kept');
    assert.match(body.check.output, /'check'/, 'the path is reduced to its last segment');
    assertNoServerPath('checkRefusalBody', JSON.stringify(body));
  });

  // An external path with a space in it was cut at the space: the redactor
  // reduced `/srv/git` to `git` and left ` store/repo.git/worktrees/check`,
  // naming the directories below it.
  await check('checkRefusalBody: a quoted external path with spaces is reduced whole', async () => {
    const body = await checkRefusalBody({
      commit: 'abc1234',
      output: `fatal: could not create '/srv/git store/repo.git/worktrees/check': Permission denied\n`
        + `error: unable to read "/srv/other place/site b/x.lock"`,
      entries: [],
    });
    const output = body.check.output;
    assert.match(output, /fatal: could not create 'check': Permission denied/, `control: the message and file name are kept: ${output}`);
    assert.match(output, /unable to read "x\.lock"/, `control: a double-quoted path keeps its file name: ${output}`);
    for (const fragment of ['git store', 'repo.git', 'worktrees/', 'other place', 'site b', '/srv']) {
      assert.equal(output.includes(fragment), false, `names a server directory (${fragment}): ${output}`);
    }
  });

  await check('publishFailureMessage: a quoted path with spaces is reduced whole', async () => {
    const { publishFailureMessage } = await import('../server/api/publish.js');
    const message = publishFailureMessage(new Error("fatal: Unable to create '/srv/git store/repo.git/index.lock': File exists."));
    assert.match(message, /Unable to create 'index\.lock': File exists\./, `control: the git text is kept: ${message}`);
    for (const fragment of ['git store', 'repo.git', '/srv']) {
      assert.equal(message.includes(fragment), false, `names a server directory (${fragment}): ${message}`);
    }
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  // `git worktree prune` removes the (empty) folder itself.
  if (fs.existsSync(worktreesDir)) fs.chmodSync(worktreesDir, 0o755);
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
