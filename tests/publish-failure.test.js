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

await check('the editor shows the server\'s message, not just the error label', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
  assert.ok(!source.includes("'Failed to publish: ' + result.error"), 'the publish toast still shows only result.error');
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
