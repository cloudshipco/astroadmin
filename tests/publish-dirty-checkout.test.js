/**
 * Publishing from a checkout that holds someone's uncommitted changes outside
 * what the editor commits (#83), over HTTP through the real createServer() app.
 *
 * `git pull --rebase` refuses a checkout with ANY unstaged change, so a hand
 * edit of the repository's README.md (outside the site) or of the site's
 * package.json (outside git.paths) made every publish onto a remote that had
 * moved on end in a rejected push and a 502 that "try again" never fixed.
 *
 * The rebase now runs in a throwaway worktree and the live checkout is moved
 * to the result with `git reset --keep`, which carries unrelated local changes
 * across and refuses (changing nothing) when one is in a file the incoming
 * commits change, or an untracked file is where one would be written. That
 * overlap is a fixed, path-free 409.
 *
 * The site is `site-a/` inside its repository; a developer's clone pushes to
 * the same bare remote. The publish check is a trivial command. ~15 s.
 *
 *   bun tests/publish-dirty-checkout.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const astroadminRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-publish-dirty-')));
const remoteDir = path.join(tempRoot, 'remote.git');
const repoRoot = path.join(tempRoot, 'checkout');
const projectRoot = path.join(repoRoot, 'site-a');
const developerClone = path.join(tempRoot, 'developer');

process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'true';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8' }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};
function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
const readRepo = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');
const page = (title) => `---\ntitle: ${title}\n---\nText.\n`;

fs.mkdirSync(projectRoot, { recursive: true });
fs.symlinkSync(path.join(astroadminRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeFile(repoRoot, 'README.md', '# repository\n');
writeFile(repoRoot, 'other/notes.md', 'notes\n');
writeFile(projectRoot, '.gitignore', 'node_modules\n');
writeFile(projectRoot, 'package.json', JSON.stringify({ type: 'module' }));
writeFile(projectRoot, 'astroadmin.config.js',
  "export default { git: { enabled: true, paths: ['src/content/'] }, build: { check: 'true' } };\n");
writeFile(projectRoot, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeFile(projectRoot, 'src/content/pages/home.md', page('Home'));
git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remoteDir);
git(repoRoot, 'init', '-q', '-b', 'main');
git(repoRoot, 'config', 'user.name', 'Editor');
git(repoRoot, 'config', 'user.email', 'editor@example.com');
git(repoRoot, 'add', '-A');
git(repoRoot, 'commit', '-q', '-m', 'initial');
git(repoRoot, 'remote', 'add', 'origin', remoteDir);
git(repoRoot, 'push', '-q', '-u', 'origin', 'main');

git(tempRoot, 'clone', '-q', remoteDir, developerClone);
git(developerClone, 'config', 'user.name', 'Developer');
git(developerClone, 'config', 'user.email', 'developer@example.com');
function developerPushes(relativePath, content) {
  git(developerClone, 'pull', '-q', '--rebase');
  writeFile(developerClone, relativePath, content);
  git(developerClone, 'add', relativePath);
  git(developerClone, 'commit', '-qm', `developer: ${relativePath}`);
  git(developerClone, 'push', '-q');
  return git(developerClone, 'rev-parse', 'HEAD');
}

const remoteHead = () => git(remoteDir, 'rev-parse', 'main');
const localHead = () => git(repoRoot, 'rev-parse', 'HEAD');
const isAncestor = (ancestor, descendant) => tryGit(remoteDir, 'merge-base', '--is-ancestor', ancestor, descendant) !== null;
const worktreeCount = () => git(repoRoot, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length;
const gitPathExists = (name) => fs.existsSync(git(repoRoot, 'rev-parse', '--path-format=absolute', '--git-path', name));
/** Back to the remote's state, with nothing modified. */
function resetSite() {
  git(repoRoot, 'fetch', '-q');
  git(repoRoot, 'checkout', '-q', 'main');
  git(repoRoot, 'reset', '-q', '--hard', 'origin/main');
  git(repoRoot, 'clean', '-fdq');
  assert.equal(git(repoRoot, 'status', '--porcelain'), '');
}

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

function assertNoServerText(body) {
  const text = JSON.stringify(body);
  assert.ok(!text.includes(tempRoot), `no server path in ${text}`);
  assert.ok(!/README|package\.json|other\/|CONFLICT|rebase|reset|fatal:|error:|not uptodate|overwritten/i.test(text),
    `no file name or git text in ${text}`);
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  } finally {
    // Each check starts from the remote's state, whether or not the last passed.
    resetSite();
  }
}

// Uncommitted changes that are not the editor's, each with an incoming
// change that does not touch it.
const UNRELATED = [
  ['a modified README.md outside the site', 'README.md', '# repository, edited by hand\n', 'other/notes.md'],
  ["a modified package.json in the site but outside git.paths", 'site-a/package.json', '{"type":"module","private":true}', 'README.md'],
];
// Local state that the incoming change would overwrite.
// The untracked file's name is new for each route, so it is never tracked yet.
const overlapping = (route) => [
  ['a modified README.md that the remote also changed', 'README.md', '# repository, edited by hand\n', 'README.md', true],
  ['an untracked file where the remote adds one', `other/new-${route.length}.md`, 'mine, not committed\n', `other/new-${route.length}.md`, false],
];

try {
  console.log('\n🧪 Publishing from a checkout with changes that are not the editor\'s\n' + '='.repeat(40));

  for (const [route, send] of routes) {
    for (const [label, dirtyFile, dirtyText, incomingFile] of UNRELATED) {
      await check(`${route}: ${label} does not stop a publish onto a moved remote`, async () => {
        const developerCommit = developerPushes(incomingFile, `${incomingFile} from the developer (${route}, ${label})\n`);
        writeFile(repoRoot, dirtyFile, dirtyText);
        assert.equal((await save(`Home (${route}, ${label})`)).status, 200);
        const { status, body } = await send();
        assert.equal(status, 200, JSON.stringify(body));
        assert.notEqual(body.pushed, false, JSON.stringify(body));
        assert.equal(remoteHead(), localHead(), 'the remote has the published commit');
        assert.ok(isAncestor(developerCommit, remoteHead()), "the developer's commit is underneath");
        assert.equal(body.commit.hash, remoteHead(), 'the reported commit is the one pushed');
        assert.match(git(remoteDir, 'show', 'main:site-a/src/content/pages/home.md'), new RegExp(`Home \\(${route}`),
          "the editor's change is on the remote");
        assert.equal(readRepo(dirtyFile), dirtyText, 'the hand edit is byte-identical');
        assert.equal(git(repoRoot, 'status', '--porcelain'), `M ${dirtyFile}`, `and still the only uncommitted change: ${git(repoRoot, 'status', '--porcelain')}`);
        assert.equal(readRepo(incomingFile), `${incomingFile} from the developer (${route}, ${label})\n`, 'the incoming change is in the checkout');
        assert.equal(worktreeCount(), 1, 'no worktree left behind');
      });
    }

    for (const [label, localFile, localText, incomingFile, tracked] of overlapping(route)) {
      await check(`${route}: ${label} is refused with a fixed 409, and everything is left as it was`, async () => {
        developerPushes(incomingFile, `${incomingFile} from the developer (${route}, ${label})\n`);
        writeFile(repoRoot, localFile, localText);
        assert.equal((await save(`Home (${route}, ${label})`)).status, 200);
        const remoteBefore = remoteHead();
        const { status, body } = await send();
        assert.equal(status, 409, JSON.stringify(body));
        assert.equal(body.success, false);
        assert.equal(body.committed, true, JSON.stringify(body));
        assert.equal(body.pushed, false);
        assert.ok(body.message && body.error, JSON.stringify(body));
        assertNoServerText(body);
        assert.equal(remoteHead(), remoteBefore, 'nothing pushed');
        assert.equal(tryGit(repoRoot, 'symbolic-ref', '--short', 'HEAD'), 'main', 'still on the branch');
        assert.equal(git(repoRoot, 'rev-parse', 'HEAD~1'), git(repoRoot, 'merge-base', 'HEAD', remoteBefore),
          'the local commit sits where it was made, not moved onto the remote');
        assert.ok(git(repoRoot, 'show', 'HEAD:site-a/src/content/pages/home.md').includes(label), "the editor's commit is intact");
        assert.equal(readRepo(localFile), localText, 'the local file is byte-identical');
        assert.equal(git(repoRoot, 'status', '--porcelain'), `${tracked ? 'M' : '??'} ${localFile}`, `nothing else changed: ${git(repoRoot, 'status', '--porcelain')}`);
        assert.equal(gitPathExists('rebase-merge') || gitPathExists('rebase-apply'), false, 'no operation left in progress');
        assert.equal(worktreeCount(), 1, 'no worktree left behind');

        // Once the local file is dealt with, the same publish goes out.
        fs.rmSync(path.join(repoRoot, localFile));
        if (tracked) git(repoRoot, 'checkout', '-q', '--', localFile);
        const retry = await send();
        if (route === 'publish') {
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          assert.equal(remoteHead(), localHead(), 'published on the retry');
        } else {
          // Nothing new to commit, so the commit route has nothing to do.
          assert.equal(retry.status, 400, JSON.stringify(retry.body));
        }
      });
    }

    // `git pull --rebase` used the remote-tracking branch's reflog
    // (--fork-point): a commit that was pushed and then force-pushed away
    // upstream is not replayed. A rebase onto the fetched head alone replays
    // everything since the merge-base, and the push would put it back.
    await check(`${route}: a commit the upstream force-pushed away is not brought back`, async () => {
      const removedFile = `other/removed-${route.length}.md`;
      writeFile(repoRoot, removedFile, 'pushed by mistake\n');
      git(repoRoot, 'add', removedFile);
      git(repoRoot, 'commit', '-qm', 'pushed by mistake');
      const removedCommit = localHead();
      git(repoRoot, 'push', '-q', 'origin', 'main');
      assert.equal(remoteHead(), removedCommit, 'control: the commit reached the remote');

      git(developerClone, 'fetch', '-q');
      git(developerClone, 'reset', '-q', '--hard', `${removedCommit}~1`);
      writeFile(developerClone, `other/dev-${route.length}.md`, 'developer work\n');
      git(developerClone, 'add', '-A');
      git(developerClone, 'commit', '-qm', 'developer work');
      git(developerClone, 'push', '-q', '--force', 'origin', 'main');
      const developerCommit = git(developerClone, 'rev-parse', 'HEAD');

      assert.equal((await save(`Home (${route}, force-push)`)).status, 200);
      const { status, body } = await send();
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(remoteHead(), localHead(), 'published');
      assert.ok(isAncestor(developerCommit, remoteHead()), "the developer's commit is underneath");
      assert.equal(isAncestor(removedCommit, remoteHead()), false, 'the removed commit is not an ancestor');
      assert.equal(tryGit(remoteDir, 'cat-file', '-e', `main:${removedFile}`), null,
        `the removed file is not on the remote: ${git(remoteDir, 'log', '--format=%s', 'main')}`);
      assert.match(git(remoteDir, 'show', 'main:site-a/src/content/pages/home.md'), /force-push/, "the editor's change is on the remote");
    });
  }
} finally {
  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
