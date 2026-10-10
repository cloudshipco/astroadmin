/**
 * Errors the image routes and the app's error middleware send name no server
 * path, over HTTP against the real createServer() app.
 *
 * Each failure is made real with file modes (the server can stat a chmod-000
 * file but not read it; a read-only folder refuses an upload, a delete and a
 * metadata write), and each check first proves the failure HAPPENED (an error
 * status, an error body) before asserting what the body does not contain:
 *
 * - GET /api/images/entry-file for a file that vanishes or cannot be opened
 *   after its stat(): sendFile() reports that through next(), past the
 *   route's try/catch, and the router's error middleware used to answer with
 *   the raw message, absolute filename included.
 * - GET /images/<file> (express.static) failing to read: the app's error
 *   middleware, which forwarded err.message in development.
 * - upload, delete and metadata writes failing on a read-only folder (multer's
 *   error, fs's EACCES `unlink '/abs/...'`).
 * - POST /api/reload-schemas with a config that does not bundle.
 *
 *   bun tests/error-paths.test.js     (~3 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fsPromises from 'fs/promises';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-error-paths-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;
// The development error middleware is the one that forwarded messages.
delete process.env.NODE_ENV;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
const CONFIG = `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  posts: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
    schema: ({ image }) => z.object({ title: z.string(), photo: image().optional() }),
  }),
};
`;
const configPath = writeProjectFile('src/content.config.ts', CONFIG);
writeProjectFile('src/content/posts/a.md', '---\ntitle: A\n---\n');
writeProjectFile('src/content/posts/readable.png', PNG);
const lockedEntryImage = writeProjectFile('src/content/posts/locked.png', PNG);
const vanishingImage = writeProjectFile('src/content/posts/vanishing.png', PNG);
writeProjectFile('public/images/readable.png', PNG);
const lockedPublicImage = writeProjectFile('public/images/locked.png', PNG);
writeProjectFile('public/images/keep.png', PNG);
const imagesDir = path.join(projectRoot, 'public/images');

const SERVER_PATH_SIGNS = [projectRoot, os.tmpdir(), fs.realpathSync(os.tmpdir()), os.homedir(), '/private/', '/var/folders/', '/Users/'];
function assertNoServerPath(label, body) {
  for (const sign of SERVER_PATH_SIGNS) {
    assert.equal(body.includes(sign), false, `${label}: the response names a server path (${sign}): ${body}`);
  }
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
  const request = async (urlPath, options = {}) => {
    const response = await fetch(base + urlPath, { ...options, headers: { cookie, ...(options.headers || {}) } });
    return { status: response.status, body: await response.text() };
  };

  console.log('\n🧪 errors name no server path\n' + '='.repeat(40));

  fs.chmodSync(lockedEntryImage, 0o000);
  fs.chmodSync(lockedPublicImage, 0o000);
  // Positive control on the instrument: the server CAN stat it but not read it.
  assert.ok(fs.statSync(lockedEntryImage).isFile());
  assert.throws(() => fs.readFileSync(lockedEntryImage), /EACCES/);

  await check('GET /api/images/entry-file: a readable image is served (positive control)', async () => {
    const response = await request('/api/images/entry-file?collection=posts&slug=a&path=./readable.png');
    assert.equal(response.status, 200, response.body);
  });

  await check('GET /api/images/entry-file: a file that vanishes after its stat() names no path', async () => {
    // The race made deterministic: the route's own stat() of vanishing.png
    // succeeds, then the file is removed before sendFile() opens it.
    let vanished = false;
    const realStat = fsPromises.stat;
    fsPromises.stat = async (...args) => {
      const result = await realStat(...args);
      if (String(args[0]).endsWith('vanishing.png') && fs.existsSync(vanishingImage)) {
        fs.unlinkSync(vanishingImage);
        vanished = true;
      }
      return result;
    };
    try {
      const response = await request('/api/images/entry-file?collection=posts&slug=a&path=./vanishing.png');
      assert.ok(vanished, 'the route stat()ed the file and it then vanished (instrument control)');
      assert.ok(response.status >= 400, `the failure happened (${response.status})`);
      assert.ok(response.body.length > 0, 'an error body');
      assertNoServerPath('entry-file', response.body);
    } finally {
      fsPromises.stat = realStat;
    }
  });

  await check('GET /api/images/entry-file: a file it cannot open names no path', async () => {
    const response = await request('/api/images/entry-file?collection=posts&slug=a&path=./locked.png');
    assert.ok(response.status >= 400, `the failure happened (${response.status})`);
    assertNoServerPath('entry-file', response.body);
  });

  await check('GET /images/<file>: a static file that cannot be read names no path', async () => {
    const control = await request('/images/readable.png');
    assert.equal(control.status, 200, 'positive control: a readable file is served');
    const response = await request('/images/locked.png');
    assert.ok(response.status >= 400, `the failure happened (${response.status})`);
    assertNoServerPath('/images', response.body);
  });

  fs.chmodSync(imagesDir, 0o555);
  assert.throws(() => fs.writeFileSync(path.join(imagesDir, 'probe.png'), PNG), /EACCES/, 'the folder is read-only');

  await check('POST /api/images: an upload into a folder it cannot write names no path', async () => {
    const form = new FormData();
    form.append('image', new Blob([PNG], { type: 'image/png' }), 'new.png');
    const response = await request('/api/images', { method: 'POST', body: form });
    assert.ok(response.status >= 400, `the failure happened (${response.status}): ${response.body}`);
    assertNoServerPath('upload', response.body);
  });

  await check('DELETE /api/images/<file>: an unlink that fails names no path', async () => {
    const response = await request('/api/images/keep.png', { method: 'DELETE' });
    assert.ok(response.status >= 400, `the failure happened (${response.status}): ${response.body}`);
    assert.ok(fs.existsSync(path.join(imagesDir, 'keep.png')), 'the file is still there');
    assertNoServerPath('delete', response.body);
  });

  await check('PUT /api/images/<file>/metadata: a metadata write that fails names no path', async () => {
    const response = await request('/api/images/readable.png/metadata', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alt: 'x' }),
    });
    assert.ok(response.status >= 400, `the failure happened (${response.status}): ${response.body}`);
    assertNoServerPath('metadata', response.body);
  });

  fs.chmodSync(imagesDir, 0o755);

  await check('POST /api/reload-schemas: a config that does not bundle names no path', async () => {
    fs.writeFileSync(configPath, `${CONFIG}\nexport const broken = ;\n`);
    const response = await request('/api/reload-schemas', { method: 'POST' });
    assert.ok(response.status >= 400, `the failure happened (${response.status}): ${response.body}`);
    assertNoServerPath('reload-schemas', response.body);
    // esbuild names the file `../../..`-relative to the working directory; it
    // comes back relative to the project, so the editor still learns which.
    assert.match(JSON.parse(response.body).error, /(^|\s)src\/content\.config\.ts:\d+/, response.body);
    fs.writeFileSync(configPath, CONFIG);
    const restored = await request('/api/reload-schemas', { method: 'POST' });
    assert.equal(restored.status, 200, `positive control: the restored config reloads (${restored.body})`);
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  server.close();
  for (const target of [lockedEntryImage, lockedPublicImage]) fs.chmodSync(target, 0o644);
  fs.chmodSync(imagesDir, 0o755);
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
