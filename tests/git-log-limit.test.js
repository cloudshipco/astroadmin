/**
 * The `limit` of GET /api/git/log and GET /api/git/file-history is clamped to
 * 1..100 (default 10), over HTTP through the real createServer() app.
 *
 * It used to be `parseInt(req.query.limit) || 10`, so `?limit=-1` became
 * `--max-count=-1` (git's "no limit": the whole history) and `?limit=10000`
 * read ten thousand commits. The repository has more commits touching the
 * page than the cap, so an unclamped limit shows as too many commits.
 *
 *   bun tests/git-log-limit.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-git-log-limit-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

const MAX_LIMIT = 100;
const COMMIT_COUNT = MAX_LIMIT + 5;
const PAGE_FILE = 'src/content/pages/home.md';

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
const git = (args, input) => execFileSync('/usr/bin/git', args, { cwd: projectRoot, encoding: 'utf8', input }).trim();

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('.gitignore', 'node_modules\n');
writeProjectFile('package.json', JSON.stringify({ type: 'module', name: 'site' }));
writeProjectFile('astroadmin.config.js', "export default { git: { paths: ['src/content'] } };\n");
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeProjectFile(PAGE_FILE, '---\ntitle: Home 0\n---\n');
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'Test']);
git(['config', 'user.email', 'test@example.com']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'init']);

// COMMIT_COUNT more commits that each change the page, in one fast-import.
const parentHash = git(['rev-parse', 'HEAD']);
let importStream = '';
for (let commitNumber = 1; commitNumber <= COMMIT_COUNT; commitNumber++) {
  const content = `---\ntitle: Home ${commitNumber}\n---\n`;
  const message = `Edit ${commitNumber}\n`;
  importStream += 'commit refs/heads/main\n'
    + `committer Test <test@example.com> ${1700000000 + commitNumber} +0000\n`
    + `data ${Buffer.byteLength(message)}\n${message}`
    + (commitNumber === 1 ? `from ${parentHash}\n` : '')
    + `M 100644 inline ${PAGE_FILE}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
}
git(['fast-import', '--quiet'], importStream);
git(['reset', '-q', '--hard', 'main']);
assert.equal(Number(git(['rev-list', '--count', 'HEAD', '--', PAGE_FILE])), COMMIT_COUNT + 1, 'fixture commits');

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
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
assert.equal(login.status, 200, 'login');
const cookie = login.headers.get('set-cookie').split(';')[0];

async function commitCount(route, limitParameter) {
  const separator = route.includes('?') ? '&' : '?';
  const url = limitParameter === undefined ? route : `${route}${separator}limit=${limitParameter}`;
  const response = await fetch(base + url, { headers: { cookie } });
  const body = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.commits.length;
}

console.log('\n🧪 git log and file-history limits\n' + '='.repeat(40));

const routes = ['/api/git/log', `/api/git/file-history?file=${encodeURIComponent(PAGE_FILE)}`];
for (const route of routes) {
  const routeName = route.split('?')[0];

  await check(`${routeName}: an ordinary limit is honoured (control)`, async () => {
    assert.equal(await commitCount(route, 3), 3);
    assert.equal(await commitCount(route, 25), 25);
    assert.equal(await commitCount(route, MAX_LIMIT), MAX_LIMIT);
  });

  await check(`${routeName}: no limit, or one that is not a number, is the default 10`, async () => {
    assert.equal(await commitCount(route, undefined), 10);
    assert.equal(await commitCount(route, 'abc'), 10);
    assert.equal(await commitCount(route, ''), 10);
  });

  await check(`${routeName}: -1 and 0 read one commit, not the whole history`, async () => {
    assert.equal(await commitCount(route, -1), 1);
    assert.equal(await commitCount(route, 0), 1);
    assert.equal(await commitCount(route, -100000), 1);
  });

  await check(`${routeName}: a huge limit is capped at ${MAX_LIMIT}`, async () => {
    assert.equal(await commitCount(route, 10000), MAX_LIMIT);
    assert.equal(await commitCount(route, MAX_LIMIT + 1), MAX_LIMIT);
    assert.equal(await commitCount(route, '1e9'), 1);
  });
}

server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
