/**
 * What an editor is told when publishing fails outright (a 500, not the
 * publish check's 422). The first publish on a fresh machine or container
 * fails because git has no author identity; the editor used to see only
 * "Failed to publish: Failed to publish".
 *
 * The git error is real: a commit in a throwaway repo with HOME pointed at an
 * empty directory, no system config, and user.useConfigOnly, so git has no
 * user.name/user.email and may not guess one.
 *
 *   bun tests/publish-failure.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import simpleGit from 'simple-git';
import { publishFailureMessage } from '../server/api/publish.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-publish-failure-')));
const emptyHome = path.join(scratch, 'home');
const repo = path.join(scratch, 'site');
fs.mkdirSync(emptyHome);
fs.mkdirSync(repo);

for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}
process.env.HOME = emptyHome;
process.env.XDG_CONFIG_HOME = emptyHome;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.EMAIL = '';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${error.message}`);
  }
}

execFileSync('git', ['init', '-q', repo]);
// Without this, git on a machine with a resolvable hostname invents user@host and
// commits anyway; a container usually cannot, which is the case being tested.
execFileSync('git', ['-C', repo, 'config', 'user.useConfigOnly', 'true']);
fs.writeFileSync(path.join(repo, 'a.md'), 'hi\n');
const git = simpleGit(repo);
await git.add(['a.md']);
let identityError = null;
try {
  await git.commit('first');
} catch (error) {
  identityError = error;
}

await check('positive control: git really refuses to commit without an identity', () => {
  assert.ok(identityError, 'the commit succeeded, so this machine supplies an identity some other way');
  assert.match(identityError.message, /Author identity unknown|Please tell me who you are|unable to auto-detect email/i);
});

await check('the message tells the editor how to fix a missing git identity, naming no server path', () => {
  const message = publishFailureMessage(identityError, [repo, scratch]);
  assert.match(message, /user\.name/, message);
  assert.match(message, /user\.email/, message);
  assert.ok(!message.includes(scratch), `server path leaked: ${message}`);
});

await check('any other error keeps its text, with server paths stripped', () => {
  const message = publishFailureMessage(new Error(`fatal: could not read ${repo}/config: denied`), [repo]);
  assert.ok(message.includes('could not read'), message);
  assert.ok(!message.includes(repo), `server path leaked: ${message}`);
});

await check('a path through a symlinked checkout, or outside every configured root, is not named', () => {
  // The configured root is a symlink; git reports the resolved path.
  const realSite = path.join(scratch, 'real-site');
  const linkedSite = path.join(scratch, 'linked-site');
  fs.mkdirSync(realSite);
  fs.symlinkSync(realSite, linkedSite, 'dir');
  const external = '/srv/elsewhere/git-dirs/site.git';
  const message = publishFailureMessage(new Error(
    `fatal: Unable to create '${realSite}/.git/index.lock': File exists.\n`
    + `error: could not lock config file ${external}/config: Permission denied`
  ), [linkedSite]);
  assert.ok(message.includes('Unable to create'), `control: the git text is kept: ${message}`);
  assert.ok(message.includes('index.lock'), `control: the file name is kept: ${message}`);
  assert.ok(!message.includes(realSite), `resolved checkout path leaked: ${message}`);
  assert.ok(!message.includes(scratch), `server path leaked: ${message}`);
  assert.ok(!message.includes('/srv/elsewhere'), `external git directory leaked: ${message}`);
  assert.ok(!/(^|[\s'"(=:])\/[^\s'"()/]+\//m.test(message), `an absolute path survived: ${message}`);
});

await check('a remote URL in a push error is kept (the redaction is for server paths only)', () => {
  const message = publishFailureMessage(new Error('fatal: unable to access \'https://git.example.com/site-a/site.git/\': Could not resolve host'), []);
  assert.ok(message.includes('https://git.example.com/site-a/site.git/'), message);
});

await check('the editor shows the server\'s message, not just the error label', async () => {
  // The dashboard's real Publish click handler, extracted from ui/dashboard.js
  // (it boots on import) and run with its globals stubbed, answering the 500
  // body the publish route sends. A source check here passed with the toast
  // reduced to (result.error); this reads the notification it emits.
  const source = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
  const handler = source.match(/document\.getElementById\('publishBtn'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handler, 'the Publish click handler was not found in ui/dashboard.js');
  const serverMessage = publishFailureMessage(identityError, [repo, scratch]);
  const body = { success: false, error: 'Failed to publish', message: serverMessage };
  let click = null;
  const button = {
    textContent: 'Publish', disabled: false,
    addEventListener: (type, listener) => { if (type === 'click') click = listener; },
  };
  const notifications = [];
  const requests = [];
  const stubs = {
    document: { getElementById: (id) => (id === 'publishBtn' ? button : null), querySelector: () => null },
    window: { dispatchEvent() {} },
    CustomEvent: class { constructor(type) { this.type = type; } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { status: 500, json: async () => body };
    },
    showPublishDialog: async () => 'Content update',
    getCurrentPagePath: () => null,
    liveSiteHref: () => null,
    publicUrl: '',
    fetchLiveHash: async () => null,
    updateChangesBadge() {},
    showPublishStatus: () => ({ update() {} }),
    pollUntilLive() {},
    friendlyPublishMessage: () => 'published',
    showPublishProblems: () => notifications.push({ text: 'problems panel', type: 'panel' }),
    showNotification: (text, type) => notifications.push({ text, type }),
    console: { log() {}, warn() {}, error() {} },
  };
  new Function(...Object.keys(stubs), handler)(...Object.values(stubs));
  assert.ok(click, 'the handler registered a click listener');
  await click();
  assert.equal(requests.length, 1, 'positive control: the handler posted to the publish route');
  assert.equal(requests[0].url, '/api/publish');
  assert.equal(notifications.length, 1, JSON.stringify(notifications));
  assert.equal(notifications[0].type, 'error');
  assert.equal(notifications[0].text, `Failed to publish: ${serverMessage}`, notifications[0].text);
  assert.match(notifications[0].text, /user\.email/, 'the toast carries the fix');
  assert.equal(button.disabled, false, 'the button is re-enabled');
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
