/**
 * API errors send a fixed, route-specific message and log the error itself,
 * over HTTP against the real createServer() app.
 *
 * Each failure is made real (file modes: the server can stat a chmod-000
 * file but not read it, and a read-only folder refuses an upload, a delete,
 * a metadata write and a save; a config that does not bundle). Each check
 * asserts three things:
 * - the failure HAPPENED: an error status, and the server log holds the
 *   original error, path and all (the positive control that the instrument
 *   saw the failure, not a quiet success);
 * - the response carries the route's fixed message, exactly;
 * - no server directory name appears anywhere in the response body.
 *
 * Routes covered: GET /api/images/entry-file (a file that vanishes after its
 * stat(), one it cannot open), GET /images/<file> (the app's error
 * middleware), POST /api/images, DELETE /api/images/<file>, PUT
 * /api/images/<file>/metadata, POST /api/reload-schemas, GET and PUT
 * /api/content/:collection/:slug with a config that does not bundle, POST
 * /api/content into a read-only folder, and the 404 for a missing entry.
 *
 *   bun tests/error-paths.test.js     (~3 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fsPromises from 'fs/promises';

const repoRoot = path.resolve(import.meta.dir, '..');
// The site and the admin's working directory are siblings, as on a server
// where both are checked out side by side: esbuild then names the config
// `../site-a/src/content.config.ts`, a climb that does not reach the root.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-error-paths-')));
const projectRoot = path.join(scratch, 'site-a');
const adminDir = path.join(scratch, 'admin-cwd');
fs.mkdirSync(projectRoot);
fs.mkdirSync(adminDir);
// Before anything starts esbuild, whose service keeps the directory it began in.
process.chdir(adminDir);
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;
// The development error middleware is the one that forwarded messages.
delete process.env.NODE_ENV;

// The server log: everything the app writes, kept for the positive controls.
const serverLog = [];
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    serverLog.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(' '));
    if (level === 'error' && process.env.VERBOSE) original(...args);
  };
}
const report = (line) => process.stdout.write(`${line}\n`);

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
const postsDir = path.join(projectRoot, 'src/content/posts');

const SERVER_PATH_SIGNS = [projectRoot, 'site-a', 'admin-cwd', 'aa-error-paths-', os.tmpdir(), fs.realpathSync(os.tmpdir()), os.homedir(), '/private/', '/var/folders/', '/Users/', '../'];
function assertNoServerPath(label, body) {
  for (const sign of SERVER_PATH_SIGNS) {
    assert.equal(body.includes(sign), false, `${label}: the response names a server path (${sign}): ${body}`);
  }
}

/** The positive control: what the server logged since `mark` holds every one of `fragments`. */
function assertLogged(mark, ...fragments) {
  const logged = serverLog.slice(mark).join('\n');
  for (const fragment of fragments) {
    assert.ok(logged.includes(fragment), `positive control: the server log has the original error (${fragment}); it has:\n${logged.slice(0, 2000)}`);
  }
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    report(`✅ ${name}`);
  } catch (error) {
    report(`❌ ${name}\n   ${error.stack || error.message}`);
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
    const body = await response.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      // not JSON: asserted on as text
    }
    return { status: response.status, body, json };
  };

  report('\n🧪 API errors: a fixed message, the error in the server log\n' + '='.repeat(40));

  fs.chmodSync(lockedEntryImage, 0o000);
  fs.chmodSync(lockedPublicImage, 0o000);
  // Positive control on the instrument: the server CAN stat it but not read it.
  assert.ok(fs.statSync(lockedEntryImage).isFile());
  assert.throws(() => fs.readFileSync(lockedEntryImage), /EACCES/);

  await check('GET /api/images/entry-file: a readable image is served (positive control)', async () => {
    const response = await request('/api/images/entry-file?collection=posts&slug=a&path=./readable.png');
    assert.equal(response.status, 200, response.body);
  });

  await check('GET /api/images/entry-file: a file that vanishes after its stat()', async () => {
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
    const mark = serverLog.length;
    try {
      const response = await request('/api/images/entry-file?collection=posts&slug=a&path=./vanishing.png');
      assert.ok(vanished, 'the route stat()ed the file and it then vanished (instrument control)');
      assert.equal(response.status, 404, response.body);
      assert.deepEqual(response.json, { success: false, error: 'Image not found' });
      assertLogged(mark, `${projectRoot}/src/content/posts/vanishing.png`);
      assertNoServerPath('entry-file', response.body);
    } finally {
      fsPromises.stat = realStat;
    }
  });

  await check('GET /api/images/entry-file: a file it cannot open', async () => {
    // Refused before sendFile (resolving the unreadable file fails the
    // containment check): a fixed 400, nothing of the path.
    const response = await request('/api/images/entry-file?collection=posts&slug=a&path=./locked.png');
    assert.equal(response.status, 400, response.body);
    assert.deepEqual(response.json, { success: false, error: 'That image is outside the project\'s image folders' });
    assertNoServerPath('entry-file', response.body);
  });

  await check('GET /images/<file>: a static file that cannot be read (the app error middleware)', async () => {
    const control = await request('/images/readable.png');
    assert.equal(control.status, 200, 'positive control: a readable file is served');
    const mark = serverLog.length;
    const response = await request('/images/locked.png');
    assert.equal(response.status, 500, response.body);
    assert.deepEqual(response.json, { error: 'Internal server error', message: 'Something went wrong; see the server log.' });
    assertLogged(mark, `${projectRoot}/public/images/locked.png`);
    assertNoServerPath('/images', response.body);
  });

  fs.chmodSync(imagesDir, 0o555);
  assert.throws(() => fs.writeFileSync(path.join(imagesDir, 'probe.png'), PNG), /EACCES/, 'the folder is read-only');

  await check('POST /api/images: an upload into a folder it cannot write', async () => {
    const form = new FormData();
    form.append('image', new Blob([PNG], { type: 'image/png' }), 'new.png');
    const mark = serverLog.length;
    const response = await request('/api/images', { method: 'POST', body: form });
    assert.equal(response.status, 500, response.body);
    assert.deepEqual(response.json, { success: false, error: 'Failed to store the image' });
    assertLogged(mark, `${projectRoot}/public/images/new`, 'EACCES');
    assertNoServerPath('upload', response.body);
  });

  await check('POST /api/images: a refused file type keeps its own message (the editor\'s to fix)', async () => {
    const form = new FormData();
    form.append('image', new Blob(['x'], { type: 'text/plain' }), 'notes.txt');
    const response = await request('/api/images', { method: 'POST', body: form });
    assert.equal(response.status, 400, response.body);
    assert.match(response.json.error, /^File type not allowed\. Allowed types: \.jpg/, response.body);
    assertNoServerPath('file type', response.body);
  });

  await check('DELETE /api/images/<file>: an unlink that fails', async () => {
    const mark = serverLog.length;
    const response = await request('/api/images/keep.png', { method: 'DELETE' });
    assert.equal(response.status, 500, response.body);
    assert.ok(fs.existsSync(path.join(imagesDir, 'keep.png')), 'the file is still there');
    assert.deepEqual(response.json, { success: false, error: 'Failed to delete image', message: 'The image could not be deleted; see the server log.' });
    assertLogged(mark, `unlink '${projectRoot}/public/images/keep.png'`);
    assertNoServerPath('delete', response.body);
  });

  await check('PUT /api/images/<file>/metadata: a metadata write that fails', async () => {
    const mark = serverLog.length;
    const response = await request('/api/images/readable.png/metadata', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alt: 'x' }),
    });
    assert.equal(response.status, 500, response.body);
    assert.deepEqual(response.json, { success: false, error: 'Failed to update image metadata', message: 'The image details could not be saved; see the server log.' });
    assertLogged(mark, `${projectRoot}/public/images/.metadata.json`);
    assertNoServerPath('metadata', response.body);
  });

  fs.chmodSync(imagesDir, 0o755);

  await check('POST /api/content: a save into a folder it cannot write', async () => {
    fs.chmodSync(postsDir, 0o555);
    const mark = serverLog.length;
    try {
      const response = await request('/api/content/posts/new-post', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { title: 'New' }, body: '' }),
      });
      assert.equal(response.status, 500, response.body);
      assert.deepEqual(response.json, { success: false, error: 'Failed to write content', message: 'This entry could not be saved; see the server log.' });
      assert.equal(fs.existsSync(path.join(postsDir, 'new-post.md')), false, 'nothing was written');
      assertLogged(mark, 'EACCES', `${projectRoot}/src/content/posts`);
      assertNoServerPath('save', response.body);
    } finally {
      fs.chmodSync(postsDir, 0o755);
    }
  });

  await check('DELETE /api/content: a missing entry is a 404 naming the entry it was asked for', async () => {
    const response = await request('/api/content/posts/missing', { method: 'DELETE' });
    assert.equal(response.status, 404, response.body);
    assert.deepEqual(response.json, { success: false, error: 'Content not found', message: 'Content not found: posts/missing' });
  });

  await check('a refused path keeps its own message (the editor\'s to fix, naming no path)', async () => {
    const response = await request('/api/content/undeclared/a');
    assert.equal(response.status, 400, response.body);
    assert.deepEqual(response.json, { success: false, error: 'Invalid content path', message: 'Unknown collection' });
  });

  await check('POST /api/reload-schemas: a config that does not bundle', async () => {
    fs.writeFileSync(configPath, `${CONFIG}\nexport const broken = ;\n`);
    try {
      const mark = serverLog.length;
      const response = await request('/api/reload-schemas', { method: 'POST' });
      assert.equal(response.status, 500, response.body);
      assert.deepEqual(response.json, { error: 'The content config could not be loaded; see the server log.' });
      // esbuild names the config relative to the admin's working directory.
      assertLogged(mark, 'Unexpected', '../site-a/src/content.config.ts');
      assertNoServerPath('reload-schemas', response.body);
    } finally {
      fs.writeFileSync(configPath, CONFIG);
    }
    const restored = await request('/api/reload-schemas', { method: 'POST' });
    assert.equal(restored.status, 200, `positive control: the restored config reloads (${restored.body})`);
  });

  // An esbuild failure used to reach the editor naming
  // `../site-a/src/content.config.ts`: a sibling checkout's directory. (The
  // collection routes fall back to empty lists when the schemas fail, so the
  // content routes carry it.)
  assert.equal(process.cwd(), adminDir, 'the server runs beside the site');
  try {
    const cases = [
      ['GET', '/api/content/posts/a', undefined, 500, { success: false, error: 'Failed to read content', message: 'This entry could not be read; see the server log.' }],
      ['PUT', '/api/content/posts/a', { frontmatter: { title: 'A' }, body: '' }, 500, { success: false, error: 'Failed to update content', message: 'This entry could not be saved; see the server log.' }],
    ];
    for (const [method, route, payload, status, expected] of cases) {
      await check(`${method} ${route}: a config that does not bundle`, async () => {
        fs.writeFileSync(configPath, `${CONFIG}\nexport const broken = ;\n`);
        const { clearSchemaCache } = await import('../server/utils/collections.js');
        clearSchemaCache();
        const mark = serverLog.length;
        const response = await request(route, payload
          ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
          : { method });
        assert.equal(response.status, status, response.body);
        assert.deepEqual(response.json, expected);
        assertLogged(mark, 'Unexpected', '../site-a/src/content.config.ts');
        assertNoServerPath(route, response.body);
      });
    }
  } finally {
    fs.writeFileSync(configPath, CONFIG);
    const { clearSchemaCache } = await import('../server/utils/collections.js');
    clearSchemaCache();
  }

  report('='.repeat(40));
  report(`\n📊 ${passed} checks passed.\n`);
} finally {
  server.close();
  for (const target of [lockedEntryImage, lockedPublicImage]) fs.chmodSync(target, 0o644);
  fs.chmodSync(imagesDir, 0o755);
  fs.chmodSync(postsDir, 0o755);
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
