/**
 * git.paths entries that mean "the project root" scope nothing.
 *
 * `path.normalize('')` and `path.normalize('./')` are `.`, so a configured
 * `''` or `'./'` used to widen the git API to the whole project: the changes
 * diff showed every tracked file, and diff/revert of a single file accepted
 * package.json. `getAllowedGitPaths` drops such entries; `git.paths: []` is a
 * deliberate "nothing" and stays one.
 *
 * Runs the real createServer() app. astroadmin.config.js reads git.paths from
 * a global through a getter, so one server serves every case in turn.
 *
 *   bun tests/git-paths-scope.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-git-paths-scope-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
const git = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('.gitignore', 'node_modules\n');
writeProjectFile('package.json', JSON.stringify({ type: 'module', name: 'site' }));
writeProjectFile('astroadmin.config.js', 'export default { git: { get paths() { return globalThis.__testGitPaths; } } };\n');
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\n---\n');
git(['init', '-q']);
git(['config', 'user.name', 'Test']);
git(['config', 'user.email', 'test@example.com']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'init']);

// Uncommitted edits: one outside every content path, one inside.
const PACKAGE_EDIT = JSON.stringify({ type: 'module', name: 'site', scripts: { postinstall: 'edited' } });
writeProjectFile('package.json', PACKAGE_EDIT);
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home edited\n---\n');

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

globalThis.__testGitPaths = ['src/content'];
const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
assert.equal(login.status, 200, 'login');
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = (url) => fetch(base + url, { headers: { cookie } });
const packagePath = path.join(projectRoot, 'package.json');

async function changesDiff() {
  const response = await get('/api/git/diff');
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.diff;
}

console.log('\n🧪 git.paths that mean the project root\n' + '='.repeat(40));

await check("control: git.paths ['src/content'] diffs content and refuses package.json", async () => {
  globalThis.__testGitPaths = ['src/content'];
  const diff = await changesDiff();
  assert.ok(diff.includes('Home edited'), 'content edit missing from the diff (the instrument is blind)');
  assert.equal(diff.includes('postinstall'), false, 'package.json in the diff');
  const fileDiff = await get('/api/git/diff?file=package.json');
  assert.notEqual(fileDiff.status, 200, 'package.json diff allowed');
});

for (const gitPaths of [[], [''], ['./'], ['.'], ['src/..'], ['', './']]) {
  await check(`git.paths ${JSON.stringify(gitPaths)} scopes nothing`, async () => {
    globalThis.__testGitPaths = gitPaths;
    assert.equal(await changesDiff(), '', 'the changes diff is not empty');

    const fileDiff = await get('/api/git/diff?file=package.json');
    const fileDiffBody = await fileDiff.text();
    assert.notEqual(fileDiff.status, 200, `package.json diff allowed: ${fileDiffBody.slice(0, 120)}`);
    assert.equal(fileDiffBody.includes('postinstall'), false, 'package.json diff leaked');

    const revert = await fetch(`${base}/api/git/revert-file`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'package.json' }),
    });
    assert.notEqual(revert.status, 200, 'package.json revert allowed');
    assert.equal(fs.readFileSync(packagePath, 'utf8'), PACKAGE_EDIT, 'package.json was reverted');

    const status = await (await get('/api/git/status')).json();
    assert.equal(JSON.stringify(status).includes('package.json'), false, 'package.json listed in status');
  });
}

await check("a root entry beside a real one keeps the real one: ['./', 'src/content']", async () => {
  globalThis.__testGitPaths = ['./', 'src/content'];
  const diff = await changesDiff();
  assert.ok(diff.includes('Home edited'), 'content edit missing');
  assert.equal(diff.includes('postinstall'), false, 'package.json in the diff');
  const revert = await fetch(`${base}/api/git/revert-file`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'package.json' }),
  });
  assert.notEqual(revert.status, 200, 'package.json revert allowed');
  assert.equal(fs.readFileSync(packagePath, 'utf8'), PACKAGE_EDIT, 'package.json was reverted');
});

server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
