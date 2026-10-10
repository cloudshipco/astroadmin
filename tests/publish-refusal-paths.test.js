/**
 * The publish check's 422 refusal names no server path, even for a path the
 * check does not know.
 *
 * checkHeadWithAstro removes only the directories it knows (the project, the
 * repo top, its temp worktree). A site whose git directory lives elsewhere
 * (`git init --separate-git-dir`, a bare store under /srv) failing to add the
 * check's worktree answers `fatal: could not create directory of
 * '/srv/git-store/site.git/worktrees/worktree'`: a path outside every known
 * directory, so the whole output is replaced by a fixed message and git's
 * text goes to the server log. The failure here is real: the external git
 * directory's worktrees/ folder is read-only.
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

const { publishHandler, checkRefusalBody, publishFailureMessage } = await import('../server/api/publish.js');
const { HIDDEN_OUTPUT_MESSAGE } = await import('../server/utils/redact-server-paths.js');

// The server log: what the app writes, kept for the positive controls.
const serverLog = [];
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    serverLog.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(' '));
  };
}
const report = (line) => process.stdout.write(`${line}\n`);
function assertLogged(mark, ...fragments) {
  const logged = serverLog.slice(mark).join('\n');
  for (const fragment of fragments) {
    assert.ok(logged.includes(fragment), `positive control: the server log has the original (${fragment}); it has:\n${logged.slice(0, 2000)}`);
  }
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    report(`✅ ${name}`);
  } catch (error) {
    report(`❌ ${name}\n   ${error.stack || error.message}`);
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

const SERVER_PATH_SIGNS = [scratch, 'aa-publish-refusal-paths-', 'git-store', 'site.git', 'repo.git', 'git store', 'other place', 'site b', os.tmpdir(), fs.realpathSync(os.tmpdir()), '/private/', '/var/folders/', '/srv/'];
function assertNoServerPath(label, text) {
  for (const sign of SERVER_PATH_SIGNS) {
    assert.equal(text.includes(sign), false, `${label} names a server path (${sign}): ${text}`);
  }
}

try {
  report('\n🧪 publish refusals name no server path\n' + '='.repeat(40));

  await check('a worktree the external git directory refuses: the 422 carries the fixed message', async () => {
    const mark = serverLog.length;
    const res = jsonResponse();
    await publishHandler({ body: { message: 'Edit home' } }, res);
    // Positive controls: the check really ran and refused, for this reason,
    // and the server log has git's own words naming the external directory.
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
    assert.equal(res.body.committed, true, 'the commit happened first');
    assert.equal(res.body.pushed, false);
    assertLogged(mark, externalGitDir);
    assert.match(serverLog.slice(mark).join('\n'), /could not create|Permission denied/i, 'the git failure is in the log');
    assert.equal(res.body.check.output, HIDDEN_OUTPUT_MESSAGE);
    assertNoServerPath('the 422 body', JSON.stringify(res.body));
  });

  await check('checkRefusalBody: output that still names a server path is replaced (the last stop)', async () => {
    const output = `fatal: could not create '/srv/git-store/repo.git/worktrees/check' and '${scratch}/x/y'`;
    const mark = serverLog.length;
    const body = await checkRefusalBody({ commit: 'abc1234', output, entries: [] });
    assert.equal(body.check.output, HIDDEN_OUTPUT_MESSAGE);
    assertLogged(mark, output);
    assertNoServerPath('checkRefusalBody', JSON.stringify(body));
  });

  // An external path with a space in it was cut at the space: the old
  // redactor reduced `/srv/git` to `git` and left ` store/repo.git/...`.
  await check('checkRefusalBody: quoted external paths with spaces are replaced whole', async () => {
    const output = `fatal: could not create '/srv/git store/repo.git/worktrees/check': Permission denied\n`
      + 'error: unable to read "/srv/other place/site b/x.lock"';
    const mark = serverLog.length;
    const body = await checkRefusalBody({ commit: 'abc1234', output, entries: [] });
    assert.equal(body.check.output, HIDDEN_OUTPUT_MESSAGE);
    assertLogged(mark, output);
    assertNoServerPath('checkRefusalBody', JSON.stringify(body));
  });

  await check("checkRefusalBody: Astro's message is kept, quoted page paths and URLs too", async () => {
    const output = '[InvalidContentEntryDataError] pages → home data does not match collection schema.\n'
      + "  link: Invalid enum value. Expected '/about' | '/blog/[slug]', received '/contact'\n"
      + '  see https://docs.astro.build/en/reference/errors/?q=/blog/x';
    const mark = serverLog.length;
    const body = await checkRefusalBody({ commit: 'abc1234', output, entries: [{ collection: 'pages', slug: 'home' }] });
    assert.equal(body.check.output, output);
    assert.deepEqual(body.check.entries.map(({ collection, slug }) => ({ collection, slug })), [{ collection: 'pages', slug: 'home' }]);
    assert.equal(serverLog.slice(mark).join('\n').includes('named a server path'), false, 'nothing was hidden');
  });

  await check('publishFailureMessage: anything but a missing identity is a fixed message', async () => {
    const message = publishFailureMessage(new Error("fatal: Unable to create '/srv/git store/repo.git/index.lock': File exists."));
    assert.equal(message, 'Publishing failed; see the server log.');
  });

  report('='.repeat(40));
  report(`\n📊 ${passed} checks passed.\n`);
} finally {
  // `git worktree prune` removes the (empty) folder itself.
  if (fs.existsSync(worktreesDir)) fs.chmodSync(worktreesDir, 0o755);
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
