/**
 * The publish gate: the site's own Astro checks the exact commit before a push
 *
 * Builds a throwaway Astro 6 site with a bare git remote and drives the real
 * publish handler, so `astro sync` (this repo's devDependency) does the
 * validating. Asserts:
 *   - valid content is pushed, including shapes a re-implementation got wrong
 *     (an object-shaped file() collection);
 *   - content Astro rejects is committed locally but NOT pushed, and the
 *     refusal names the entry;
 *   - what is checked is the commit, not the working tree, and the combined
 *     result of a rebase onto the remote;
 *   - the check fails closed, and never touches the site's own Astro cache.
 *
 * Slow-ish (each publish runs astro sync, a few seconds).
 *
 *   bun tests/publish-check.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-publish-check-'));
const remoteDir = path.join(tempRoot, 'remote.git');
const projectRoot = path.join(tempRoot, 'site');
const otherClone = path.join(tempRoot, 'other');

// Must be set before config loads, hence the dynamic imports below.
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
delete process.env.GIT_AUTO_PUSH;

const SCHEMA_WITHOUT_SUMMARY = 'title: z.string(),';
const SCHEMA_WITH_SUMMARY = 'title: z.string(), summary: z.string(),';

function contentConfig(pageFields) {
  return `import { defineCollection, z } from 'astro:content';
import { glob, file } from 'astro/loaders';

// image(): a missing file passes astro sync but fails the build.
const covers = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/covers' }),
  schema: ({ image }) => z.object({ cover: image() }),
});

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({ ${pageFields} }),
});

// Object-shaped file() collection: valid in Astro.
const settings = defineCollection({
  loader: file('src/content/settings.json'),
  schema: z.object({ label: z.string() }),
});

export const collections = { pages, settings, covers };
`;
}

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function createJsonResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const remoteHead = () => git(remoteDir, 'rev-parse', 'main');
const remoteHasBranch = (branch) => git(remoteDir, 'branch', '--list', branch) !== '';

// The site's own Astro cache, which every check must leave alone. The test
// site's node_modules is this repo's, so this is the file a leak would rewrite.
const liveCacheFile = path.join(repoRoot, 'node_modules', '.astro', 'data-store.json');
const fileHash = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent');
const liveCacheBefore = fileHash(liveCacheFile);
const localHead = () => git(projectRoot, 'rev-parse', 'HEAD');

// --- The site and its remote -------------------------------------------------

git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remoteDir);
fs.mkdirSync(projectRoot);
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeFile(projectRoot, 'package.json', JSON.stringify({ type: 'module' }));
writeFile(projectRoot, 'astro.config.mjs', 'export default {};\n');
writeFile(projectRoot, 'astroadmin.config.js', "export default { git: { enabled: true, paths: ['src/content/'] } };\n");
writeFile(projectRoot, '.gitignore', 'node_modules\n.astro\ndist\n');
writeFile(projectRoot, 'src/content.config.ts', contentConfig(SCHEMA_WITHOUT_SUMMARY));
writeFile(projectRoot, 'src/content/pages/home.md', '---\ntitle: Home\n---\n');
writeFile(projectRoot, 'src/content/settings.json', '{ "site": { "label": "Example" } }\n');
writeFile(projectRoot, 'src/content/covers/first.md', '---\ncover: ./first.png\n---\n');
// Astro resolves an image() only when a page uses it, as real sites' pages do.
writeFile(projectRoot, 'src/pages/index.astro', `---
import { getCollection } from 'astro:content';
const covers = await getCollection('covers');
---
<html><body>{covers.map((entry) => <img src={entry.data.cover.src} alt="" />)}</body></html>
`);
// A 1x1 PNG, so the valid cover is a real image.
fs.writeFileSync(path.join(projectRoot, 'src/content/covers/first.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

git(projectRoot, 'init', '-q', '-b', 'main');
git(projectRoot, 'config', 'user.name', 'Test');
git(projectRoot, 'config', 'user.email', 'test@example.com');
git(projectRoot, 'add', '-A');
git(projectRoot, 'commit', '-q', '-m', 'initial');
git(projectRoot, 'remote', 'add', 'origin', remoteDir);
git(projectRoot, 'push', '-q', '-u', 'origin', 'main');

const { publishHandler } = await import('../server/api/publish.js');
const { checkHeadWithAstro, parseInvalidEntries, cleanCheckOutput } = await import('../server/utils/astro-check.js');
const { getConfig } = await import('../server/config.js');

async function publish() {
  const res = createJsonResponse();
  await publishHandler({ body: { message: 'Content update' } }, res);
  return res;
}

let passed = 0;
// Failure sentinel: already reported by check(), unwinds to the finally cleanup.
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

console.log('\n🧪 Publish gate (astro sync on the exact commit)\n' + '='.repeat(40));

await check("Astro's error names the entry it rejected", () => {
  const output = '[InvalidContentEntryDataError] pages → home data does not match collection schema.\n'
    + '[InvalidContentEntryDataError] pages → home data does not match collection schema.';
  assert.deepEqual(parseInvalidEntries(output), [{ collection: 'pages', slug: 'home' }]);
});

await check('valid content, including an object-shaped file() collection, is pushed', async () => {
  writeFile(projectRoot, 'src/content/pages/about.md', '---\ntitle: About\n---\n');
  const res = await publish();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.pushed, true);
  assert.equal(remoteHead(), localHead(), 'the remote has the new commit');
});

await check('content Astro rejects is committed locally but not pushed', async () => {
  const remoteBefore = remoteHead();
  writeFile(projectRoot, 'src/content/pages/broken.md', '---\nheading: no title here\n---\n');

  const res = await publish();

  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  assert.equal(res.body.committed, true);
  assert.equal(res.body.pushed, false);
  assert.deepEqual(res.body.check.entries, [{ collection: 'pages', slug: 'broken', editable: true }]);
  assert.ok(res.body.check.output.includes('InvalidContentEntryDataError'), 'Astro\'s own error is passed on');
  assert.ok(!res.body.check.output.includes(fs.realpathSync(os.tmpdir())), 'no server temp paths');
  assert.ok(!res.body.check.output.includes(fs.realpathSync(projectRoot)), 'no server project path');
  assert.ok(!res.body.check.output.includes('Stack trace'), 'no stack trace (it lists server paths)');
  assert.equal(remoteHead(), remoteBefore, 'nothing reached the remote');
  assert.notEqual(localHead(), remoteBefore, 'the edit is kept as a local commit');
});

await check('the commit is checked, not the working tree', async () => {
  // HEAD still holds the broken entry; a fix that exists only on disk must not count.
  writeFile(projectRoot, 'src/content/pages/broken.md', '---\ntitle: Fixed\n---\n');
  const fullConfig = await getConfig();
  assert.equal((await checkHeadWithAstro(fullConfig)).success, false, 'uncommitted fix ignored');
});

await check('publishing the fix commits it and pushes both commits', async () => {
  const res = await publish();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(remoteHead(), localHead());
});

await check('an uncommitted bad edit does not fail a check of a good HEAD', async () => {
  writeFile(projectRoot, 'src/content/pages/home.md', '---\nheading: broken on disk only\n---\n');
  const fullConfig = await getConfig();
  assert.equal((await checkHeadWithAstro(fullConfig)).success, true);
  git(projectRoot, 'checkout', '--', 'src/content/pages/home.md');
});

await check("an entry Astro names by an ID that is not an editor slug is not linked", async () => {
  // Astro slugifies the file name (ID "bad-page"); the editor's slug is "Bad Page".
  writeFile(projectRoot, 'src/content/pages/Bad Page.md', '---\nheading: no title\n---\n');
  const res = await publish();
  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  assert.deepEqual(res.body.check.entries, [{ collection: 'pages', slug: 'bad-page', editable: false }]);
  fs.rmSync(path.join(projectRoot, 'src/content/pages/Bad Page.md'));
  assert.equal((await publish()).statusCode, 200);
});

await check('a missing image() file is refused (the build checks what sync does not)', async () => {
  const remoteBefore = remoteHead();
  writeFile(projectRoot, 'src/content/covers/second.md', '---\ncover: ./missing.png\n---\n');
  const res = await publish();
  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  assert.equal(remoteHead(), remoteBefore);
  fs.rmSync(path.join(projectRoot, 'src/content/covers/second.md'));
  const fixed = await publish();
  assert.equal(fixed.statusCode, 200, JSON.stringify(fixed.body));
  assert.equal(remoteHead(), localHead());
});

await check('only the checked commit is pushed, never other configured refs', async () => {
  // A local branch holding content Astro rejects, and a push refspec that
  // would send it along with any bare `git push`.
  git(projectRoot, 'branch', 'other');
  git(projectRoot, 'checkout', '-q', 'other');
  writeFile(projectRoot, 'src/content/pages/other.md', '---\nheading: no title\n---\n');
  git(projectRoot, 'add', '-A');
  git(projectRoot, 'commit', '-qm', 'invalid, on another branch');
  git(projectRoot, 'checkout', '-q', 'main');
  git(projectRoot, 'config', 'remote.origin.push', 'refs/heads/other:refs/heads/other');

  writeFile(projectRoot, 'src/content/pages/contact.md', '---\ntitle: Contact\n---\n');
  const res = await publish();

  git(projectRoot, 'config', '--unset', 'remote.origin.push');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(remoteHead(), localHead(), 'the checked commit reached main');
  assert.equal(remoteHasBranch('other'), false, 'the unchecked branch did not');
});

await check('a tag with the same name as the branch does not stop the push', async () => {
  git(projectRoot, 'tag', 'main');
  writeFile(projectRoot, 'src/content/pages/tagged.md', '---\ntitle: Tagged\n---\n');
  const res = await publish();
  git(projectRoot, 'tag', '-d', 'main');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.pushed, true);
  assert.equal(remoteHead(), localHead());
});

await check('a push that fails is reported as NOT published', async () => {
  git(projectRoot, 'remote', 'set-url', 'origin', path.join(tempRoot, 'no-such-remote.git'));
  writeFile(projectRoot, 'src/content/pages/unsent.md', '---\ntitle: Unsent\n---\n');
  const res = await publish();
  git(projectRoot, 'remote', 'set-url', 'origin', remoteDir);
  assert.equal(res.statusCode, 502, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  assert.equal(res.body.committed, true);
  assert.ok(!res.body.message.includes(tempRoot), 'no remote path in the message');
  assert.equal((await publish()).statusCode, 200, 'publishes once the remote is back');
});

await check('the combined result of a rebase onto the remote is what gets checked', async () => {
  // Elsewhere, the schema gains a required field and is pushed.
  git(tempRoot, 'clone', '-q', remoteDir, otherClone);
  git(otherClone, 'config', 'user.name', 'Other');
  git(otherClone, 'config', 'user.email', 'other@example.com');
  writeFile(otherClone, 'src/content.config.ts', contentConfig(SCHEMA_WITH_SUMMARY));
  // Every existing page gets one, so the only page Astro can reject is the new one.
  for (const pageFile of fs.readdirSync(path.join(otherClone, 'src/content/pages'))) {
    const pagePath = path.join(otherClone, 'src/content/pages', pageFile);
    fs.writeFileSync(pagePath, fs.readFileSync(pagePath, 'utf-8').replace('---\n', '---\nsummary: ok\n'));
  }
  git(otherClone, 'commit', '-qam', 'require a summary');
  git(otherClone, 'push', '-q');
  const remoteBefore = remoteHead();

  // Here, a page without a summary is committed — valid against the OLD
  // schema — and the tree is clean, so publish's pull --rebase succeeds.
  writeFile(projectRoot, 'src/content/pages/news.md', '---\ntitle: News\n---\n');
  git(projectRoot, 'add', 'src/content/pages/news.md');
  git(projectRoot, 'commit', '-qm', 'add news');

  const res = await publish();

  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  assert.deepEqual(res.body.check.entries, [{ collection: 'pages', slug: 'news', editable: true }]);
  assert.equal(remoteHead(), remoteBefore, 'the invalid combination was not pushed');
});

await check('the check fails closed when it cannot run', async () => {
  const fullConfig = await getConfig();
  const result = await checkHeadWithAstro({ ...fullConfig, build: { check: 'exit 3' } });
  assert.equal(result.success, false);
});

await check("the check runs in its own worktree, at HEAD, without the site's Astro cache", async () => {
  const fullConfig = await getConfig();
  const result = await checkHeadWithAstro({
    ...fullConfig,
    build: { check: 'pwd; git rev-parse HEAD; test -L node_modules/astro && test ! -e node_modules/.astro && echo isolated' },
  });
  assert.equal(result.success, true, result.output);
  const [workingDirectory, checkedCommit, marker] = result.output.split('\n');
  // Server paths are stripped from output, so the worktree shows as relative.
  assert.equal(workingDirectory, 'worktree', 'ran in the check worktree (and its path was stripped)');
  assert.equal(checkedCommit, localHead());
  assert.equal(marker, 'isolated', 'packages linked, cache directory left out');
  assert.equal(git(projectRoot, 'worktree', 'list').split('\n').length, 1, 'the worktree was removed');
});

await check('a timed-out check kills everything it started', async () => {
  const marker = path.join(tempRoot, 'still-running');
  const fullConfig = await getConfig();
  const result = await checkHeadWithAstro({
    ...fullConfig,
    build: { check: `(sleep 2; touch ${marker}) & wait`, checkTimeoutMs: 300 },
  });
  assert.equal(result.success, false);
  assert.ok(result.output.includes('did not finish'), result.output);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(fs.existsSync(marker), false, 'the background child was killed too');
});

// --- Repository layouts beyond a single site at the root ----------------------

function makeRepo(name, files) {
  const root = path.join(tempRoot, name);
  for (const [relativePath, content] of Object.entries(files)) writeFile(root, relativePath, content);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initial');
  return root;
}

await check('a site with a git submodule (gitlink) is refused, not checked as empty', async () => {
  const plain = makeRepo('plain', { 'README.md': 'x\n', '.gitmodules': '# leftover, no gitlink\n' });
  assert.equal((await checkHeadWithAstro({ paths: { projectRoot: plain }, build: { check: 'true' } })).success, true,
    'control: a leftover .gitmodules with no gitlink is fine');
  const withGitlink = makeRepo('with-gitlink', { 'README.md': 'x\n' });
  // A real gitlink (mode 160000) and no .gitmodules at all.
  git(withGitlink, 'update-index', '--add', '--cacheinfo', `160000,${git(plain, 'rev-parse', 'HEAD')},content`);
  git(withGitlink, 'commit', '-qm', 'add a submodule');
  const result = await checkHeadWithAstro({ paths: { projectRoot: withGitlink }, build: { check: 'true' } });
  assert.equal(result.success, false);
  assert.ok(result.output.includes('submodules'), result.output);
});

await check('a monorepo site sees hoisted packages; a workspace package link is refused', async () => {
  const mono = makeRepo('mono', {
    '.gitignore': 'node_modules\n',
    'packages/schema/index.js': 'export default 1;\n',
    'site/package.json': '{}\n',
  });
  fs.mkdirSync(path.join(mono, 'node_modules/hoisted-package'), { recursive: true });
  const siteConfig = { paths: { projectRoot: path.join(mono, 'site') }, build: { check: 'test -d ../node_modules/hoisted-package && echo found' } };
  const hoisted = await checkHeadWithAstro(siteConfig);
  assert.equal(hoisted.success, true, hoisted.output);
  assert.equal(hoisted.output, 'found', 'control: the hoisted package is visible from the site');
  // The repository root sits above the site directory; its path is stripped too.
  const repoPath = await checkHeadWithAstro({ ...siteConfig, build: { check: `echo ${fs.realpathSync(mono)}/packages/schema` } });
  assert.equal(repoPath.output, 'packages/schema');

  // A link back into the repo would resolve to the live checkout's uncommitted code.
  fs.symlinkSync('../packages/schema', path.join(mono, 'node_modules/schema'));
  const linked = await checkHeadWithAstro(siteConfig);
  assert.equal(linked.success, false);
  assert.ok(linked.output.includes('workspace package (schema)'), linked.output);
});

await check('a check whose descendant daemonises still times out and settles', async () => {
  const pidFile = path.join(tempRoot, 'daemon.pid');
  // A grandchild in its own session keeps the output pipe open after the group is killed.
  const daemon = `python3 -c "import os,sys,time; os.setsid(); open('${pidFile}','w').write(str(os.getpid())); sys.stdout.flush(); time.sleep(20)" & wait`;
  const startedAt = Date.now();
  const result = await checkHeadWithAstro({ paths: { projectRoot }, build: { check: daemon, checkTimeoutMs: 1000 } });
  const elapsed = Date.now() - startedAt;
  const daemonPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf-8')) : null;
  if (daemonPid) {
    try { process.kill(daemonPid, 'SIGKILL'); } catch { /* gone */ }
  }
  assert.ok(daemonPid, 'control: the daemon really started');
  assert.equal(result.success, false);
  assert.ok(elapsed < 8000, `settled in ${elapsed} ms, not when the daemon exited`);
});

await check('a tracked .env stays as committed; an untracked one is copied in', async () => {
  const tracked = makeRepo('tracked-env', { '.env': 'VALUE=committed\n' });
  fs.writeFileSync(path.join(tracked, '.env'), 'VALUE=live edit\n');
  const trackedResult = await checkHeadWithAstro({ paths: { projectRoot: tracked }, build: { check: 'cat .env' } });
  assert.equal(trackedResult.output, 'VALUE=committed');

  const untracked = makeRepo('untracked-env', { '.gitignore': '.env\n' });
  fs.writeFileSync(path.join(untracked, '.env'), 'VALUE=local secret\n');
  const untrackedResult = await checkHeadWithAstro({ paths: { projectRoot: untracked }, build: { check: 'cat .env' } });
  assert.equal(untrackedResult.output, 'VALUE=local secret');
});

await check("the check builds the way the site is built, without the admin's secrets", async () => {
  const repo = makeRepo('commands', { 'README.md': 'x\n' });
  const production = await checkHeadWithAstro({ paths: { projectRoot: repo }, build: { production: 'echo production-build' } });
  assert.equal(production.output, 'production-build', 'build.production is used when there is no build.check');
  const explicit = await checkHeadWithAstro({ paths: { projectRoot: repo }, build: { check: 'echo check', production: 'echo production-build' } });
  assert.equal(explicit.output, 'check', 'build.check wins');

  process.env.SESSION_SECRET = 'do-not-leak';
  process.env.ADMIN_PASSWORD = 'do-not-leak';
  const envResult = await checkHeadWithAstro({
    paths: { projectRoot: repo },
    build: { check: 'echo "[$SESSION_SECRET][$ADMIN_PASSWORD][$ASTROADMIN_PROJECT_ROOT][${HOME:+home}]"' },
  });
  delete process.env.SESSION_SECRET;
  delete process.env.ADMIN_PASSWORD;
  assert.equal(envResult.output, '[][][][home]', 'admin variables gone, ordinary ones (HOME) kept');
});

await check('output shown to editors carries no server paths or stack frames', () => {
  const root = '/srv/sites/example site';
  const raw = [
    `Error at file://${encodeURI(root)}/src/content/pages/a.md`,
    `    at load (${root}/node_modules/astro/dist/x.js:1:2)`,
    `Location: ${root}/src/content/pages/a.md:0:0`,
  ].join('\n');
  const cleaned = cleanCheckOutput(raw, [root]);
  assert.ok(!cleaned.includes('/srv/sites'), cleaned);
  assert.ok(!cleaned.includes('    at '), 'stack frames removed');
  assert.ok(cleaned.includes('src/content/pages/a.md'), 'the useful relative path is kept');
});

await check("no check rewrote the site's own Astro cache", () => {
  assert.equal(fileHash(liveCacheFile), liveCacheBefore);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);

} catch (error) {
  if (!(error instanceof CheckFailed)) console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
