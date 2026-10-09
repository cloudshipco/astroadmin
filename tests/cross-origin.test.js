/**
 * State-changing API requests from another origin are refused.
 *
 * SameSite=Strict is per SITE, so the session cookie still rides on requests
 * from a sibling origin of the same site (the hosted preview subdomain, which
 * SESSION_COOKIE_DOMAIN shares the cookie with; another localhost port in
 * development). A form-encoded or multipart POST needs no CORS preflight, so
 * without a check such a page could save, revert, upload, publish, or log the
 * editor in or out. `server/utils/same-origin.js` refuses any non-GET/HEAD/
 * OPTIONS /api request unless Sec-Fetch-Site is same-origin/none or, with no
 * Sec-Fetch-Site, the Origin is absent or the admin's own.
 *
 * Every refusal is checked on DISK (file bytes, the images folder, git HEAD,
 * the session), and every refused route also has a same-origin positive
 * control that does change it.
 *
 *   bun tests/cross-origin.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import express from 'express';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cross-origin-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
const git = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('.gitignore', 'node_modules\n');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
// The publish check runs a trivial command: this test is about who may call
// publish, not about the build (tests/publish-check.test.js covers that).
writeProjectFile('astroadmin.config.js', "export default { build: { check: 'true' } };\n");
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
const HOME = '---\ntitle: Home\n---\nHome.\n';
writeProjectFile('src/content/pages/home.md', HOME);
writeProjectFile('src/content/pages/other.md', '---\ntitle: Other\n---\nOther.\n');
fs.mkdirSync(path.join(projectRoot, 'public/images'), { recursive: true });
git(['init', '-q']);
git(['config', 'user.name', 'Test']);
git(['config', 'user.email', 'test@example.com']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'init']);

const homePath = path.join(projectRoot, 'src/content/pages/home.md');
const otherPath = path.join(projectRoot, 'src/content/pages/other.md');
const imagesDir = path.join(projectRoot, 'public/images');

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

async function login(headers = {}) {
  return fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
}
const loginResponse = await login({ 'Sec-Fetch-Site': 'same-origin', Origin: base });
assert.equal(loginResponse.status, 200, 'login');
const cookie = loginResponse.headers.get('set-cookie').split(';')[0];

const SIBLING = 'http://preview.example.test';
const HOSTILE_HEADERS = [
  ['Sec-Fetch-Site: same-site', { 'Sec-Fetch-Site': 'same-site', Origin: SIBLING }],
  ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://evil.test' }],
  ['a foreign Origin with no Sec-Fetch-Site', { Origin: SIBLING }],
  ['Origin: null with no Sec-Fetch-Site', { Origin: 'null' }],
  ['Origin on another port of the same host', { Origin: base.replace(/:\d+$/, ':1') }],
];
const SAME_ORIGIN_HEADERS = [
  ['Sec-Fetch-Site: same-origin', { 'Sec-Fetch-Site': 'same-origin', Origin: base }],
  ['Sec-Fetch-Site: none', { 'Sec-Fetch-Site': 'none' }],
  ['no Sec-Fetch-Site and Origin equal to the admin', { Origin: base }],
  ['no Sec-Fetch-Site and no Origin (a non-browser client)', {}],
];

const formSave = (headers, title) => fetch(`${base}/api/content/pages/home`, {
  method: 'POST',
  headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: `data[title]=${encodeURIComponent(title)}&body=pwned&type=content`,
});
const jsonSave = (headers, title) => fetch(`${base}/api/content/pages/home`, {
  method: 'POST',
  headers: { cookie, 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ data: { title }, body: 'Saved.\n', type: 'content' }),
});
const imageFiles = () => fs.readdirSync(imagesDir).sort();
async function sessionIsLive() {
  const response = await fetch(`${base}/api/session`, { headers: { cookie } });
  return (await response.json()).authenticated === true;
}

console.log('\n🧪 cross-origin writes\n' + '='.repeat(40));

await check('a form-encoded content save from another origin is refused and writes nothing', async () => {
  for (const [label, headers] of HOSTILE_HEADERS) {
    const before = fs.readFileSync(homePath);
    const response = await formSave(headers, 'CSRF-WROTE-THIS');
    assert.equal(response.status, 403, `${label}: got ${response.status}`);
    assert.ok(fs.readFileSync(homePath).equals(before), `${label}: home.md changed`);
  }
});

await check('a JSON content save from another origin is refused and writes nothing', async () => {
  for (const [label, headers] of HOSTILE_HEADERS) {
    const before = fs.readFileSync(homePath);
    const response = await jsonSave(headers, 'CSRF-WROTE-THIS');
    assert.equal(response.status, 403, `${label}: got ${response.status}`);
    assert.ok(fs.readFileSync(homePath).equals(before), `${label}: home.md changed`);
  }
});

await check('a JSON content save from the admin itself writes the file (positive control)', async () => {
  for (const [index, [label, headers]] of SAME_ORIGIN_HEADERS.entries()) {
    const title = `Saved ${index}`;
    const response = await jsonSave(headers, title);
    assert.equal(response.status, 200, `${label}: got ${response.status} ${await response.text()}`);
    assert.ok(fs.readFileSync(homePath, 'utf8').includes(`title: ${title}`), `${label}: not written`);
  }
});

await check('a form-encoded body is no longer parsed even from the admin (nothing posts forms)', async () => {
  const before = fs.readFileSync(homePath);
  const response = await formSave({ 'Sec-Fetch-Site': 'same-origin', Origin: base }, 'FORM');
  assert.notEqual(response.status, 200, 'a form-encoded save succeeded');
  assert.ok(fs.readFileSync(homePath).equals(before), 'home.md changed');
});

await check('a cross-origin DELETE is refused; the same request from the admin deletes', async () => {
  for (const [label, headers] of HOSTILE_HEADERS) {
    const response = await fetch(`${base}/api/content/pages/other`, { method: 'DELETE', headers: { cookie, ...headers } });
    assert.equal(response.status, 403, `${label}: got ${response.status}`);
    assert.ok(fs.existsSync(otherPath), `${label}: other.md deleted`);
  }
  const response = await fetch(`${base}/api/content/pages/other`, { method: 'DELETE', headers: { cookie, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(response.status, 200, `same-origin delete: ${response.status}`);
  assert.equal(fs.existsSync(otherPath), false, 'same-origin delete left the file');
});

await check('a cross-origin image upload is refused and stores nothing; a same-origin one stores it', async () => {
  const upload = (headers) => {
    const form = new FormData();
    form.append('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'photo.png');
    return fetch(`${base}/api/images`, { method: 'POST', headers: { cookie, ...headers }, body: form });
  };
  for (const [label, headers] of HOSTILE_HEADERS) {
    const response = await upload(headers);
    assert.equal(response.status, 403, `${label}: got ${response.status}`);
    assert.deepEqual(imageFiles(), [], `${label}: an image was stored`);
  }
  const response = await upload({ 'Sec-Fetch-Site': 'same-origin', Origin: base });
  assert.equal(response.status, 200, `same-origin upload: ${response.status}`);
  assert.equal(imageFiles().length, 1, 'same-origin upload stored nothing');
});

await check('a cross-origin revert-file is refused and the edit survives; a same-origin one reverts', async () => {
  const edited = fs.readFileSync(homePath);
  assert.notEqual(edited.toString(), HOME, 'precondition: home.md is edited');
  for (const [label, headers] of HOSTILE_HEADERS) {
    for (const contentType of ['application/x-www-form-urlencoded', 'application/json']) {
      const body = contentType === 'application/json'
        ? JSON.stringify({ file: 'src/content/pages/home.md' })
        : 'file=src/content/pages/home.md';
      const response = await fetch(`${base}/api/git/revert-file`, {
        method: 'POST', headers: { cookie, 'Content-Type': contentType, ...headers }, body,
      });
      assert.equal(response.status, 403, `${label} (${contentType}): got ${response.status}`);
      assert.ok(fs.readFileSync(homePath).equals(edited), `${label} (${contentType}): home.md reverted`);
    }
  }
  const response = await fetch(`${base}/api/git/revert-file`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: base },
    body: JSON.stringify({ file: 'src/content/pages/home.md' }),
  });
  assert.equal(response.status, 200, `same-origin revert: ${response.status}`);
  assert.equal(fs.readFileSync(homePath, 'utf8'), HOME, 'same-origin revert did not restore the file');
});

await check('a cross-origin publish commits nothing; a same-origin publish commits', async () => {
  const saved = await jsonSave({ 'Sec-Fetch-Site': 'same-origin' }, 'To publish');
  assert.equal(saved.status, 200, 'setup save');
  const headBefore = git(['rev-parse', 'HEAD']);
  for (const [label, headers] of HOSTILE_HEADERS) {
    for (const route of ['/api/publish', '/api/git/publish', '/api/git/commit']) {
      const response = await fetch(base + route, {
        method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: 'message=csrf',
      });
      assert.equal(response.status, 403, `${label} ${route}: got ${response.status}`);
      assert.equal(git(['rev-parse', 'HEAD']), headBefore, `${label} ${route}: a commit was made`);
    }
  }
  const response = await fetch(`${base}/api/publish`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: base },
    body: JSON.stringify({ message: 'Publish from the admin' }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, `same-origin publish: ${response.status} ${body}`);
  assert.notEqual(git(['rev-parse', 'HEAD']), headBefore, 'same-origin publish made no commit');
  assert.equal(git(['log', '-1', '--format=%s']), 'Publish from the admin');
});

await check('cross-origin login and logout are refused; the session is untouched', async () => {
  for (const [label, headers] of HOSTILE_HEADERS) {
    const loginAttempt = await login(headers);
    assert.equal(loginAttempt.status, 403, `${label} login: got ${loginAttempt.status}`);
    assert.equal(loginAttempt.headers.get('set-cookie'), null, `${label} login: set a cookie`);
    const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, ...headers } });
    assert.equal(logout.status, 403, `${label} logout: got ${logout.status}`);
    assert.equal(await sessionIsLive(), true, `${label}: the session was destroyed`);
  }
});

await check('GETs are unaffected by Sec-Fetch-Site and Origin', async () => {
  for (const [label, headers] of HOSTILE_HEADERS) {
    for (const route of ['/api/session', '/api/collections', '/api/content/pages/home', '/api/git/status']) {
      const response = await fetch(base + route, { headers: { cookie, ...headers } });
      assert.equal(response.status, 200, `${label} GET ${route}: got ${response.status}`);
    }
  }
});

await check('a same-origin logout ends the session (positive control, last)', async () => {
  const response = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, 'Sec-Fetch-Site': 'same-origin', Origin: base } });
  assert.equal(response.status, 200);
  assert.equal(await sessionIsLive(), false, 'the session survived logout');
});

server.close();

// Behind a reverse proxy (the NixOS module's nginx, recommendedProxySettings:
// Host $host, X-Forwarded-Proto $scheme) with `trust proxy` (production), the
// admin's own origin is the public https one, from Host + X-Forwarded-Proto,
// or from ALLOWED_ORIGINS when the Host the app sees is not the public one.
console.log('\n🧪 the guard behind a proxy\n' + '='.repeat(40));
const { requireSameOrigin } = await import('../server/utils/same-origin.js');

async function guardStatus(configuredOrigins, headers) {
  const proxied = express();
  proxied.set('trust proxy', 1);
  proxied.use('/api', requireSameOrigin(configuredOrigins));
  proxied.post('/api/write', (req, res) => res.sendStatus(204));
  const listener = proxied.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/write`, { method: 'POST', headers });
    return response.status;
  } finally {
    listener.close();
  }
}

await check('the public https origin (Host + X-Forwarded-Proto) is the admin', async () => {
  const proxy = { Host: 'site-a.admin.example.com', 'X-Forwarded-Proto': 'https' };
  assert.equal(await guardStatus([], { ...proxy, Origin: 'https://site-a.admin.example.com' }), 204);
  assert.equal(await guardStatus([], { ...proxy, Origin: 'https://preview.site-a.admin.example.com' }), 403);
  assert.equal(await guardStatus([], { ...proxy, Origin: 'http://site-a.admin.example.com' }), 403, 'scheme must match too');
  assert.equal(await guardStatus([], { ...proxy, 'Sec-Fetch-Site': 'same-site', Origin: 'https://site-a.admin.example.com' }), 403, 'Sec-Fetch-Site wins');
});

await check('ALLOWED_ORIGINS names the admin when the Host the app sees is not public', async () => {
  const internal = { Host: '127.0.0.1:4000' };
  assert.equal(await guardStatus(['https://site-a.admin.example.com'], { ...internal, Origin: 'https://site-a.admin.example.com' }), 204);
  assert.equal(await guardStatus(['https://site-a.admin.example.com'], { ...internal, Origin: 'https://preview.site-a.admin.example.com' }), 403);
  // Control: without the configured origin the same request is refused.
  assert.equal(await guardStatus([], { ...internal, Origin: 'https://site-a.admin.example.com' }), 403);
  // '*' (development's CORS setting) never means "every origin is ours".
  assert.equal(await guardStatus('*', { ...internal, Origin: 'https://evil.test' }), 403);
  assert.equal(await guardStatus(['*'], { ...internal, Origin: 'https://evil.test' }), 403);
});

fs.rmSync(projectRoot, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
