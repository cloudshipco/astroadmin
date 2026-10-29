/**
 * Publish's production build (server/utils/build.js) runs the way the publish
 * check's build does (astro-check.js runCommand):
 *
 * - without the admin's own secrets and settings in its environment
 *   (`ASTROADMIN_*`, `ADMIN_*`, `SESSION_SECRET`): the check already removed
 *   them, the production build ran `build.production` with all of them;
 *   except ASTROADMIN_DB, which the shelved db store's loader reads (a site
 *   with a custom DB path built empty collections without it);
 * - with a time limit (`build.productionTimeoutMs`): a build that never ends
 *   is killed, its whole process group with it, and reported as failed,
 *   instead of holding Publish open forever.
 *
 * Real /bin/sh build scripts through runProductionBuildIn.
 *
 *   bun tests/production-build.test.js     (~2 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runProductionBuildIn } from '../server/utils/build.js';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-production-build-')));
const site = path.join(scratch, 'site');
fs.mkdirSync(site);

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

/** A `build.production` that runs `script` (written to a file) with /bin/sh. */
function buildCommand(name, script) {
  const file = path.join(scratch, `${name}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return `'${file}'`;
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

console.log('\n🧪 Publish\'s production build\n' + '='.repeat(40));

await check('the build does not see the admin\'s secrets and settings', async () => {
  const envFile = path.join(scratch, 'env.txt');
  process.env.SESSION_SECRET = 'session-secret-value';
  process.env.ADMIN_PASSWORD = 'admin-password-value';
  process.env.ASTROADMIN_PROJECT_ROOT = site;
  process.env.AA_ORDINARY_VARIABLE = 'ordinary-value';
  const command = buildCommand('env', `env > '${envFile}'`);
  const result = await runProductionBuildIn({ build: { production: command } }, site);
  assert.equal(result.success, true, JSON.stringify(result));
  const environment = fs.readFileSync(envFile, 'utf8');
  assert.ok(environment.includes('AA_ORDINARY_VARIABLE=ordinary-value'), 'positive control: the build has the environment');
  for (const name of ['SESSION_SECRET', 'ADMIN_PASSWORD', 'ASTROADMIN_PROJECT_ROOT']) {
    assert.ok(!new RegExp(`^${name}=`, 'm').test(environment), `${name} reached the build`);
  }
});

await check('the build sees ASTROADMIN_DB, the content store the site\'s loader reads', async () => {
  // A shelved-db-store site's loader (loader/index.js) reads ASTROADMIN_DB.
  // Stripped, a custom DB path built empty collections, and the deploy's
  // rsync --delete then removed the live pages.
  const envFile = path.join(scratch, 'env-db.txt');
  process.env.ASTROADMIN_DB = path.join(scratch, 'custom/content.db');
  process.env.ADMIN_PASSWORD = 'admin-password-value';
  const result = await runProductionBuildIn({ build: { production: buildCommand('env-db', `env > '${envFile}'`) } }, site);
  assert.equal(result.success, true, JSON.stringify(result));
  const environment = fs.readFileSync(envFile, 'utf8');
  assert.match(environment, new RegExp(`^ASTROADMIN_DB=${process.env.ASTROADMIN_DB}$`, 'm'));
  assert.ok(!/^ADMIN_PASSWORD=/m.test(environment), 'the secrets are still removed');
});

await check('a build that never ends is killed at the time limit, with its process group', async () => {
  const pidFile = path.join(scratch, 'child.pid');
  // A child in the background (still in the build's process group), then wait.
  const command = buildCommand('hang', `sleep 60 &\necho $! > '${pidFile}'\nwait`);
  const started = Date.now();
  const result = await runProductionBuildIn({ build: { production: command, productionTimeoutMs: 500 } }, site);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `settled after ${elapsed} ms`);
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(result.error, 'The build command did not finish in time.');
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(childPid > 0, 'positive control: the background child started');
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt++) {
    alive = isAlive(childPid);
    if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, `the build's child ${childPid} outlived the timeout`);
});

await check('a successful and a failing build report as before', async () => {
  const ok = await runProductionBuildIn({ build: { production: buildCommand('ok', 'echo built') } }, site);
  assert.equal(ok.success, true);
  assert.match(ok.output, /built/);
  const failed = await runProductionBuildIn({ build: { production: buildCommand('fail', 'echo broken >&2\nexit 3') } }, site);
  assert.equal(failed.success, false);
  assert.equal(failed.error, 'The build command failed.');
  assert.match(failed.output, /broken/);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(process.exitCode || 0);
