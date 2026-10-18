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
import { buildResultForEditor, publishFailureMessage } from '../server/api/publish.js';
import { runProductionBuildIn } from '../server/utils/build.js';
import { readJson, failureText } from '../ui/api-response.js';

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
  const message = publishFailureMessage(identityError);
  assert.match(message, /user\.name/, message);
  assert.match(message, /user\.email/, message);
  assert.ok(!message.includes(scratch), `server path leaked: ${message}`);
});

await check('any other error is a fixed message (git\'s text, paths, URLs: none of it is sent)', () => {
  // A path through a symlinked checkout, an external git directory, a
  // remote URL: each used to be rewritten, and each rewrite had a gap.
  const realSite = path.join(scratch, 'real-site');
  for (const error of [
    new Error(`fatal: could not read ${repo}/config: denied`),
    new Error(`fatal: Unable to create '${realSite}/.git/index.lock': File exists.\nerror: could not lock config file /srv/elsewhere/git-dirs/site.git/config: Permission denied`),
    new Error("fatal: unable to access 'https://git.example.com/site-a/site.git/': Could not resolve host"),
  ]) {
    assert.equal(publishFailureMessage(error), 'Publishing failed; see the server log.', error.message);
  }
});

await check('the editor shows the server\'s message, not just the error label', async () => {
  // The dashboard's real Publish click handler, extracted from ui/dashboard.js
  // (it boots on import) and run with its globals stubbed, answering the 500
  // body the publish route sends. A source check here passed with the toast
  // reduced to (result.error); this reads the notification it emits.
  const source = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
  const handler = source.match(/document\.getElementById\('publishBtn'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handler, 'the Publish click handler was not found in ui/dashboard.js');
  const serverMessage = publishFailureMessage(identityError);
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
      return new Response(JSON.stringify(body), { status: 500, headers: { 'Content-Type': 'application/json' } });
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
    readJson,
    failureText,
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

/** Run fn with console.error captured; returns [result, logged text]. */
async function withLog(fn) {
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    return [await fn(), logged.join('\n')];
  } finally {
    console.error = realError;
  }
}

await check('a real failed production build: a fixed error and the code sentence, the output only in the log', async () => {
  // A configured build command that fails the way Astro does, naming a file
  // under the project root and one in a sibling directory.
  const command = `node -e "console.error('[ImageNotFound] in ${repo}/src/pages/index.astro:3:1 and /srv/site,backup/x.md'); process.exit(1)"`;
  const [raw, logged] = await withLog(() => runProductionBuildIn({ build: { production: command } }, repo));
  assert.equal(raw.success, false, 'positive control: the build failed');
  assert.ok(logged.includes(`${repo}/src/pages/index.astro`) && logged.includes('/srv/site,backup'), `positive control: the output is in the log (${logged})`);
  const build = buildResultForEditor(raw);
  assert.deepEqual(build, {
    success: false,
    duration: raw.duration,
    error: 'The build command failed.',
    problems: [{ code: 'ImageNotFound', message: 'An image an entry uses was not found in the site.' }],
  });
  assert.ok(!JSON.stringify(build).includes(scratch), JSON.stringify(build));
});

await check('a production build result for the editor: status only', async () => {
  assert.deepEqual(buildResultForEditor({ success: true, duration: 5, output: `built ${repo}/dist` }), { success: true, duration: 5 });
  assert.deepEqual(buildResultForEditor({ success: false, duration: 5, output: 'Error: /srv/x', error: 'The build command failed.' }),
    { success: false, duration: 5, error: 'The build command failed.', problems: [{ code: null, message: "The site's build failed without naming an error; see the server log." }] });
  assert.equal(buildResultForEditor(null), null);
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
