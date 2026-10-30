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
 *   instead of holding Publish open forever;
 * - leaving nothing running: when the build exits, what it started in its
 *   process group is killed (a daemon used to outlive it, and one holding
 *   the output pipe held a finished build open until the time limit), and a
 *   descendant that left the group is waited for two seconds at most;
 * - with output past the 10 MB cap keeping its start AND its end, where a
 *   build prints its error;
 * - with UTF-8 decoded across chunks (a character split between two writes
 *   came out as two U+FFFD), and the cap never cutting a character in half.
 *
 * Real /bin/sh build scripts through runProductionBuildIn.
 *
 *   bun tests/production-build.test.js     (~6 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runProductionBuildIn } from '../server/utils/build.js';
import { cappedOutput } from '../server/utils/astro-check.js';

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

/** Wait up to a second for `pid` to be gone; return whether it still lives. */
async function stillAliveAfterWaiting(pid) {
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt++) {
    alive = isAlive(pid);
    if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return alive;
}

await check('a child a build leaves running is killed when the build exits', async () => {
  // A build that starts a daemon (here a sleep with its output elsewhere)
  // and exits 0 used to leave it running for good.
  const pidFile = path.join(scratch, 'daemon.pid');
  const command = buildCommand('daemon', `sleep 60 > /dev/null 2>&1 &\necho $! > '${pidFile}'\necho built`);
  const result = await runProductionBuildIn({ build: { production: command } }, site);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.match(result.output, /built/, 'the output was collected');
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(childPid > 0, 'positive control: the daemon started');
  assert.equal(await stillAliveAfterWaiting(childPid), false, `the build's child ${childPid} outlived the build`);
});

await check('a child holding the output pipe does not hold a finished build open', async () => {
  // Its stdout is the build's: the pipe stays open while it lives, so the
  // build waited for the time limit and was reported as timed out.
  const pidFile = path.join(scratch, 'holder.pid');
  const command = buildCommand('holder', `sleep 60 &\necho $! > '${pidFile}'\necho built`);
  const started = Date.now();
  const result = await runProductionBuildIn({ build: { production: command, productionTimeoutMs: 20000 } }, site);
  const elapsed = Date.now() - started;
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(elapsed < 10000, `settled after ${elapsed} ms`);
  assert.match(result.output, /built/);
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.equal(await stillAliveAfterWaiting(childPid), false, `the build's child ${childPid} outlived the build`);
});

await check('a descendant that left the process group holds a finished build for two seconds at most', async () => {
  // setsid: out of reach of the group kill, still holding the output pipe.
  const pidFile = path.join(scratch, 'setsid.pid');
  const readyFile = path.join(scratch, 'setsid.ready');
  // The shell waits until the child has left the group, or the group kill
  // would race its setsid().
  const command = buildCommand('setsid', `perl -MPOSIX -e 'POSIX::setsid() or die; open(my $f, ">", $ARGV[0]); close($f); sleep 30' '${readyFile}' &\necho $! > '${pidFile}'\nwhile [ ! -e '${readyFile}' ]; do sleep 0.05; done\necho built`);
  const started = Date.now();
  const result = await runProductionBuildIn({ build: { production: command, productionTimeoutMs: 20000 } }, site);
  const elapsed = Date.now() - started;
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  try {
    assert.ok(isAlive(childPid), 'positive control: it survived the group kill');
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(elapsed >= 1500 && elapsed < 6000, `settled after ${elapsed} ms`);
    assert.match(result.output, /built/);
  } finally {
    try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ }
  }
});

await check('a build whose output passes the cap keeps its start and its end', async () => {
  // Astro prints the error that matters LAST; keeping only the first 10 MB
  // lost it behind a long log.
  const command = buildCommand('long', `echo FIRST-LINE\nhead -c 12000000 /dev/zero | tr '\\0' 'x'\necho\necho THE-ERROR-AT-THE-END >&2\nexit 1`);
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await runProductionBuildIn({ build: { production: command } }, site);
  } finally {
    console.error = originalError;
  }
  assert.equal(result.success, false);
  assert.match(result.output, /^FIRST-LINE/, 'the start');
  assert.match(result.output, /THE-ERROR-AT-THE-END\n?$/, 'the end');
  assert.match(result.output, /characters of output left out/, 'says what was left out');
  assert.ok(result.output.length <= 10 * 1024 * 1024 + 200, `${result.output.length} characters`);
});

await check('a character split between two writes is decoded whole', async () => {
  // printf with octal escapes: /bin/sh's printf may not know \x.
  const command = buildCommand('split-utf8', "printf '\\342\\202'; sleep 0.2; printf '\\254 euro\\n'; printf '\\342\\202' >&2; sleep 0.2; printf '\\254 stderr\\n' >&2");
  const result = await runProductionBuildIn({ build: { production: command } }, site);
  assert.equal(result.success, true, result.output);
  assert.ok(result.output.includes('\u20ac euro'), JSON.stringify(result.output));
  assert.ok(result.output.includes('\u20ac stderr'), JSON.stringify(result.output));
  assert.ok(!result.output.includes('\ufffd'), JSON.stringify(result.output));
});

await check('the output cap never splits a surrogate pair', () => {
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const prefix of ['', 'a']) {
    for (const suffix of ['', 'b']) {
      for (const maxLength of [10, 11, 12, 13]) {
        const output = cappedOutput(maxLength);
        output.add(prefix + '\u{1F600}'.repeat(5));
        output.add('\u{1F600}'.repeat(20) + suffix);
        const text = output.text();
        assert.ok(!loneSurrogate.test(text), `${JSON.stringify({ prefix, suffix, maxLength })}: ${JSON.stringify(text)}`);
        assert.match(text, /characters of output left out/, 'positive control: the cap applied');
      }
    }
  }
  // A head stopped short of a pair takes nothing that came after it.
  const short = cappedOutput(10);
  short.add('aaaa\u{1F600}');
  short.add('b');
  assert.equal(short.text(), 'aaaa\u{1F600}b');
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
