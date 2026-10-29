/**
 * Publishing onto a site repo that someone else also pushes to (#57), over
 * HTTP through the real createServer() app:
 *   - /api/git/commit (autoPush) commits unstaged saves, rebases them onto a
 *     remote that moved on, and reports the rebased commit;
 *   - a conflicting rebase is aborted and refused (409) on both routes, with
 *     no server path anywhere in the body;
 *   - a rebase or merge left unfinished by someone else is refused before
 *     anything is staged, and left as it was;
 *   - an inherited rebase.autoStash never leaves conflict markers behind;
 *   - a save that arrives while publish is committing and rebasing waits for
 *     it, so the abort's reset cannot discard it.
 *
 * The publish check is a trivial command: tests/publish-check.test.js covers
 * the build. ~5 s.
 *
 *   bun tests/publish-sync.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-publish-sync-')));
const remoteDir = path.join(tempRoot, 'remote.git');
const projectRoot = path.join(tempRoot, 'site');
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
const readSite = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf-8');
const page = (title, body = 'Text.') => `---\ntitle: ${title}\n---\n${body}\n`;

// --- The site, its remote and a developer's clone -----------------------------

git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remoteDir);
fs.mkdirSync(projectRoot);
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeFile(projectRoot, '.gitignore', 'node_modules\n');
writeFile(projectRoot, 'package.json', JSON.stringify({ type: 'module' }));
writeFile(projectRoot, 'astro.config.mjs', 'export default {};\n');
// The publish check: passes, unless a test arms it to wait or to fail.
const barrierDir = path.join(tempRoot, 'barrier');
const checkCommand = `sh '${path.join(barrierDir, 'check.sh')}'`;
writeFile(projectRoot, 'astroadmin.config.js',
  `export default { git: { enabled: true, paths: ['src/content/', 'public/images/'] }, build: { check: ${JSON.stringify(checkCommand)} } };\n`);
writeFile(projectRoot, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeFile(projectRoot, 'src/content/pages/home.md', page('Home'));
writeFile(projectRoot, 'src/content/pages/about.md', page('About'));
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.mkdirSync(path.join(projectRoot, 'public/images'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'public/images/a.png'), PNG);
fs.writeFileSync(path.join(projectRoot, 'public/images/b.png'), PNG);
writeFile(projectRoot, 'public/images/.metadata.json', '{}\n');
git(projectRoot, 'init', '-q', '-b', 'main');
git(projectRoot, 'config', 'user.name', 'Editor');
git(projectRoot, 'config', 'user.email', 'editor@example.com');
git(projectRoot, 'add', '-A');
git(projectRoot, 'commit', '-q', '-m', 'initial');
git(projectRoot, 'remote', 'add', 'origin', remoteDir);
git(projectRoot, 'push', '-q', '-u', 'origin', 'main');

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
const localHead = () => git(projectRoot, 'rev-parse', 'HEAD');
const isAncestor = (ancestor, descendant) => tryGit(remoteDir, 'merge-base', '--is-ancestor', ancestor, descendant) !== null;
const gitPathExists = (name) => fs.existsSync(git(projectRoot, 'rev-parse', '--path-format=absolute', '--git-path', name));
const rebaseInProgress = () => gitPathExists('rebase-merge') || gitPathExists('rebase-apply');
/** Back to the remote's state, with nothing in progress. */
function resetSite() {
  if (rebaseInProgress()) tryGit(projectRoot, 'rebase', '--abort');
  if (gitPathExists('MERGE_HEAD')) tryGit(projectRoot, 'merge', '--abort');
  git(projectRoot, 'reset', '-q', '--hard');
  git(projectRoot, 'stash', 'clear');
  git(projectRoot, 'fetch', '-q');
  git(projectRoot, 'checkout', '-q', 'main');
  git(projectRoot, 'reset', '-q', '--hard', 'origin/main');
  git(projectRoot, 'clean', '-fdq');
  assert.equal(git(projectRoot, 'status', '--porcelain'), '');
}

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin', Origin: base };

const loginResponse = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...sameOrigin },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
assert.equal(loginResponse.status, 200, 'login');
const cookie = loginResponse.headers.get('set-cookie').split(';')[0];

async function post(route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', ...sameOrigin },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}
const publish = () => post('/api/publish', { message: 'Content update' });
const commitRoute = () => post('/api/git/commit', { message: 'Content commit' });
/** A dashboard save, through the store. */
const save = (slug, title, body = 'Text.\n') => post(`/api/content/pages/${slug}`, { data: { title }, body, type: 'content' });

function assertNoServerPath(body) {
  const text = JSON.stringify(body);
  assert.ok(!text.includes(tempRoot), `no server path in ${text}`);
  assert.ok(!/CONFLICT|rebase|MERGE_HEAD|fatal:|error:/i.test(text), `no git text in ${text}`);
}

/**
 * Barriers hold the server's git, or the publish check, at one point until
 * the test releases it (never by a timer, so the test cannot pass by a slow
 * request missing the window). They give up after 20 s, so a failing test
 * cannot hang.
 *
 * Not git hooks: the server runs git with hooks disabled (#67). A `git`
 * wrapper first on the server's PATH waits before or after one subcommand
 * when armed, and the publish check (build.check) waits when armed.
 */
const barrierSpec = path.join(barrierDir, 'spec');
const barrierMarker = path.join(barrierDir, 'reached');
const barrierRelease = path.join(barrierDir, 'release');
const checkFails = path.join(barrierDir, 'check-fails');
const waitForRelease = `touch "${barrierMarker}"
  i=0
  while [ ! -f "${barrierRelease}" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done`;
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
writeFile(barrierDir, 'bin/git', `#!/bin/sh
# The subcommand: the first argument that is not a global option.
sub=""
skip=0
for arg in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$arg" in
    -c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env) skip=1 ;;
    -*) ;;
    *) sub="$arg"; break ;;
  esac
done
phase=""
command=""
if [ -f "${barrierSpec}" ]; then read phase command < "${barrierSpec}"; fi
if [ "$phase" = before ] && [ "$sub" = "$command" ]; then
  ${waitForRelease}
fi
"${realGit}" "$@"
code=$?
if [ "$phase" = after ] && [ "$sub" = "$command" ]; then
  ${waitForRelease}
fi
exit $code
`);
fs.chmodSync(path.join(barrierDir, 'bin/git'), 0o755);
writeFile(barrierDir, 'check.sh', `#!/bin/sh
if [ -f "${barrierSpec}" ] && [ "$(cat "${barrierSpec}")" = check ]; then
  ${waitForRelease}
fi
[ ! -f "${checkFails}" ]
`);
// The server's git (simple-git and execFile alike) finds `git` on PATH when
// it spawns it.
process.env.PATH = `${path.join(barrierDir, 'bin')}${path.delimiter}${process.env.PATH}`;

/**
 * Arm a barrier: `['before', 'commit']` or `['after', 'pull']` (a git
 * subcommand, found past any `-c` options) or `['check']` (the publish
 * check's build command).
 */
function installBarrier(spec) {
  fs.rmSync(barrierMarker, { force: true });
  fs.rmSync(barrierRelease, { force: true });
  fs.writeFileSync(barrierSpec, `${spec.join(' ')}\n`);
  return {
    async reached() {
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(barrierMarker)) {
        assert.ok(Date.now() < deadline, `control: the server reached the barrier (${spec.join(' ')})`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    release: () => fs.writeFileSync(barrierRelease, ''),
    // Released first, so a barrier still waiting (a check that failed before
    // releasing it) exits instead of holding git, and the git lock, for 20 s.
    remove() {
      fs.writeFileSync(barrierRelease, '');
      fs.rmSync(barrierSpec, { force: true });
    },
  };
}
/** True when `promise` has not settled after `ms` (a save takes a few ms). */
async function stillPending(promise, ms = 400) {
  const pending = Symbol('pending');
  return (await Promise.race([promise.then(() => null, () => null), new Promise((resolve) => setTimeout(() => resolve(pending), ms))])) === pending;
}

let passed = 0;
class CheckFailed extends Error {}
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    throw new CheckFailed(name);
  }
}

try {
  console.log('\n🧪 Publishing onto a remote that moved on\n' + '='.repeat(40));

  await check('the commit route commits unstaged saves and rebases them onto a moved remote', async () => {
    const developerCommit = developerPushes('README.md', '# Site\n');
    assert.equal((await save('about', 'About us')).status, 200);
    assert.notEqual(git(projectRoot, 'status', '--porcelain'), '', 'control: the save is an unstaged edit');
    const { status, body } = await commitRoute();
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(remoteHead(), localHead(), 'the remote has the commit');
    assert.ok(isAncestor(developerCommit, remoteHead()), "the developer's commit is underneath");
    assert.equal(body.commit.hash, localHead(), 'the reported commit is the rebased one');
  });

  for (const [route, send] of [['publish', publish], ['the commit route', commitRoute]]) {
    await check(`${route}: a conflicting save is refused with 409 and the rebase is aborted`, async () => {
      developerPushes('src/content/pages/home.md', page(`Home (developer, ${route})`));
      const remoteBefore = remoteHead();
      assert.equal((await save('home', 'Home (editor)')).status, 200);
      const { status, body } = await send();
      assert.equal(status, 409, JSON.stringify(body));
      assert.equal(body.committed, true);
      assert.equal(body.pushed, false);
      assertNoServerPath(body);
      assert.equal(remoteHead(), remoteBefore, 'nothing pushed');
      assert.equal(rebaseInProgress(), false, 'the rebase was aborted');
      assert.equal(tryGit(projectRoot, 'symbolic-ref', '--short', 'HEAD'), 'main', 'back on the branch');
      assert.match(readSite('src/content/pages/home.md'), /Home \(editor\)/, "the editor's text is kept");
      resetSite();
    });
  }

  await check('a rebase someone else left stopped (detached HEAD) is refused and left alone', async () => {
    developerPushes('src/content/pages/home.md', page('Home (developer 2)'));
    writeFile(projectRoot, 'src/content/pages/home.md', page('Home (by hand)'));
    git(projectRoot, 'commit', '-qam', 'by hand');
    assert.equal(tryGit(projectRoot, 'pull', '-q', '--rebase'), null, 'control: the hand rebase stops');
    assert.equal(rebaseInProgress(), true, 'control: a rebase is in progress');
    const headBefore = localHead();
    writeFile(projectRoot, 'src/content/pages/about.md', page('About (editor)'));
    const { status, body } = await publish();
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.committed, false);
    assertNoServerPath(body);
    assert.equal(rebaseInProgress(), true, "someone else's rebase is not aborted");
    assert.equal(localHead(), headBefore, 'nothing committed');
    assert.equal(readSite('src/content/pages/about.md'), page('About (editor)'), "the editor's save is untouched");
    resetSite();
  });

  await check("a rebase's state left behind on an attached branch is refused before the commit", async () => {
    // What an interrupted rebase can leave: its state, with HEAD still on the branch.
    const rebaseState = git(projectRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge');
    fs.mkdirSync(rebaseState);
    fs.writeFileSync(path.join(rebaseState, 'head-name'), 'refs/heads/main\n');
    fs.writeFileSync(path.join(rebaseState, 'orig-head'), `${git(projectRoot, 'rev-parse', 'HEAD~1')}\n`);
    fs.writeFileSync(path.join(rebaseState, 'onto'), `${git(projectRoot, 'rev-parse', 'HEAD~1')}\n`);
    const headBefore = localHead();
    assert.equal((await save('about', 'About (attached)')).status, 200);
    const { status, body } = await publish();
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.committed, false);
    assert.equal(localHead(), headBefore, 'nothing committed, and no reset to an earlier HEAD');
    assert.equal(tryGit(projectRoot, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.match(readSite('src/content/pages/about.md'), /About \(attached\)/, "the editor's save is untouched");
    assert.ok(fs.existsSync(rebaseState), 'the state is left for a person to look at');
    const viaCommitRoute = await commitRoute();
    assert.equal(viaCommitRoute.status, 409, JSON.stringify(viaCommitRoute.body));
    assert.equal(viaCommitRoute.body.committed, false);
    assert.equal(localHead(), headBefore, 'the commit route committed nothing either');
    fs.rmSync(rebaseState, { recursive: true });
    resetSite();
  });

  await check('a merge someone else left unfinished is refused and left alone', async () => {
    developerPushes('src/content/pages/home.md', page('Home (developer 3)'));
    writeFile(projectRoot, 'src/content/pages/home.md', page('Home (merge by hand)'));
    git(projectRoot, 'commit', '-qam', 'merge by hand');
    git(projectRoot, 'fetch', '-q');
    assert.equal(tryGit(projectRoot, 'merge', '-q', 'origin/main'), null, 'control: the hand merge stops');
    assert.equal(gitPathExists('MERGE_HEAD'), true, 'control: a merge is in progress');
    const headBefore = localHead();
    const { status, body } = await publish();
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.committed, false);
    assert.equal(localHead(), headBefore);
    assert.equal(gitPathExists('MERGE_HEAD'), true, "someone else's merge is not touched");
    resetSite();
  });

  await check('unmerged files with no operation in progress (a stash pop that conflicted) are refused', async () => {
    writeFile(projectRoot, 'astro.config.mjs', 'export default { site: "https://stashed.example.com" };\n');
    git(projectRoot, 'stash', '-q');
    developerPushes('astro.config.mjs', 'export default { site: "https://developer-2.example.com" };\n');
    git(projectRoot, 'pull', '-q', '--rebase');
    assert.equal(tryGit(projectRoot, 'stash', 'pop', '-q'), null, 'control: the pop conflicts');
    assert.notEqual(git(projectRoot, 'ls-files', '-u'), '', 'control: files are unmerged');
    assert.equal(gitPathExists('MERGE_HEAD') || rebaseInProgress(), false, 'control: no operation is in progress');
    const headBefore = localHead();
    assert.equal((await save('about', 'About (unmerged)')).status, 200);
    const { status, body } = await publish();
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.committed, false);
    assert.equal(localHead(), headBefore, 'the conflict markers were not committed');
    resetSite();
  });

  await check('an inherited rebase.autoStash leaves no conflict markers in files outside git.paths', async () => {
    git(projectRoot, 'config', 'rebase.autoStash', 'true');
    try {
      developerPushes('astro.config.mjs', 'export default { site: "https://developer.example.com" };\n');
      // Someone's uncommitted edit of the same line, outside git.paths.
      const handEdit = 'export default { site: "https://hand.example.com" };\n';
      writeFile(projectRoot, 'astro.config.mjs', handEdit);
      assert.equal((await save('about', 'About (autostash)')).status, 200);
      const { status, body } = await publish();
      assert.equal(readSite('astro.config.mjs'), handEdit, 'the uncommitted edit is untouched, no markers');
      assert.equal(git(projectRoot, 'ls-files', '-u'), '', 'nothing unmerged');
      assert.equal(git(projectRoot, 'stash', 'list'), '', 'nothing left in the stash');
      assert.notEqual(status, 200, `not reported as published: ${JSON.stringify(body)}`);
    } finally {
      git(projectRoot, 'config', '--unset', 'rebase.autoStash');
      resetSite();
    }
  });

  await check('a save made while publish is rebasing waits, so the abort cannot discard it', async () => {
    developerPushes('src/content/pages/home.md', page('Home (developer 4)'));
    assert.equal((await save('home', 'Home (first save)')).status, 200);
    // `git pull --rebase` has stopped on the conflict (the rebase in
    // progress, not yet aborted): the barrier holds publish there.
    const barrier = installBarrier(['after', 'pull']);
    try {
      const publishing = publish();
      await barrier.reached();
      const saving = save('home', 'Home (second save)', 'Second.\n');
      assert.ok(await stillPending(saving), 'the save waits for the rebase');
      barrier.release();
      const [saved, published] = await Promise.all([saving, publishing]);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(published.status, 409, JSON.stringify(published.body));
      assert.match(readSite('src/content/pages/home.md'), /Home \(second save\)/,
        'the acknowledged save is on disk after the abort');
    } finally {
      barrier.remove();
      resetSite();
    }
  });

  await check('a save made while /api/git/pull is merging waits for it', async () => {
    developerPushes('src/content/pages/about.md', page('About (developer pull)'));
    const barrier = installBarrier(['after', 'pull']);
    try {
      const pulling = post('/api/git/pull', {});
      await barrier.reached();
      const saving = save('home', 'Home (during pull)');
      assert.ok(await stillPending(saving), 'the save waits for the pull');
      barrier.release();
      const [saved, pulled] = await Promise.all([saving, pulling]);
      assert.equal(pulled.status, 200, JSON.stringify(pulled.body));
      assert.equal(saved.status, 200);
      assert.match(readSite('src/content/pages/about.md'), /About \(developer pull\)/, 'control: the pull landed');
      assert.match(readSite('src/content/pages/home.md'), /Home \(during pull\)/);
    } finally {
      barrier.remove();
      resetSite();
    }
  });

  /** An upload whose body the test sends in two halves (or abandons). */
  function startSlowUpload(imageBytes, { signal } = {}) {
    const boundary = 'aaUploadBoundary';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="slow.png"\r\n`
      + 'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    let finish;
    let finished = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(head);
        controller.enqueue(imageBytes.subarray(0, 64 * 1024));
        finish = () => {
          if (finished) return;
          finished = true;
          try {
            controller.enqueue(imageBytes.subarray(64 * 1024));
            controller.enqueue(tail);
            controller.close();
          } catch {
            // already cancelled (an abandoned upload)
          }
        };
      },
    });
    const response = fetch(`${base}/api/images`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...sameOrigin },
      body,
      duplex: 'half',
      signal,
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    return { response, finish: () => finish() };
  }
  const uploadStagingDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('astroadmin-upload-')));
  const siteImages = () => fs.readdirSync(path.join(projectRoot, 'public/images'));
  /** Waits until the server has written part of the upload, wherever it writes it. */
  async function uploadIsStreaming(stagingBefore, imagesBefore) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const fresh = [...uploadStagingDirs()].filter((name) => !stagingBefore.has(name));
      const staged = fresh.flatMap((dir) => fs.readdirSync(path.join(os.tmpdir(), dir)));
      const inSite = siteImages().filter((name) => !imagesBefore.has(name));
      if (staged.length > 0 || inSite.length > 0) return;
      assert.ok(Date.now() < deadline, 'control: the upload started writing');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  await check('an upload in progress is never in the site, so publish cannot commit half an image', async () => {
    const imageBytes = Buffer.concat([PNG, Buffer.alloc(256 * 1024, 7)]);
    const imagesBefore = new Set(siteImages());
    const stagingBefore = uploadStagingDirs();
    const upload = startSlowUpload(imageBytes);
    try {
      await uploadIsStreaming(stagingBefore, imagesBefore);
      assert.deepEqual(siteImages().filter((name) => !imagesBefore.has(name)), [], 'nothing in the site while streaming');
      assert.equal((await save('home', 'Home (during upload)')).status, 200);
      const published = await publish();
      assert.equal(published.status, 200, JSON.stringify(published.body));
      assert.equal(git(projectRoot, 'ls-tree', '--name-only', 'HEAD', 'public/images/').split('\n').filter((name) => name.includes('slow')).length, 0,
        'no part of the upload was committed');
      upload.finish();
      const uploaded = await upload.response;
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
      const installed = path.join(projectRoot, 'public/images', uploaded.body.image.filename);
      assert.ok(fs.readFileSync(installed).equals(imageBytes), 'the installed image is whole');
      assert.deepEqual(siteImages().filter((name) => name.endsWith('.uploading')), [], 'no partial copy left');
      assert.equal([...uploadStagingDirs()].filter((name) => !stagingBefore.has(name)).length, 0, 'the staging folder is removed');
    } finally {
      upload.finish();
      await upload.response.catch(() => {});
      resetSite();
    }
  });

  await check('an upload abandoned mid-body leaves nothing in the site and does not hold up publishing', async () => {
    const imagesBefore = new Set(siteImages());
    const stagingBefore = uploadStagingDirs();
    const abandon = new AbortController();
    const upload = startSlowUpload(Buffer.concat([PNG, Buffer.alloc(256 * 1024, 9)]), { signal: abandon.signal });
    await uploadIsStreaming(stagingBefore, imagesBefore);
    abandon.abort();
    await upload.response.catch(() => {});
    assert.equal((await save('home', 'Home (after abandoned upload)')).status, 200);
    const publishing = publish();
    assert.ok(!(await stillPending(publishing, 5000)), 'publish is not held up by the abandoned upload');
    assert.equal((await publishing).status, 200);
    assert.deepEqual(siteImages().filter((name) => !imagesBefore.has(name)), [], 'nothing from it in the site');
    const deadline = Date.now() + 3000;
    while ([...uploadStagingDirs()].some((name) => !stagingBefore.has(name))) {
      assert.ok(Date.now() < deadline, 'the abandoned upload\'s staging folder is removed');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    resetSite();
  });

  await check("an image's details saved during publish's commit keep the details the rebase brings in", async () => {
    developerPushes('public/images/.metadata.json', `${JSON.stringify({ 'b.png': { alt: 'B (developer)' } })}\n`);
    assert.equal((await save('home', 'Home (metadata)')).status, 200);
    // Just before `git commit`: inside publish's hold, before the rebase.
    const barrier = installBarrier(['before', 'commit']);
    try {
      const publishing = publish();
      await barrier.reached();
      const updating = fetch(`${base}/api/images/a.png/metadata`, {
        method: 'PUT',
        headers: { cookie, 'Content-Type': 'application/json', ...sameOrigin },
        body: JSON.stringify({ alt: 'A (editor)' }),
      });
      assert.ok(await stillPending(updating), 'the update waits for the commit and rebase');
      barrier.release();
      const [updated, published] = await Promise.all([updating, publishing]);
      assert.equal(updated.status, 200);
      assert.equal(published.status, 200, JSON.stringify(published.body));
      const metadata = JSON.parse(readSite('public/images/.metadata.json'));
      assert.equal(metadata['b.png']?.alt, 'B (developer)', "the developer's details survive");
      assert.equal(metadata['a.png']?.alt, 'A (editor)', "the editor's details are saved");
    } finally {
      barrier.remove();
      resetSite();
    }
  });

  console.log(`\n📊 ${passed} checks passed.`);
} catch (error) {
  if (!(error instanceof CheckFailed)) console.error(error);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
