/**
 * Picking or uploading an image for an Astro image() field never reads or
 * writes through a symlink that leaves the project's image folders.
 *
 * POST /api/images/:filename/entry-value copies a public upload into
 * src/content/assets/images (tracked, and published), and answers a path the
 * build will import. A symlink in an image folder pointing outside it (or an
 * image folder, or the destination folder, that is itself a link out) used to
 * be followed: stat() accepted it and copyFile() copied the outside file into
 * the repo. Every source and destination is now checked with
 * assertContainedPath (server/utils/glob-files.js), through realpath, against
 * its own image folder and the project root.
 *
 * Builds a throwaway project with a sentinel file OUTSIDE it, starts
 * createServer(), logs in and drives the real routes.
 *
 *   bun tests/image-symlink.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-image-symlink-')));
const projectRoot = path.join(sandbox, 'site');
const outside = path.join(sandbox, 'outside');
fs.mkdirSync(projectRoot);
fs.mkdirSync(outside);
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

// Distinct bytes, so a copy of the sentinel is recognisable wherever it lands.
const SENTINEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('OUTSIDE-SENTINEL')]);
const INSIDE = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('inside-image')]);
fs.writeFileSync(path.join(outside, 'secret.png'), SENTINEL);
fs.mkdirSync(path.join(outside, 'folder'));
fs.writeFileSync(path.join(outside, 'folder', 'via-folder.png'), SENTINEL);

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  posts: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
    schema: ({ image }) => z.object({ title: z.string(), cover: image().optional() }),
  }),
};
`);
writeProjectFile('src/content/posts/a.md', '---\ntitle: A\n---\n');
writeProjectFile('public/images/real.png', INSIDE);
writeProjectFile('src/assets/images/.keep', '');
// A file symlink in each image folder, pointing out of the project.
fs.symlinkSync(path.join(outside, 'secret.png'), path.join(projectRoot, 'public/images/link.png'));
fs.symlinkSync(path.join(outside, 'secret.png'), path.join(projectRoot, 'src/assets/images/source-link.png'));

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

/** Every file under a directory (following nothing), with its bytes. */
function filesUnder(directory) {
  const found = [];
  if (!fs.existsSync(directory)) return found;
  for (const name of fs.readdirSync(directory)) {
    const full = path.join(directory, name);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) found.push(...filesUnder(full));
    else if (stat.isFile()) found.push({ full, bytes: fs.readFileSync(full) });
  }
  return found;
}

/** Whether any regular file inside the project holds the sentinel's bytes. */
function sentinelCopiedIntoProject() {
  return filesUnder(path.join(projectRoot, 'src')).some((file) => file.bytes.equals(SENTINEL))
    || filesUnder(path.join(projectRoot, 'public')).some((file) => file.bytes.equals(SENTINEL));
}

function namesNoServerPath(body) {
  const text = JSON.stringify(body);
  assert.equal(text.includes(sandbox), false, `a response named a server path: ${text}`);
}

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(login.status, 200, 'login');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const jsonHeaders = { cookie, 'Content-Type': 'application/json' };

  async function entryValue(filename, source) {
    const response = await fetch(`${base}/api/images/${encodeURIComponent(filename)}/entry-value`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ collection: 'posts', slug: 'a', source }),
    });
    return { status: response.status, body: await response.json() };
  }

  console.log('\n🧪 image() picker and symlinks\n' + '='.repeat(40));

  await check('control: a regular public image is copied into src/content/assets/images', async () => {
    const result = await entryValue('real.png', 'uploads');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.value, '../assets/images/real.png');
    assert.ok(fs.readFileSync(path.join(projectRoot, 'src/content/assets/images/real.png')).equals(INSIDE));
  });

  await check('a public image that is a symlink out of the project is refused, not copied', async () => {
    const result = await entryValue('link.png', 'uploads');
    assert.equal(result.status, 400, JSON.stringify(result.body));
    namesNoServerPath(result.body);
    assert.equal(fs.existsSync(path.join(projectRoot, 'src/content/assets/images/link.png')), false, 'a copy was made');
    assert.equal(sentinelCopiedIntoProject(), false, 'the outside file was copied into the project');
  });

  await check('a src/assets image that is a symlink out of the project is refused, not handed to the build', async () => {
    const result = await entryValue('source-link.png', 'source');
    assert.equal(result.status, 400, JSON.stringify(result.body));
    namesNoServerPath(result.body);
  });

  await check('a public image folder that is itself a link out is refused', async () => {
    // public/images -> outside/folder: a symlinked ANCESTOR of the file.
    fs.renameSync(path.join(projectRoot, 'public/images'), path.join(projectRoot, 'public/images-real'));
    fs.symlinkSync(path.join(outside, 'folder'), path.join(projectRoot, 'public/images'));
    try {
      const result = await entryValue('via-folder.png', 'uploads');
      assert.equal(result.status, 400, JSON.stringify(result.body));
      namesNoServerPath(result.body);
      assert.equal(sentinelCopiedIntoProject(), false, 'the outside file was copied into the project');
    } finally {
      fs.unlinkSync(path.join(projectRoot, 'public/images'));
      fs.renameSync(path.join(projectRoot, 'public/images-real'), path.join(projectRoot, 'public/images'));
    }
  });

  await check('a destination folder that is a link out is refused: nothing is written outside', async () => {
    // src/content/assets -> outside/dest: the copy would land outside the repo.
    const destination = path.join(outside, 'dest');
    fs.mkdirSync(destination);
    fs.rmSync(path.join(projectRoot, 'src/content/assets'), { recursive: true, force: true });
    fs.symlinkSync(destination, path.join(projectRoot, 'src/content/assets'));
    writeProjectFile('public/images/second.png', INSIDE);
    const result = await entryValue('second.png', 'uploads');
    assert.equal(result.status, 400, JSON.stringify(result.body));
    namesNoServerPath(result.body);
    assert.deepEqual(filesUnder(destination), [], 'a file was written outside the project');
  });

  await check('an image() upload into a destination that links out is refused: nothing is written outside', async () => {
    const destination = path.join(outside, 'dest');
    const form = new FormData();
    form.append('image', new Blob([INSIDE], { type: 'image/png' }), 'upload.png');
    const response = await fetch(`${base}/api/images?for=image-field`, { method: 'POST', headers: { cookie }, body: form });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    namesNoServerPath(body);
    assert.deepEqual(filesUnder(destination), [], 'an upload was written outside the project');
  });

  await check('control: a plain public upload still works', async () => {
    const form = new FormData();
    form.append('image', new Blob([INSIDE], { type: 'image/png' }), 'plain.png');
    const response = await fetch(`${base}/api/images`, { method: 'POST', headers: { cookie }, body: form });
    assert.equal(response.status, 200, await response.text());
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  server.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
