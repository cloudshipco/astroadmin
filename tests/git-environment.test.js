/**
 * The environment a hosted editor gives git reaches git (#64), through the
 * real createServer() app and a real publish:
 *   - GIT_AUTHOR_* / GIT_COMMITTER_* set the commit's identity, over the
 *     repository's own user.name/user.email;
 *   - GIT_SSH_COMMAND carries the pull and push: the remote is an ssh:// URL
 *     and the "ssh" is a script that records its call and runs the git
 *     command it was given against a local bare repository, so the push
 *     really lands only through it;
 *   - any other ambient GIT_* variable does not reach git (a GIT_DIR naming
 *     another repository would point every command at it).
 * simple-git 4 drops ambient GIT_* variables unless allowed, so an
 * unconfigured client fails the first two. ~2 s.
 *
 *   bun tests/git-environment.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-git-env-')));
const remoteDir = path.join(tempRoot, 'remote.git');
const projectRoot = path.join(tempRoot, 'site');
const decoyRepo = path.join(tempRoot, 'decoy');
const sshLog = path.join(tempRoot, 'ssh-calls');

const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8', env: cleanEnv() }).trim();
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}
function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remoteDir);
fs.mkdirSync(projectRoot);
writeFile(projectRoot, '.gitignore', 'node_modules\n');
writeFile(projectRoot, 'package.json', JSON.stringify({ type: 'module' }));
writeFile(projectRoot, 'astro.config.mjs', 'export default {};\n');
writeFile(projectRoot, 'astroadmin.config.js',
  "export default { git: { enabled: true, paths: ['src/content/'] }, build: { check: 'true' } };\n");
writeFile(projectRoot, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeFile(projectRoot, 'src/content/pages/home.md', '---\ntitle: Home\n---\nText.\n');
fs.symlinkSync(path.resolve(import.meta.dir, '..', 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
git(projectRoot, 'init', '-q', '-b', 'main');
git(projectRoot, 'config', 'user.name', 'Repo Config');
git(projectRoot, 'config', 'user.email', 'repo-config@example.com');
git(projectRoot, 'add', '-A');
git(projectRoot, 'commit', '-q', '-m', 'initial');
// Pushed over the local path once, then the remote is ONLY reachable by ssh.
git(projectRoot, 'remote', 'add', 'origin', remoteDir);
git(projectRoot, 'push', '-q', '-u', 'origin', 'main');
git(projectRoot, 'remote', 'set-url', 'origin', `ssh://git.example.invalid${remoteDir}`);

// A repository a stray GIT_DIR would point git at instead.
git(tempRoot, 'init', '-q', '-b', 'main', decoyRepo);

// git runs `$GIT_SSH_COMMAND [options] <host> "<git command> '<path>'"`.
writeFile(tempRoot, 'fake-ssh.sh', `#!/bin/sh
echo "$*" >> "${sshLog}"
for last in "$@"; do :; done
exec sh -c "$last"
`);
fs.chmodSync(path.join(tempRoot, 'fake-ssh.sh'), 0o755);

process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'true';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;
// What nixos/astroadmin-instance.nix gives a hosted editor.
process.env.GIT_SSH_COMMAND = path.join(tempRoot, 'fake-ssh.sh');
process.env.GIT_AUTHOR_NAME = 'Hosted Author';
process.env.GIT_AUTHOR_EMAIL = 'author@example.com';
process.env.GIT_COMMITTER_NAME = 'Hosted Committer';
process.env.GIT_COMMITTER_EMAIL = 'committer@example.com';

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin', Origin: base };

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

try {
  console.log('\n🧪 The environment git is given\n' + '='.repeat(40));
  const loginResponse = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sameOrigin },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(loginResponse.status, 200, 'login');
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const post = async (route, payload) => {
    const response = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json', ...sameOrigin },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };

  const saved = await post('/api/content/pages/home', { data: { title: 'Home (edited)' }, body: 'Text.\n', type: 'content' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const published = await post('/api/publish', { message: 'Content update' });

  await check('GIT_AUTHOR_* and GIT_COMMITTER_* set the commit identity', async () => {
    assert.match(git(projectRoot, 'log', '-1', '--format=%s'), /Content update/, 'control: publish committed');
    assert.equal(git(projectRoot, 'log', '-1', '--format=%an <%ae>'), 'Hosted Author <author@example.com>');
    assert.equal(git(projectRoot, 'log', '-1', '--format=%cn <%ce>'), 'Hosted Committer <committer@example.com>');
  });

  await check('GIT_SSH_COMMAND carries the push', async () => {
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.ok(fs.existsSync(sshLog), 'the ssh command ran');
    const calls = fs.readFileSync(sshLog, 'utf-8');
    assert.match(calls, /git\.example\.invalid .*git-receive-pack/, calls);
    assert.equal(git(remoteDir, 'rev-parse', 'main'), git(projectRoot, 'rev-parse', 'HEAD'), 'the commit reached the remote');
  });

  // Ambient GIT_* variables that are nobody's intent for the site: a stray
  // GIT_DIR (an operator's shell, a parent git hook) would point every git
  // command, publish's included, at another repository.
  process.env.GIT_DIR = path.join(decoyRepo, '.git');
  process.env.GIT_WORK_TREE = decoyRepo;
  try {
    const savedAgain = await post('/api/content/pages/home', { data: { title: 'Home (second edit)' }, body: 'Text.\n', type: 'content' });
    assert.equal(savedAgain.status, 200, JSON.stringify(savedAgain.body));
    const publishedAgain = await post('/api/publish', { message: 'Second update' });
    await check('an ambient GIT_DIR / GIT_WORK_TREE does not redirect publishing', async () => {
      assert.equal(publishedAgain.status, 200, JSON.stringify(publishedAgain.body));
      assert.match(git(projectRoot, 'log', '-1', '--format=%s'), /Second update/);
      assert.throws(() => git(decoyRepo, 'rev-parse', '--verify', '-q', 'HEAD'), 'the decoy has no commits');
      assert.equal(git(remoteDir, 'rev-parse', 'main'), git(projectRoot, 'rev-parse', 'HEAD'), 'the commit reached the remote');
    });
  } finally {
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
  }

  console.log(`\n📊 ${passed} passed, ${failed} failed.`);
} catch (error) {
  console.error(error);
  failed++;
} finally {
  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.exitCode = failed > 0 ? 1 : 0;
