/**
 * Astro's dev toolbar is hidden in the preview AstroAdmin runs, and only there.
 *
 * `npm pack` this checkout, install the tarball into a throwaway Astro 7.3.8
 * site that uses the integration, and start the site's `astro dev` the ways
 * it really runs:
 *
 * - plain `astro dev`, as a developer runs it: the toolbar is there (the
 *   positive control: Astro injects its entrypoint script into the page);
 * - as the hosted NixOS preview unit runs it (`bun --bun astro dev` with the
 *   instance's ASTROADMIN_PROJECT_ROOT and NODE_ENV=development): no toolbar;
 * - under `astroadmin dev`, which spawns the site's astro itself: no toolbar;
 * - ASTROADMIN_PROJECT_ROOT naming a different directory: toolbar;
 * - `astroadmin({ devToolbar: true })` in the preview: toolbar.
 *
 * Every page must also carry the integration's preview script, so a run in
 * which the integration never loaded cannot pass as "no toolbar".
 *
 * Needs the network the first time (the site's install), then bun's cache.
 * Uses ports 4741-4745 (astro) and 3741 (admin).
 *
 *   bun tests/dev-toolbar.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const repoRoot = path.resolve(import.meta.dir, '..');
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-dev-toolbar-')));
const siteDir = path.join(workDir, 'site');
const otherDir = path.join(workDir, 'other');

/** What Astro adds to a dev page when the toolbar is on. */
const TOOLBAR_MARKER = 'dev-toolbar/entrypoint.js';
/** What a dev page carries when the integration's injected script is there. */
const INTEGRATION_MARKER = 'astro:scripts/page.js';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function writeSiteFile(relativePath, content) {
  const fullPath = path.join(siteDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/** The environment with no AstroAdmin signal in it, whatever the caller's shell has. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', ...extra };
  if (!('ASTROADMIN_PROJECT_ROOT' in extra)) delete env.ASTROADMIN_PROJECT_ROOT;
  return env;
}

/**
 * Start a process, wait until `url` answers with a page, return its HTML, stop it.
 * @param {string[]} command - argv
 * @param {{cwd: string, env: object, url: string}} options
 */
async function pageFrom(command, { cwd, env, url }) {
  const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const html = await response.text();
        if (response.ok && html.includes('Toolbar fixture')) return html;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${url} never served the page:\n${output}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 5000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

/** The site's own astro, started the way the hosted preview unit starts it. */
function astroDev(port) {
  return ['bun', '--no-install', '--bun', path.join(siteDir, 'node_modules/.bin/astro'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--ignore-lock'];
}

try {
  // --- the tarball and the site ----------------------------------------
  const pack = run('npm', ['pack', '--pack-destination', workDir, '--silent'], repoRoot);
  assert.strictEqual(pack.status, 0, pack.output);
  const tarball = path.join(workDir, pack.output.trim().split('\n').filter(Boolean).pop());
  assert.ok(fs.existsSync(tarball), `npm pack produced ${tarball}`);

  writeSiteFile(
    'package.json',
    JSON.stringify({ name: 'dev-toolbar-fixture', type: 'module', private: true, dependencies: { astro: '7.3.8', astroadmin: `file:${tarball}` } }, null, 2),
  );
  // AA_TEST_KEEP_TOOLBAR lets one case pass the integration's own option.
  writeSiteFile(
    'astro.config.mjs',
    [
      "import { defineConfig } from 'astro/config';",
      "import astroadmin from 'astroadmin/integration';",
      "export default defineConfig({ integrations: [astroadmin(process.env.AA_TEST_KEEP_TOOLBAR === '1' ? { devToolbar: true } : {})] });",
      '',
    ].join('\n'),
  );
  writeSiteFile('src/content.config.ts', 'export const collections = {};\n');
  writeSiteFile('src/pages/index.astro', '<html><body><h1>Toolbar fixture</h1></body></html>\n');
  fs.mkdirSync(otherDir, { recursive: true });

  const install = run('bun', ['install', '--no-save'], siteDir);
  assert.strictEqual(install.status, 0, install.output);
  const version = JSON.parse(fs.readFileSync(path.join(siteDir, 'node_modules/astro/package.json'), 'utf8')).version;
  assert.strictEqual(version, '7.3.8');

  console.log('\n🧪 Astro dev toolbar in the AstroAdmin preview\n' + '='.repeat(40));

  await check('plain astro dev keeps the toolbar (positive control)', async () => {
    const html = await pageFrom(astroDev(4741), { cwd: siteDir, env: cleanEnv(), url: 'http://127.0.0.1:4741/' });
    assert.ok(html.includes(INTEGRATION_MARKER), `the integration's script is on the page:\n${html}`);
    assert.ok(html.includes(TOOLBAR_MARKER), `the toolbar is on the page:\n${html}`);
  });

  await check('the hosted preview unit (ASTROADMIN_PROJECT_ROOT, NODE_ENV=development) has no toolbar', async () => {
    const env = cleanEnv({ ASTROADMIN_PROJECT_ROOT: siteDir, NODE_ENV: 'development', CHOKIDAR_USEPOLLING: '1' });
    const html = await pageFrom(astroDev(4742), { cwd: siteDir, env, url: 'http://127.0.0.1:4742/' });
    assert.ok(html.includes(INTEGRATION_MARKER), `the integration's script is on the page:\n${html}`);
    assert.ok(!html.includes(TOOLBAR_MARKER), `no toolbar in the preview:\n${html}`);
  });

  await check('the astro that astroadmin dev starts has no toolbar', async () => {
    fs.writeFileSync(path.join(siteDir, 'astroadmin.config.js'), "export default { preview: { url: 'http://localhost:4743' } };\n");
    try {
      const env = cleanEnv({ ADMIN_PASSWORD: 'admin', ASTROADMIN_PORT: '', PORT: '', PREVIEW_URL: '' });
      const html = await pageFrom(
        ['bun', path.join(repoRoot, 'bin/cli.js'), 'dev', '--project', siteDir, '--port', '3741'],
        { cwd: siteDir, env, url: 'http://localhost:4743/' },
      );
      assert.ok(html.includes(INTEGRATION_MARKER), `the integration's script is on the page:\n${html}`);
      assert.ok(!html.includes(TOOLBAR_MARKER), `no toolbar in the preview:\n${html}`);
    } finally {
      fs.rmSync(path.join(siteDir, 'astroadmin.config.js'), { force: true });
    }
  });

  await check('ASTROADMIN_PROJECT_ROOT naming another directory keeps the toolbar', async () => {
    const html = await pageFrom(astroDev(4744), { cwd: siteDir, env: cleanEnv({ ASTROADMIN_PROJECT_ROOT: otherDir }), url: 'http://127.0.0.1:4744/' });
    assert.ok(html.includes(INTEGRATION_MARKER), `the integration's script is on the page:\n${html}`);
    assert.ok(html.includes(TOOLBAR_MARKER), `the toolbar is on the page:\n${html}`);
  });

  await check('astroadmin({ devToolbar: true }) keeps the toolbar in the preview', async () => {
    const env = cleanEnv({ ASTROADMIN_PROJECT_ROOT: siteDir, AA_TEST_KEEP_TOOLBAR: '1' });
    const html = await pageFrom(astroDev(4745), { cwd: siteDir, env, url: 'http://127.0.0.1:4745/' });
    assert.ok(html.includes(INTEGRATION_MARKER), `the integration's script is on the page:\n${html}`);
    assert.ok(html.includes(TOOLBAR_MARKER), `the toolbar is on the page:\n${html}`);
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  // --ignore-lock keeps each astro in the foreground as our child; stop any
  // that detached anyway (the site's own lock names it).
  if (fs.existsSync(path.join(siteDir, 'node_modules/.bin/astro'))) {
    spawnSync('bun', ['--no-install', '--bun', path.join(siteDir, 'node_modules/.bin/astro'), 'dev', 'stop'], { cwd: siteDir, encoding: 'utf8' });
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}
