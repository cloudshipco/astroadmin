/**
 * Site files the admin serves on its OWN origin (/images, /assets) must never
 * run script there. An uploaded SVG is a document as well as an image: opened
 * directly on the admin origin, its <script> would run with the editor's
 * session. Every such response therefore carries a CSP that sandboxes it
 * (opaque origin, no script) and nosniff, while <img> display is unaffected
 * (a response CSP applies only when the file is rendered as a document).
 *
 * Builds a throwaway project, starts createServer(), logs in, uploads an SVG
 * through the real upload route and fetches it back.
 *
 *   bun tests/image-serving.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-image-serving-')));
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
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  articles: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({ title: z.string() }) }),
};
`);
writeProjectFile('src/content/articles/flat.md', '---\ntitle: Flat\n---\n');
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/><script>document.title="svg-script-ran"</script></svg>';
writeProjectFile('public/images/committed.svg', HOSTILE_SVG);
writeProjectFile('src/assets/images/source.svg', HOSTILE_SVG);
writeProjectFile('src/content/assets/posts/rel.svg', HOSTILE_SVG);
writeProjectFile('src/assets/project.svg', HOSTILE_SVG);
writeProjectFile('public/images/photo.png', Buffer.from('89504e470d0a1a0a', 'hex'));

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

/** The served file is the file (control), and it is sandboxed. */
async function assertSandboxed(urlPath, expectedType, expectedBody) {
  const response = await fetch(base + urlPath, { headers: { cookie } });
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, `${urlPath}: ${response.status}`);
  assert.ok(body.equals(Buffer.from(expectedBody)), `${urlPath}: served something other than the file`);
  assert.match(response.headers.get('content-type') || '', expectedType, `${urlPath}: content type`);
  const csp = response.headers.get('content-security-policy') || '';
  const directives = csp.split(';').map((d) => d.trim());
  assert.ok(directives.includes('sandbox'), `${urlPath}: no CSP sandbox (${csp || 'no CSP'})`);
  assert.ok(directives.includes("default-src 'none'"), `${urlPath}: CSP does not default to none (${csp})`);
  assert.equal(directives.some((d) => /^script-src/.test(d)), false, `${urlPath}: CSP allows script`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${urlPath}: no nosniff`);
}

console.log('\n🧪 site files served on the admin origin\n' + '='.repeat(40));

await check('an SVG uploaded through the editor is served sandboxed', async () => {
  const form = new FormData();
  form.append('image', new Blob([HOSTILE_SVG], { type: 'image/svg+xml' }), 'logo.svg');
  const upload = await fetch(`${base}/api/images`, { method: 'POST', headers: { cookie }, body: form });
  const uploaded = await upload.json();
  assert.equal(upload.status, 200, JSON.stringify(uploaded));
  assert.match(uploaded.image.url, /^\/images\/logo-\d+\.svg$/);
  await assertSandboxed(uploaded.image.url, /^image\/svg\+xml/, HOSTILE_SVG);
});

await check('committed SVGs under every admin-served folder are sandboxed', async () => {
  await assertSandboxed('/images/committed.svg', /^image\/svg\+xml/, HOSTILE_SVG); // public/images
  await assertSandboxed('/images/source.svg', /^image\/svg\+xml/, HOSTILE_SVG); // src/assets/images
  await assertSandboxed('/assets/posts/rel.svg', /^image\/svg\+xml/, HOSTILE_SVG); // src/content/assets
  await assertSandboxed('/assets/project.svg', /^image\/svg\+xml/, HOSTILE_SVG); // src/assets
});

await check('a raster image is served as itself, with the same headers', async () => {
  await assertSandboxed('/images/photo.png', /^image\/png/, Buffer.from('89504e470d0a1a0a', 'hex'));
});

await check('without a session, every admin-served folder refuses (draft files are not public)', async () => {
  const paths = [
    '/images/committed.svg', // public/images
    '/images/source.svg', // src/assets/images
    '/assets/posts/rel.svg', // src/content/assets
    '/assets/project.svg', // src/assets
    '/images/photo.png',
  ];
  for (const urlPath of paths) {
    const anonymous = await fetch(base + urlPath, { redirect: 'manual' });
    const body = Buffer.from(await anonymous.arrayBuffer());
    assert.equal(anonymous.status, 401, `${urlPath}: anonymous request got ${anonymous.status}`);
    assert.equal(body.includes(Buffer.from('<svg')), false, `${urlPath}: anonymous response carried the file`);
    // Positive control: the same path with the session is the file.
    const withSession = await fetch(base + urlPath, { headers: { cookie } });
    assert.equal(withSession.status, 200, `${urlPath}: logged-in request got ${withSession.status}`);
  }
  // A forged/expired cookie is no session either.
  const forged = await fetch(`${base}/images/committed.svg`, { headers: { cookie: 'connect.sid=s%3Anot-a-session.x' } });
  assert.equal(forged.status, 401, `forged cookie got ${forged.status}`);
});

await check("the admin's own pages are not sandboxed (control: the headers are scoped)", async () => {
  const response = await fetch(`${base}/login`);
  assert.equal(response.status, 200);
  assert.equal((response.headers.get('content-security-policy') || '').includes('sandbox'), false);
});

server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(process.exitCode || 0);
