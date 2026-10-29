/**
 * Git routes name only the site's own files when the site is a SUBDIRECTORY
 * of its git repository (#68), over HTTP through the real createServer() app
 * as a signed-in editor.
 *
 * The repository holds the site in `site-a/` beside sibling files at the repo
 * root (`README.md`, and a root-level `src/content/pages/root-only.md` whose
 * site-relative name would match the site's git paths) and in `other/`. Those
 * siblings are modified, added, deleted, staged, renamed into the site and out
 * of it, and changed by a pull. Every git route's response must name none of
 * them and carry no repository prefix (`site-a/`), while the site's own
 * changes are still reported, site-relative (the positive controls).
 *
 *   bun tests/git-subdir-routes.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const astroadminRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-git-subdir-routes-')));
const remoteDir = path.join(tempRoot, 'remote.git');
const repoRoot = path.join(tempRoot, 'checkout');
const projectRoot = path.join(repoRoot, 'site-a');
const developerClone = path.join(tempRoot, 'developer');

process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8' }).trim();
function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
const page = (title, body = 'Text.') => `---\ntitle: ${title}\n---\n${body}\n`;
const PAGES = 'site-a/src/content/pages';

// Anything in a response that names a sibling, or a site path with its
// repository prefix, is a leak.
const LEAK_MARKERS = ['other/', 'README', 'root-only', 'new-root', 'site-a', 'SIBLING'];
function assertNoLeak(label, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  for (const marker of LEAK_MARKERS) {
    assert.equal(text.includes(marker), false, `${label} names "${marker}": ${text.slice(0, 600)}`);
  }
}
const sorted = (list) => [...list].sort();

// --- The repository: a site in site-a/, siblings around it ---------------------

git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remoteDir);
fs.mkdirSync(projectRoot, { recursive: true });
fs.symlinkSync(path.join(astroadminRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeFile(repoRoot, 'README.md', '# repository\n');
writeFile(repoRoot, 'src/content/pages/root-only.md', page('Root only', 'SIBLING root text.'));
writeFile(repoRoot, 'other/notes.md', 'SIBLING notes\n');
writeFile(repoRoot, 'other/gone.md', 'SIBLING gone\n');
writeFile(repoRoot, 'other/move-in.md', page('Move in', 'Moved into the site.'));
writeFile(repoRoot, 'other/pulled-in.md', page('Pulled in', 'Moved into the site upstream.'));
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
for (const name of ['home', 'removed', 'move-out', 'old-name', 'pulled-out']) {
  writeFile(repoRoot, `${PAGES}/${name}.md`, page(name, `Site text of ${name}.`));
}
git(repoRoot, 'init', '-q', '-b', 'main');
git(repoRoot, 'config', 'user.name', 'Editor');
git(repoRoot, 'config', 'user.email', 'editor@example.com');
git(repoRoot, 'config', 'pull.rebase', 'false');
git(repoRoot, 'add', '-A');
git(repoRoot, 'commit', '-q', '-m', 'initial');
const initialCommit = git(repoRoot, 'rev-parse', 'HEAD');
git(repoRoot, 'remote', 'add', 'origin', remoteDir);
git(repoRoot, 'push', '-q', '-u', 'origin', 'main');

// Upstream: a commit touching only siblings, then one touching the site with
// renames across the site's boundary in both directions.
const LONG_NAME = 'a-rather-long-entry-name-that-pushes-the-pull-diffstat-past-its-usual-width.md';
git(tempRoot, 'clone', '-q', remoteDir, developerClone);
git(developerClone, 'config', 'user.name', 'Developer');
git(developerClone, 'config', 'user.email', 'developer@example.com');
writeFile(developerClone, 'README.md', '# repository, SIBLING edit upstream\n');
writeFile(developerClone, 'other/notes.md', 'SIBLING notes edited upstream\n');
writeFile(developerClone, 'src/content/pages/root-only.md', page('Root only', 'SIBLING edited upstream.'));
git(developerClone, 'add', '-A');
git(developerClone, 'commit', '-q', '-m', 'SIBLING-ONLY upstream commit');
writeFile(developerClone, `${PAGES}/home.md`, page('Home', 'Edited upstream.'));
writeFile(developerClone, `${PAGES}/${LONG_NAME}`, page('Long', 'A long name.'));
git(developerClone, 'mv', 'other/pulled-in.md', `${PAGES}/pulled-in.md`);
git(developerClone, 'mv', `${PAGES}/pulled-out.md`, 'other/pulled-out.md');
git(developerClone, 'add', '-A');
git(developerClone, 'commit', '-q', '-m', 'Upstream site commit');
git(developerClone, 'push', '-q');

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

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
assert.equal(login.status, 200, 'login');
const cookie = login.headers.get('set-cookie').split(';')[0];
async function get(url) {
  const response = await fetch(base + url, { headers: { cookie } });
  return { status: response.status, body: await response.json() };
}
async function post(url, payload = {}) {
  const response = await fetch(base + url, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

console.log('\n🧪 Git routes with the site in a subdirectory (#68)\n' + '='.repeat(40));

try {
  // The upstream commits arrive as a person on the server would bring them
  // in (the editor has no pull route; publishing rebases onto the upstream).
  git(repoRoot, 'pull', '-q');
  assert.ok(fs.readFileSync(path.join(repoRoot, 'other/notes.md'), 'utf-8').includes('edited upstream'), 'pulled');

  // Local changes: siblings and site files, staged renames both ways.
  writeFile(repoRoot, 'README.md', '# repository, SIBLING edit\n');
  writeFile(repoRoot, 'src/content/pages/root-only.md', page('Root only', 'SIBLING edited locally.'));
  writeFile(repoRoot, 'src/content/pages/new-root.md', page('New root', 'SIBLING new.'));
  writeFile(repoRoot, 'other/notes.md', 'SIBLING notes edited locally\n');
  writeFile(repoRoot, 'other/new.md', 'SIBLING new\n');
  fs.rmSync(path.join(repoRoot, 'other/gone.md'));
  git(repoRoot, 'add', 'other/notes.md');
  writeFile(repoRoot, `${PAGES}/home.md`, page('Home', 'Edited locally.'));
  writeFile(repoRoot, `${PAGES}/fresh.md`, page('Fresh'));
  fs.rmSync(path.join(repoRoot, `${PAGES}/removed.md`));
  git(repoRoot, 'mv', 'other/move-in.md', `${PAGES}/move-in.md`);
  git(repoRoot, 'mv', `${PAGES}/move-out.md`, 'other/move-out.md');
  git(repoRoot, 'mv', `${PAGES}/old-name.md`, `${PAGES}/new-name.md`);

  await check('GET /api/git/status names only the site\'s changes, renames scoped at both ends', async () => {
    // Control: git itself reports the siblings and both cross-boundary renames.
    const raw = git(repoRoot, 'status', '--porcelain');
    for (const expected of ['README.md', 'other/notes.md', 'other/move-in.md -> site-a/', 'site-a/src/content/pages/move-out.md -> other/']) {
      assert.ok(raw.includes(expected), `control: git status lacks ${expected}:\n${raw}`);
    }
    const { status, body } = await get('/api/git/status');
    assert.equal(status, 200, JSON.stringify(body));
    assertNoLeak('status', body);
    const { modified, created, deleted, renamed } = body.status;
    assert.deepEqual(sorted(modified), ['src/content/pages/home.md']);
    // A file renamed in from outside is new to the site; one renamed out is gone.
    assert.deepEqual(sorted(created), ['src/content/pages/fresh.md', 'src/content/pages/move-in.md']);
    assert.deepEqual(sorted(deleted), ['src/content/pages/move-out.md', 'src/content/pages/removed.md']);
    assert.deepEqual(renamed, [{ from: 'src/content/pages/old-name.md', to: 'src/content/pages/new-name.md' }]);
  });

  await check('GET /api/git/diff (all changes) shows the site\'s edits with site-relative headers', async () => {
    const { status, body } = await get('/api/git/diff');
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.diff.includes('Edited locally.'), 'the site edit is missing (blind instrument)');
    assert.ok(body.diff.includes('a/src/content/pages/home.md'), body.diff.slice(0, 400));
    assertNoLeak('diff', body);
  });

  await check('GET /api/git/diff?file= and from= a commit stay inside the site', async () => {
    const fileDiff = await get('/api/git/diff?file=src/content/pages/home.md');
    assert.equal(fileDiff.status, 200, JSON.stringify(fileDiff.body));
    assert.ok(fileDiff.body.diff.includes('Edited locally.'));
    assertNoLeak('file diff', fileDiff.body);
    const sinceInitial = await get(`/api/git/diff?from=${initialCommit}`);
    assert.equal(sinceInitial.status, 200, JSON.stringify(sinceInitial.body));
    assert.ok(sinceInitial.body.diff.includes('pulled-in.md'), 'the pulled rename-in is missing');
    assertNoLeak('diff since a commit', sinceInitial.body);
    const head = git(repoRoot, 'rev-parse', 'HEAD');
    const betweenCommits = await get(`/api/git/diff?from=${initialCommit}&to=${head}`);
    assert.equal(betweenCommits.status, 200, JSON.stringify(betweenCommits.body));
    assert.ok(betweenCommits.body.diff.includes('Edited upstream.'));
    assertNoLeak('diff between commits', betweenCommits.body);
  });

  await check('GET /api/git/log lists only commits that touch the site\'s git paths', async () => {
    const { status, body } = await get('/api/git/log?limit=10');
    assert.equal(status, 200, JSON.stringify(body));
    const messages = body.commits.map((commit) => commit.message);
    assert.ok(messages.includes('Upstream site commit'), JSON.stringify(messages));
    assertNoLeak('log', body);
  });

  await check('GET /api/git/file-history and /api/git/show read the site\'s file only', async () => {
    const history = await get('/api/git/file-history?file=src/content/pages/home.md');
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.ok(history.body.commits.some((commit) => commit.message === 'Upstream site commit'), JSON.stringify(history.body));
    assertNoLeak('file history', history.body);
    const shown = await get('/api/git/show?file=src/content/pages/home.md');
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.ok(shown.body.content.includes('Edited upstream.'));
    // The root-level file of the site-relative name is not the site's.
    const rootOnly = await get('/api/git/show?file=src/content/pages/root-only.md');
    assert.notEqual(rootOnly.status, 200);
    assertNoLeak('show of a root-level name', rootOnly.body);
  });

  await check('revert and restore refuse a sibling, and change nothing', async () => {
    const notesBefore = fs.readFileSync(path.join(repoRoot, 'other/notes.md'), 'utf-8');
    const revert = await post('/api/git/revert-file', { file: '../other/notes.md' });
    assert.equal(revert.status, 400, JSON.stringify(revert.body));
    const restore = await post('/api/git/restore-from-commit', { file: '../other/notes.md', commit: initialCommit });
    assert.equal(restore.status, 400, JSON.stringify(restore.body));
    const rootRevert = await post('/api/git/revert-file', { file: 'src/content/pages/root-only.md' });
    assert.notEqual(rootRevert.status, 200, JSON.stringify(rootRevert.body));
    for (const response of [revert, restore, rootRevert]) assertNoLeak('refused revert', response.body);
    assert.equal(fs.readFileSync(path.join(repoRoot, 'other/notes.md'), 'utf-8'), notesBefore);
    assert.ok(fs.readFileSync(path.join(repoRoot, 'src/content/pages/root-only.md'), 'utf-8').includes('edited locally'));
  });

  await check('POST /api/git/commit commits and reports only the site\'s files', async () => {
    const { status, body } = await post('/api/git/commit', { message: 'Editor commit' });
    assert.equal(status, 200, JSON.stringify(body));
    assertNoLeak('commit', body);
    const committed = git(repoRoot, 'diff-tree', '-M', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').filter(Boolean);
    assert.ok(committed.length > 0);
    assert.ok(committed.every((file) => file.startsWith('site-a/')), JSON.stringify(committed));
    assert.equal(body.commit.summary.changes, committed.length, JSON.stringify(body.commit));
    const after = await get('/api/git/status');
    assertNoLeak('status after commit', after.body);
  });

  await check('POST /api/publish reports nothing outside the site', async () => {
    writeFile(repoRoot, `${PAGES}/home.md`, page('Home', 'Edited for publish.'));
    // The siblings' uncommitted changes stay where they are: the rebase runs
    // in its own worktree (#83), so they no longer stop the publish.
    const siblingsBefore = git(repoRoot, 'status', '--porcelain', '--', 'other', 'README.md', 'src');
    assert.notEqual(siblingsBefore, '', 'control: siblings have uncommitted changes');
    const { status, body } = await post('/api/publish', { message: 'Editor publish' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.pushed, true, JSON.stringify(body));
    assertNoLeak('publish', body);
    assert.equal(git(repoRoot, 'status', '--porcelain', '--', 'other', 'README.md', 'src'), siblingsBefore,
      "the siblings' changes are untouched");
  });
} finally {
  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
