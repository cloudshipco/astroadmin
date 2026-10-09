/**
 * `astroadmin dev` starts Astro where preview.url says the preview is, so the
 * "Preview:" URL it prints is the server it started. A fake astro package
 * records its arguments and listens on the port it was given.
 *
 *   bun tests/cli-dev.test.js
 *
 * Also that stopping `astroadmin dev` stops the Astro it started: Astro 7's
 * `astro dev` daemonises itself when it detects an AI agent (CLAUDECODE and
 * the like), which left it serving after astroadmin exited.
 *
 * Uses ports 3727/3728 (admin), 4727 (the fake astro) and 4729 (a real one).
 */

import assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linkNodeModules } from './link-node-modules.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cli-dev-'));
const ADMIN_PORT = 3727;
const ASTRO_PORT = 4727;

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
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

const { astroDevPortFor, DEFAULT_ASTRO_PORT } = await import('../server/config.js');

try {
  console.log('\n🧪 astroadmin dev: the Astro port\n' + '='.repeat(40));

  await check('astroDevPortFor: a local preview.url gives its port; anything else warns and uses 4321', () => {
    assert.deepEqual(astroDevPortFor('http://localhost:4610'), { port: 4610, warning: null });
    assert.deepEqual(astroDevPortFor('http://127.0.0.1:5000/'), { port: 5000, warning: null });
    assert.equal(DEFAULT_ASTRO_PORT, 4321);
    for (const url of ['http://localhost', 'https://preview.example.com', 'not a url']) {
      const result = astroDevPortFor(url);
      assert.equal(result.port, 4321, url);
      assert.match(result.warning, /4321/, url);
      assert.match(result.warning, /--no-astro/, url);
    }
  });

  await check('dev starts the site\'s astro on the port in astroadmin.config.js preview.url, and prints that URL', async () => {
    const siteDir = path.join(tempRoot, 'site');
    const argsFile = path.join(tempRoot, 'astro-args.json');
    writeFile(siteDir, 'package.json', JSON.stringify({ type: 'module' }));
    writeFile(siteDir, 'astro.config.mjs', 'export default {};\n');
    writeFile(siteDir, 'src/content.config.ts', 'export const collections = {};\n');
    writeFile(siteDir, 'astroadmin.config.js', `export default { preview: { url: 'http://localhost:${ASTRO_PORT}' } };\n`);
    // The fake astro: records argv, then serves on --port until killed.
    writeFile(siteDir, 'node_modules/astro/package.json', JSON.stringify({ name: 'astro', version: '0.0.0-fake', bin: { astro: 'astro.mjs' } }));
    writeFile(siteDir, 'node_modules/astro/astro.mjs', `import fs from 'fs';
import http from 'http';
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const port = Number(args[args.indexOf('--port') + 1]);
http.createServer((req, res) => res.end('fake astro')).listen(port, 'localhost');
`);
    // The admin's own dependencies, resolved from this checkout.
    linkNodeModules(repoRoot, siteDir, { skip: ['astro', '.bin'] });

    const child = spawn('bun', [path.join(repoRoot, 'bin/cli.js'), 'dev', '--project', siteDir, '--port', String(ADMIN_PORT)], {
      env: { ...process.env, ADMIN_PASSWORD: 'admin', ASTROADMIN_PORT: '', PORT: '', PREVIEW_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      const deadline = Date.now() + 40_000;
      while (!/AstroAdmin running/.test(output) && Date.now() < deadline && child.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      // Positive control: the CLI got as far as starting astro and the admin.
      assert.ok(fs.existsSync(argsFile), `the fake astro was started:\n${output}`);
      const args = JSON.parse(fs.readFileSync(argsFile, 'utf-8'));
      assert.deepEqual(args.slice(args.indexOf('dev'), args.indexOf('dev') + 3), ['dev', '--port', String(ASTRO_PORT)], `astro args: ${args.join(' ')}`);
      assert.match(output, new RegExp(`Preview: http://localhost:${ASTRO_PORT}`), output);
      assert.doesNotMatch(output, /⚠️/, 'no port warning for a local preview.url with a port');
      const response = await fetch(`http://localhost:${ASTRO_PORT}/`);
      assert.equal(await response.text(), 'fake astro', 'the printed preview URL reaches the astro it started');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.on('exit', resolve)));
    }
  });

  await check('stopping astroadmin dev stops the real Astro it started, even when Astro thinks an agent runs it', async () => {
    const REAL_PORT = 4729;
    const siteDir = path.join(tempRoot, 'real-site');
    writeFile(siteDir, 'package.json', JSON.stringify({ type: 'module' }));
    writeFile(siteDir, 'astro.config.mjs', 'export default {};\n');
    writeFile(siteDir, 'src/content.config.ts', 'export const collections = {};\n');
    writeFile(siteDir, 'src/pages/index.astro', '<h1>Real astro</h1>\n');
    writeFile(siteDir, 'astroadmin.config.js', `export default { preview: { url: 'http://localhost:${REAL_PORT}' } };\n`);
    linkNodeModules(repoRoot, siteDir);
    const portOpen = () => new Promise((resolve) => {
      const socket = net.connect(REAL_PORT, 'localhost');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    assert.equal(await portOpen(), false, `port ${REAL_PORT} must be free before the test`);
    const child = spawn('bun', [path.join(repoRoot, 'bin/cli.js'), 'dev', '--project', siteDir, '--port', '3728'], {
      // CLAUDECODE makes Astro 7 detect an agent and background itself.
      env: { ...process.env, CLAUDECODE: '1', ADMIN_PASSWORD: 'admin', ASTROADMIN_PORT: '', PORT: '', PREVIEW_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      const deadline = Date.now() + 60_000;
      while (!/AstroAdmin running/.test(output) && Date.now() < deadline && child.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const page = await fetch(`http://localhost:${REAL_PORT}/`).then((response) => response.text()).catch((error) => String(error));
      assert.match(page, /Real astro/, `astro serves before exit (positive control):\n${output}`);
      child.kill('SIGTERM');
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.on('exit', resolve)));
      let open = true;
      for (let attempt = 0; attempt < 25 && open; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        open = await portOpen();
      }
      assert.equal(open, false, `astro still serves on ${REAL_PORT} after astroadmin exited:\n${output}`);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      // If it did daemonise, stop it (the scratch site's own lock names it).
      spawnSync('bun', ['--no-install', '--bun', path.join(repoRoot, 'node_modules/astro/bin/astro.mjs'), 'dev', 'stop'], { cwd: siteDir, env: { ...process.env, ASTRO_DEV_BACKGROUND: '' }, encoding: 'utf-8' });
    }
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
