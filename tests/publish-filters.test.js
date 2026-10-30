/**
 * A site whose files go through a git filter driver (Git LFS, or any
 * clean/smudge filter) is refused for publishing, by both routes, before
 * anything is staged, committed or pushed. Over HTTP through the real
 * createServer() app; ~3 s.
 *
 * The admin switches every filter driver off (#67: a driver is a command the
 * repository's config names), so for such a site it would commit the files'
 * working-tree bytes rather than what the filter stores (a touched LFS file
 * recommitted whole), and the publish check would build from what the
 * repository stores (LFS pointer text). What counts as "in use": a file,
 * tracked or new and not ignored, anywhere in the repository, whose `filter`
 * attribute names `lfs` (configured or not) or a driver configured in any
 * scope. An attribute naming a driver nobody configured is inert in git
 * too, and a configured driver no attribute uses is never run: both publish.
 *
 * git-lfs is not installed for this test: the lfs driver is a fake script
 * that records whether it ran.
 *
 *   bun tests/publish-filters.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const astroadminRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-publish-filters-')));
const remoteDir = path.join(tempRoot, 'remote.git');
const projectRoot = path.join(tempRoot, 'site');
const markers = path.join(tempRoot, 'markers');
fs.mkdirSync(markers);

process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'true';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

// The test's own git never runs a filter (the user's global config may
// configure git-lfs, which is not installed here).
const NO_FILTERS = ['lfs', 'custom', 'unused'].flatMap((name) => [
  '-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`,
]);
const git = (cwd, ...args) => execFileSync('/usr/bin/git', [...NO_FILTERS, ...args], { cwd, encoding: 'utf-8' }).trim();
function writeFile(root, relativePath, content, mode) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  if (mode) fs.chmodSync(fullPath, mode);
}
const page = (title) => `---\ntitle: ${title}\n---\nText.\n`;
/** A filter command that records that it ran, then passes the bytes through. */
function driver(name) {
  const script = path.join(tempRoot, `driver-${name}`);
  writeFile(tempRoot, `driver-${name}`, `#!/bin/sh\ntouch "${markers}/${name}"\ncat\n`, 0o755);
  return script;
}
const fired = () => fs.readdirSync(markers).sort();

fs.mkdirSync(projectRoot);
fs.symlinkSync(path.join(astroadminRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeFile(projectRoot, '.gitignore', 'node_modules\n');
writeFile(projectRoot, 'package.json', JSON.stringify({ type: 'module' }));
writeFile(projectRoot, 'astroadmin.config.js',
  "export default { git: { enabled: true, paths: ['src/content/'], allowLocalRemote: true }, build: { check: 'true' } };\n");
writeFile(projectRoot, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeFile(projectRoot, 'src/content/pages/home.md', page('Home'));
writeFile(projectRoot, 'data/table.dat', 'rows\n');
git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remoteDir);
git(projectRoot, 'init', '-q', '-b', 'main');
git(projectRoot, 'config', 'user.name', 'Editor');
git(projectRoot, 'config', 'user.email', 'editor@example.com');
git(projectRoot, 'add', '-A');
git(projectRoot, 'commit', '-q', '-m', 'initial');
git(projectRoot, 'remote', 'add', 'origin', remoteDir);
git(projectRoot, 'push', '-q', '-u', 'origin', 'main');
const infoAttributes = path.join(git(projectRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'info'), 'attributes');
const setInfoAttributes = (text) => {
  fs.mkdirSync(path.dirname(infoAttributes), { recursive: true });
  fs.writeFileSync(infoAttributes, text);
};

const remoteHead = () => git(remoteDir, 'rev-parse', 'main');
const localHead = () => git(projectRoot, 'rev-parse', 'HEAD');

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin', Origin: base };
const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...sameOrigin },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
assert.equal(login.status, 200, 'login');
const cookie = login.headers.get('set-cookie').split(';')[0];
async function post(route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', ...sameOrigin },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}
const save = (title) => post('/api/content/pages/home', { data: { title }, body: 'Text.\n', type: 'content' });
const routes = [
  ['publish', () => post('/api/publish', { message: 'Content update' })],
  ['the commit route', () => post('/api/git/commit', { message: 'Content commit' })],
];

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

/** Both routes refuse with the fixed 409, and nothing is staged, committed, pushed or run. */
async function assertRefused(label) {
  for (const [route, send] of routes) {
    await check(`${label}: ${route} is refused before anything is committed`, async () => {
      assert.equal((await save(`Home (${route}, ${label})`)).status, 200);
      const headBefore = localHead();
      const remoteBefore = remoteHead();
      const { status, body } = await send();
      assert.equal(status, 409, JSON.stringify(body));
      assert.equal(body.success, false);
      assert.equal(body.committed, false);
      assert.equal(body.pushed, false);
      assert.match(body.message, /filter/i, JSON.stringify(body));
      const text = JSON.stringify(body);
      assert.ok(!text.includes(tempRoot) && !/\.png|\.md|\.dat|fatal:|error:/i.test(text), `no path or git text: ${text}`);
      assert.equal(localHead(), headBefore, 'nothing committed');
      assert.equal(remoteHead(), remoteBefore, 'nothing pushed');
      assert.equal(git(projectRoot, 'diff', '--cached', '--name-only'), '', 'nothing staged');
      assert.match(git(projectRoot, 'status', '--porcelain'), /^ ?M src\/content\/pages\/home\.md$/m, 'the save is still there, unstaged');
      assert.deepEqual(fired(), [], `a filter ran: ${fired().join(', ')}`);
    });
  }
}

try {
  console.log('\n🧪 Sites whose files go through a git filter\n' + '='.repeat(40));

  await check('control: an attribute naming an unconfigured driver, and a configured driver nothing uses, publish', async () => {
    setInfoAttributes('*.dat filter=nobody\n');
    git(projectRoot, 'config', 'filter.unused.clean', driver('unused'));
    git(projectRoot, 'config', 'filter.unused.smudge', driver('unused'));
    assert.equal((await save('Home (control)')).status, 200);
    const { status, body } = await post('/api/publish', { message: 'Content update' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(remoteHead(), localHead(), 'published');
    assert.match(git(remoteDir, 'show', 'main:src/content/pages/home.md'), /Home \(control\)/);
    assert.deepEqual(fired(), []);
  });

  // A clean/smudge filter on the site's own content.
  setInfoAttributes('*.md filter=custom\n');
  git(projectRoot, 'config', 'filter.custom.clean', driver('custom'));
  git(projectRoot, 'config', 'filter.custom.smudge', driver('custom'));
  await assertRefused('a configured filter on *.md');

  // Git LFS, tracked by a committed .gitattributes; nothing tracked yet, and
  // no lfs driver configured here: a NEW image the editor uploaded is enough.
  setInfoAttributes('');
  writeFile(projectRoot, '.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n');
  git(projectRoot, 'add', '.gitattributes');
  git(projectRoot, 'commit', '-qm', 'Track images with LFS');
  git(projectRoot, 'push', '-q');
  writeFile(projectRoot, 'src/content/assets/upload.png', 'not really a png\n');
  await assertRefused('a new image under an LFS attribute (no driver configured)');

  // Git LFS with its driver configured (a fake), and a tracked pointer file.
  fs.rmSync(path.join(projectRoot, 'src/content/assets/upload.png'));
  writeFile(projectRoot, 'public/images/hero.png', 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n');
  git(projectRoot, 'add', 'public/images/hero.png');
  git(projectRoot, 'commit', '-qm', 'An LFS image');
  git(projectRoot, 'push', '-q');
  for (const key of ['clean', 'smudge', 'process']) git(projectRoot, 'config', `filter.lfs.${key}`, driver('lfs'));
  await assertRefused('a tracked LFS file with the lfs driver configured');
} finally {
  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
