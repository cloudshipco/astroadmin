/**
 * Deploy adapter registry and the rsync adapter.
 *
 * The rsync adapter runs `rsync -av --delete`, so validation refuses a
 * destination where that would destroy something (#10): the filesystem
 * root, the home directory and above, the project and above, inside the
 * project, the build output and inside it, locally as written and through
 * symlinks; and `/`, the remote home and above for a host. Each refusal is
 * our sentence naming no path, with `allowDestructivePath: true` as the
 * override and an ordinary destination as the positive control. The ssh key
 * path and port reach ssh as single arguments: real rsync runs a fake `ssh`
 * first on PATH that records its argv (an unquoted key path with a space
 * was split in two, and one with a quote stopped rsync starting ssh).
 *
 *   bun tests/deploy.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deploy, validateDeployConfig } from '../server/utils/deploy.js';

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

console.log('\n🧪 Deploy adapter registry\n' + '='.repeat(40));

await check('validate: no adapter is valid', () => {
  assert.deepEqual(validateDeployConfig({ adapter: null }), { valid: true, errors: [] });
  assert.deepEqual(validateDeployConfig({}), { valid: true, errors: [] });
});

await check('validate: rsync requires path', () => {
  const result = validateDeployConfig({ adapter: 'rsync', rsync: {} });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('path')), 'mentions path');
});

await check('validate: rsync remote requires user', () => {
  const result = validateDeployConfig({ adapter: 'rsync', rsync: { path: '/srv', host: 'h' } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('user')), 'mentions user');
});

await check('validate: valid local rsync', () => {
  assert.deepEqual(
    validateDeployConfig({ adapter: 'rsync', rsync: { path: '/srv/www' } }),
    { valid: true, errors: [] }
  );
});

await check('validate: unknown adapter is rejected', () => {
  const result = validateDeployConfig({ adapter: 'bogus' });
  assert.equal(result.valid, false);
  assert.ok(result.errors[0].includes('Unknown deploy adapter'), 'names the problem');
});

await check('deploy: no adapter is a no-op skip', async () => {
  const result = await deploy({ adapter: null }, '/tmp');
  assert.equal(result.success, true);
  assert.equal(result.skipped, true);
});

await check('deploy: local rsync dry-run', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-deploy-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-dest-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'dist', 'index.html'), '<h1>hi</h1>');

    const result = await deploy(
      { adapter: 'rsync', rsync: { path: dest, dryRun: true } },
      projectRoot,
      { log: () => {} }
    );

    assert.equal(result.success, true, 'dry-run succeeds');
    assert.equal(result.dryRun, true, 'dry-run flagged');
    assert.equal(result.local, true, 'local deploy');
    assert.equal(result.adapter, 'rsync', 'adapter name attached');
    // dry-run must not actually copy anything
    assert.equal(fs.existsSync(path.join(dest, 'index.html')), false, 'nothing copied');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

// --- #10: destinations `rsync --delete` must never be pointed at -----------

const guardRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-deploy-guard-')));
const guardProject = path.join(guardRoot, 'site');
fs.mkdirSync(path.join(guardProject, 'dist'), { recursive: true });
const guardContext = { projectRoot: guardProject, distDir: 'dist' };
const home = os.homedir();

/** validate() for a local rsync destination, as Publish calls it. */
const validateLocal = (destination, extra = {}) =>
  validateDeployConfig({ adapter: 'rsync', rsync: { path: destination, ...extra } }, guardContext);

const REFUSED_LOCAL = {
  'the filesystem root': '/',
  'the filesystem root, spelled oddly': '/./',
  'the home directory': home,
  'the home directory with a trailing slash': `${home}/`,
  'an ancestor of the home directory': path.dirname(home),
  'the project root': guardProject,
  'the project root, relative': '.',
  'an ancestor of the project root': guardRoot,
  'an ancestor of the project root, relative': '..',
  'the build output itself': path.join(guardProject, 'dist'),
  'the build output, relative': 'dist',
  'inside the build output': path.join(guardProject, 'dist/www'),
  'inside the project (its own files)': path.join(guardProject, 'src'),
};
for (const [label, destination] of Object.entries(REFUSED_LOCAL)) {
  await check(`validate: refuses ${label} (${destination})`, () => {
    const result = validateLocal(destination);
    assert.equal(result.valid, false, `${destination} accepted`);
    assert.ok(result.errors.some((error) => /--delete/.test(error) && /allowDestructivePath/.test(error)), result.errors.join('\n'));
    // Our sentence, never the path (the errors reach the editor).
    assert.ok(result.errors.every((error) => !error.includes(guardRoot) && !error.includes(home)), result.errors.join('\n'));
  });
}

await check('validate: refuses an ancestor of the project root reached through a symlink', () => {
  const link = path.join(guardRoot, 'link-to-root');
  fs.symlinkSync(guardRoot, link);
  assert.equal(validateLocal(link).valid, false);
  assert.equal(validateLocal(`${link}/site`).valid, false, 'the project through a link');
});

await check('validate: a destination beside the project is accepted (positive control)', () => {
  assert.deepEqual(validateLocal(path.join(guardRoot, 'www')), { valid: true, errors: [] });
  assert.deepEqual(validateLocal('../www'), { valid: true, errors: [] }, 'relative to the project, as rsync resolves it');
});

await check('validate: allowDestructivePath accepts a refused destination', () => {
  assert.deepEqual(validateLocal(guardProject, { allowDestructivePath: true }), { valid: true, errors: [] });
  assert.equal(validateLocal(guardProject, { allowDestructivePath: 'yes' }).valid, false, 'only the boolean true');
});

const REFUSED_REMOTE = ['/', '//', '~', '~/', '.', './', '', '..', '~/..', 'www/../..'];
for (const destination of REFUSED_REMOTE) {
  await check(`validate: a remote destination of ${JSON.stringify(destination)} is refused`, () => {
    const result = validateDeployConfig({ adapter: 'rsync', rsync: { host: 'h', user: 'u', path: destination } }, guardContext);
    assert.equal(result.valid, false);
  });
}

await check('validate: an ordinary remote destination is accepted (positive control)', () => {
  for (const destination of ['/var/www/site-a', 'www', '~/www']) {
    assert.deepEqual(validateDeployConfig({ adapter: 'rsync', rsync: { host: 'h', user: 'u', path: destination } }, guardContext), { valid: true, errors: [] }, destination);
  }
});

await check('deploy: refuses a destructive destination without calling rsync', async () => {
  fs.writeFileSync(path.join(guardProject, 'keep.txt'), 'keep\n');
  await assert.rejects(
    () => deploy({ adapter: 'rsync', rsync: { path: guardProject } }, guardProject, { log: () => {} }),
    /allowDestructivePath/,
  );
  assert.equal(fs.readFileSync(path.join(guardProject, 'keep.txt'), 'utf8'), 'keep\n');
});

/**
 * Run a remote deploy with a fake `ssh` first on PATH that records the
 * arguments rsync gives it. Returns them, one per element.
 */
async function sshArgumentsFor(rsyncConfig) {
  const bin = fs.mkdtempSync(path.join(guardRoot, 'bin-'));
  const record = path.join(bin, 'args.txt');
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${record}'\nexit 255\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    await assert.rejects(() => deploy({ adapter: 'rsync', rsync: { host: 'example.com', user: 'deploy', path: '/srv/www', ...rsyncConfig } }, guardProject, { log: () => {} }));
  } finally {
    process.env.PATH = originalPath;
  }
  assert.ok(fs.existsSync(record), 'positive control: rsync ran the fake ssh');
  return fs.readFileSync(record, 'utf8').split('\n').slice(0, -1);
}

const originalStderrWrite = process.stderr.write.bind(process.stderr);
for (const keyPath of [path.join(guardRoot, 'my keys/deploy key'), path.join(guardRoot, "it's/key"), path.join(guardRoot, 'plain/key')]) {
  await check(`deploy: the ssh key path reaches ssh as one argument (${path.basename(path.dirname(keyPath))}/${path.basename(keyPath)})`, async () => {
    process.stderr.write = () => true; // rsync's complaint about the fake ssh
    let args;
    try {
      args = await sshArgumentsFor({ keyPath, port: 2222 });
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    const keyIndex = args.indexOf('-i');
    assert.ok(keyIndex >= 0, args.join(' | '));
    assert.equal(args[keyIndex + 1], keyPath, args.join(' | '));
    assert.equal(args[args.indexOf('-p') + 1], '2222', args.join(' | '));
  });
}

await check('validate: a port that is not a whole number is refused', () => {
  for (const port of ['22 -oProxyCommand=x', 0, 70000, 'abc']) {
    const result = validateDeployConfig({ adapter: 'rsync', rsync: { host: 'h', user: 'u', path: '/srv/www', port } }, guardContext);
    assert.equal(result.valid, false, `port ${port}`);
  }
  assert.equal(validateDeployConfig({ adapter: 'rsync', rsync: { host: 'h', user: 'u', path: '/srv/www', port: '2222' } }, guardContext).valid, true, 'a numeric string');
});

fs.rmSync(guardRoot, { recursive: true, force: true });

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(process.exitCode || 0);
