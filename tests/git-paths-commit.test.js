/**
 * Publish and the commit route stage only the git paths that are strictly
 * inside the site (#84), the same filtered list status, diff and revert use
 * (`getAllowedGitPaths`, server/utils/git-paths.js).
 *
 * The raw `git.paths` used to be staged: `'./'` committed the whole site
 * (a hand edit of package.json went out with the editor's content), and
 * `'../other'` committed a sibling folder of the repository.
 *
 * The site is `site-a/` inside its repository, beside `other/`. Runs the real
 * createServer() app; astroadmin.config.js reads git.paths from a global
 * through a getter, so one server serves every case. The publish check is a
 * trivial command and there is no upstream (nothing is pushed). ~2 s.
 *
 *   bun tests/git-paths-commit.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const astroadminRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-git-paths-commit-')));
const repoRoot = path.join(tempRoot, 'checkout');
const projectRoot = path.join(repoRoot, 'site-a');

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
const page = (title) => `---\ntitle: ${title}\n---\nText.\n`;

fs.mkdirSync(projectRoot, { recursive: true });
fs.symlinkSync(path.join(astroadminRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeFile(repoRoot, 'other/notes.md', 'notes\n');
writeFile(projectRoot, '.gitignore', 'node_modules\n');
writeFile(projectRoot, 'package.json', JSON.stringify({ type: 'module' }));
writeFile(projectRoot, 'astroadmin.config.js',
  "export default { git: { enabled: true, get paths() { return globalThis.__testGitPaths; } }, build: { check: 'true' } };\n");
writeFile(projectRoot, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeFile(projectRoot, 'src/content/pages/home.md', page('Home'));
git(repoRoot, 'init', '-q', '-b', 'main');
git(repoRoot, 'config', 'user.name', 'Editor');
git(repoRoot, 'config', 'user.email', 'editor@example.com');
git(repoRoot, 'add', '-A');
git(repoRoot, 'commit', '-q', '-m', 'initial');

globalThis.__testGitPaths = ['src/content/'];
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

const head = () => git(repoRoot, 'rev-parse', 'HEAD');
/** Files changed by the commits after `since`, repository-relative. */
const committedSince = (since) => git(repoRoot, 'diff', '--name-only', since, 'HEAD').split('\n').filter(Boolean).sort();

/** A hand edit of package.json, one of a sibling, and an editor's content edit. */
function editEverything(label) {
  writeFile(projectRoot, 'package.json', JSON.stringify({ type: 'module', scripts: { postinstall: label } }));
  writeFile(repoRoot, 'other/notes.md', `notes ${label}\n`);
  writeFile(projectRoot, 'src/content/pages/home.md', page(`Home ${label}`));
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
  }
}

const routes = [
  ['publish', () => post('/api/publish', { message: 'Editor publish' })],
  ['the commit route', () => post('/api/git/commit', { message: 'Editor commit' })],
];

try {
  console.log('\n🧪 Committing stages only git paths inside the site\n' + '='.repeat(40));

  for (const [route, send] of routes) {
    await check(`${route}: control, ['src/content/'] commits the content and nothing else`, async () => {
      globalThis.__testGitPaths = ['src/content/'];
      editEverything(`control ${route}`);
      const before = head();
      const { status, body } = await send();
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual(committedSince(before), ['site-a/src/content/pages/home.md']);
    });

    for (const gitPaths of [['./'], ['../other'], ['./', 'src/content/'], ['../other', 'src/content/'], ['.', '', 'src/..']]) {
      await check(`${route}: git.paths ${JSON.stringify(gitPaths)} commits nothing outside the site's own paths`, async () => {
        globalThis.__testGitPaths = gitPaths;
        editEverything(`${JSON.stringify(gitPaths)} ${route}`);
        const before = head();
        await send();
        const committed = committedSince(before);
        assert.equal(committed.includes('site-a/package.json'), false, `package.json committed: ${committed}`);
        assert.equal(committed.includes('other/notes.md'), false, `a sibling committed: ${committed}`);
        const keepsContent = gitPaths.includes('src/content/');
        assert.deepEqual(committed, keepsContent ? ['site-a/src/content/pages/home.md'] : [],
          'exactly the content, when a real path is configured');
        // Whatever was not committed is still the hand edit on disk.
        assert.match(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'), /postinstall/);
      });
    }
  }

  // The default git paths name folders a site may not have (src/styles/):
  // a path that does not exist is skipped quietly, while one whose tracked
  // files were all deleted is still staged (the deletion is committed).
  await check('a configured path that does not exist is skipped without a note; a deleted one is committed', async () => {
    writeFile(projectRoot, 'src/retired/old.md', page('Old'));
    git(repoRoot, 'add', 'site-a/src/retired/old.md');
    git(repoRoot, 'commit', '-qm', 'a folder to retire');
    fs.rmSync(path.join(projectRoot, 'src/retired'), { recursive: true });
    globalThis.__testGitPaths = ['src/content/', 'src/styles/', 'src/retired/'];
    writeFile(projectRoot, 'src/content/pages/home.md', page('Home (quiet staging)'));
    const before = head();
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logged.push(args.join(' '));
      originalLog(...args);
    };
    let response;
    try {
      response = await post('/api/publish', { message: 'Quiet staging' });
    } finally {
      console.log = originalLog;
    }
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(committedSince(before), ['site-a/src/content/pages/home.md', 'site-a/src/retired/old.md'],
      'the edit and the deletion are committed');
    assert.ok(logged.some((line) => line.includes('Committed')), `control: the publish's own log lines were captured: ${logged}`);
    assert.deepEqual(logged.filter((line) => /Staging note|pathspec/.test(line)), [], 'no note for a missing path');
  });
} finally {
  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
