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

const originalStderrWrite = process.stderr.write.bind(process.stderr);
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

const REFUSED_REMOTE = ['/', '//', '~', '~/', '.', './', '', '..', '~/..', 'www/../..',
  // Another user's home: the remote shell expands `~name` (rsync sends it
  // unescaped), so it is that home, alone, with a slash or climbing.
  '~deploy', '~deploy/', '~root/', '~deploy/.', '~deploy/www/..', '~deploy/..', '~www-data'];
for (const destination of REFUSED_REMOTE) {
  await check(`validate: a remote destination of ${JSON.stringify(destination)} is refused`, () => {
    const result = validateDeployConfig({ adapter: 'rsync', rsync: { host: 'h', user: 'u', path: destination } }, guardContext);
    assert.equal(result.valid, false);
  });
}

await check('validate: an ordinary remote destination is accepted (positive control)', () => {
  for (const destination of ['/var/www/site-a', 'www', '~/www', '~deploy/www', '/srv/~deploy']) {
    assert.deepEqual(validateDeployConfig({ adapter: 'rsync', rsync: { host: 'h', user: 'u', path: destination } }, guardContext), { valid: true, errors: [] }, destination);
  }
});

// A remote path reaches the remote shell: rsync before 3.2.4 and macOS's
// openrsync send it unescaped, and even rsync 3.4.4 leaves `*` unescaped,
// so `$HOME`, backticks, `$(...)`, `;cmd` and globs were expanded there
// (`w*` synced into the first match, with --delete). Only a plain spelling
// is accepted, whatever the rsync version, and the override does not lift it.
const REMOTE_PATH_REFUSAL = 'rsync.path for a remote host may hold only letters, digits and the characters . _ ~ / + @ , = - (the remote shell would expand anything else), and must not start with "-"';
const SHELL_EXPANDED_REMOTE = ['$HOME', '$HOME/www', '${HOME}/www', '`id`', '$(id)', 'www;touch /tmp/x', 'www && id',
  'w*', 'ww?', 'w[w]w', '{www,other}', 'www dir', "it's", 'a|b', 'www\nother', 'www\\x', '!x', '-rf', '--delete'];
for (const destination of SHELL_EXPANDED_REMOTE) {
  await check(`validate: a remote destination the remote shell would expand is refused (${JSON.stringify(destination)})`, () => {
    for (const extra of [{}, { allowDestructivePath: true }]) {
      const result = validateDeployConfig({ adapter: 'rsync', rsync: { host: 'h', user: 'u', path: destination, ...extra } }, guardContext);
      assert.equal(result.valid, false, JSON.stringify(extra));
      assert.ok(result.errors.includes(REMOTE_PATH_REFUSAL), result.errors.join('\n'));
      assert.ok(result.errors.every((error) => !error.includes(destination)), 'our sentence, not the value');
    }
  });
}

await check('validate: plain remote spellings are accepted (positive control)', () => {
  for (const destination of ['/var/www/site-a', 'www', '~/www', '~deploy/www', '/srv/~deploy', 'site+a/v=1,b@2', 'a-b_c.d/']) {
    assert.deepEqual(validateDeployConfig({ adapter: 'rsync', rsync: { host: 'h', user: 'u', path: destination } }, guardContext), { valid: true, errors: [] }, destination);
  }
  // A local path is never handed to a shell: the same characters are fine.
  assert.deepEqual(validateLocal(path.join(guardRoot, 'w*')), { valid: true, errors: [] });
});

/**
 * A fake `ssh` that does what a real one does with rsync's command: runs it
 * through `sh -c` (the remote login shell) in a stand-in home directory, so
 * the local rsync becomes the "remote" end and any expansion happens.
 */
for (const destination of ['w*', '$TARGET_DIR']) {
  await check(`deploy: a remote path the shell would expand never reaches ssh (${destination})`, async () => {
    const bin = fs.mkdtempSync(path.join(guardRoot, 'bin-'));
    const remoteHome = fs.mkdtempSync(path.join(guardRoot, 'remote-home-'));
    fs.mkdirSync(path.join(remoteHome, 'www'));
    fs.writeFileSync(path.join(remoteHome, 'www', 'keep.txt'), 'keep\n');
    const record = path.join(bin, 'ran.txt');
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in -p|-i|-o|-l) shift 2;; -*) shift;; *) break;; esac
done
shift
printf '%s\\n' "$*" >> '${record}'
cd '${remoteHome}' && HOME='${remoteHome}' TARGET_DIR=www exec /bin/sh -c "$*"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(guardProject, 'dist', 'index.html'), '<h1>hi</h1>');
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    process.stderr.write = () => true;
    try {
      await assert.rejects(
        () => deploy({ adapter: 'rsync', rsync: { host: 'example.com', user: 'deploy', path: destination } }, guardProject, { log: () => {} }),
        /refused/,
      );
    } finally {
      process.env.PATH = originalPath;
      process.stderr.write = originalStderrWrite;
    }
    assert.equal(fs.existsSync(record), false, `ssh ran: ${fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : ''}`);
    assert.equal(fs.readFileSync(path.join(remoteHome, 'www', 'keep.txt'), 'utf8'), 'keep\n', 'the expanded match was synced over with --delete');
    assert.equal(fs.existsSync(path.join(remoteHome, 'www', 'index.html')), false);
  });
}

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

// rsync hands `user@host` to ssh as one argument, even after `--`, so a
// user or host starting with `-` is an ssh OPTION (-oProxyCommand runs a
// command on the admin's host).
const HOSTILE_REMOTE = [
  { user: '-oProxyCommand=touch /tmp/pwned', host: 'h' },
  { user: 'deploy', host: '-oProxyCommand=touch /tmp/pwned' },
  { user: 'de ploy', host: 'h' },
  { user: 'deploy', host: 'h /srv' },
  { user: 'deploy', host: 'h:/srv' },
  { user: 'de@ploy', host: 'h' },
  { user: 'deploy', host: '[not-an-address]' },
];
for (const remote of HOSTILE_REMOTE) {
  await check(`validate: refuses user ${JSON.stringify(remote.user)} with host ${JSON.stringify(remote.host)}`, () => {
    const result = validateDeployConfig({ adapter: 'rsync', rsync: { path: '/srv/www', ...remote } }, guardContext);
    assert.equal(result.valid, false, 'accepted');
    assert.ok(result.errors.every((error) => !error.includes('pwned')), 'our sentence, not the value');
  });
}

await check('validate: ordinary users and hosts are accepted (positive control)', () => {
  const remotes = [
    { user: 'deploy', host: 'example.com' },
    { user: 'www-data', host: 'web-1.example.com' },
    { user: 'u_1.x', host: '203.0.113.9' },
    { user: 'deploy', host: '[2001:db8::1]' },
    { user: 'deploy', host: 'localhost' },
  ];
  for (const remote of remotes) {
    assert.deepEqual(validateDeployConfig({ adapter: 'rsync', rsync: { path: '/srv/www', ...remote } }, guardContext), { valid: true, errors: [] }, JSON.stringify(remote));
  }
});

await check('deploy: a hostile user never reaches ssh, even past validate()', async () => {
  const bin = fs.mkdtempSync(path.join(guardRoot, 'bin-'));
  const record = path.join(bin, 'args.txt');
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\nexit 255\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    await assert.rejects(
      () => deploy({ adapter: 'rsync', rsync: { host: 'h', user: '-oProxyCommand=x', path: '/srv/www' } }, guardProject, { log: () => {} }),
      /refused/,
    );
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(fs.existsSync(record), false, 'ssh was run');
});

await check('deploy: a local path starting with "-" is a path, not an rsync option', async () => {
  // Only reachable with the override (a relative path is inside the project).
  // Without `--`, rsync reads `--version` as its option, prints its version,
  // exits 0, and the deploy "succeeds" having copied nothing.
  fs.writeFileSync(path.join(guardProject, 'dist', 'index.html'), '<h1>hi</h1>');
  const result = await deploy({ adapter: 'rsync', rsync: { path: '--version', allowDestructivePath: true } }, guardProject, { log: () => {} });
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(path.join(guardProject, '--version', 'index.html'), 'utf8'), '<h1>hi</h1>');
});

// rsync reads a destination with a `:` before its first `/` as REMOTE, so a
// `user@host:/dir` written into `path` with no `host` would sync over ssh
// without the user and host checks.
for (const destination of ['deploy@server.example.com:/var/www', 'server.example.com:/var/www', 'server:www', 'rsync://server/module']) {
  await check(`validate: a remote spec in path with no host is refused with the fields to use (${destination})`, () => {
    for (const extra of [{}, { allowDestructivePath: true }]) {
      const result = validateLocal(destination, extra);
      assert.equal(result.valid, false, JSON.stringify(extra));
      assert.deepEqual(result.errors, ['rsync.path looks like a remote destination (host:path); put the server in rsync.host, the user in rsync.user and only the directory in rsync.path'], JSON.stringify(extra));
    }
  });
}

await check('validate: a local path with a colon after a slash is local (positive control)', () => {
  assert.deepEqual(validateLocal(path.join(guardRoot, 'www:2')), { valid: true, errors: [] });
  assert.deepEqual(validateLocal('../www:2'), { valid: true, errors: [] });
});

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
