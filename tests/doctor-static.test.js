/**
 * astroadmin doctor: the static checks (site setup and publish-check blockers).
 *
 * Each check runs against a throwaway git repo whose astro.config has the shape
 * a hosted site uses (the integration among others, vite.server.allowedHosts
 * and hmr: false), then against a mutated copy that must turn it red.
 *
 *   bun tests/doctor-static.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDoctor, DOCTOR_CHECKS } from '../server/doctor/index.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-static-'));

const HOSTED_CONFIG = `import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import astroadmin from 'astroadmin/integration';

export default defineConfig({
  site: 'https://www.example.com',
  output: 'static',
  integrations: [astroadmin(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts: ['.admin.example.com', 'localhost'],
      hmr: false,
    },
  },
});
`;

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

let siteCounter = 0;
/** A committed site; `mutate(siteDir)` runs before the commit. */
function makeSite(mutate = () => {}) {
  const siteDir = path.join(tempRoot, `site-${++siteCounter}`);
  fs.mkdirSync(siteDir);
  writeFile(siteDir, 'package.json', JSON.stringify({ name: 'example-site', type: 'module' }));
  writeFile(siteDir, 'astro.config.mjs', HOSTED_CONFIG);
  writeFile(siteDir, 'bun.lock', '{ "lockfileVersion": 1 }\n');
  writeFile(siteDir, '.gitignore', 'node_modules\ndist\n');
  writeFile(siteDir, 'src/pages/index.astro', '<h1>Home</h1>\n');
  git(siteDir, 'init', '-q', '-b', 'main');
  git(siteDir, 'config', 'user.name', 'Test');
  git(siteDir, 'config', 'user.email', 'test@example.com');
  mutate(siteDir);
  git(siteDir, 'add', '-A');
  git(siteDir, 'commit', '-q', '-m', 'initial');
  return siteDir;
}

async function staticResults(siteDir) {
  const report = await runDoctor({ projectRoot: siteDir, build: false, phases: ['static'] });
  return Object.fromEntries(report.results.map((result) => [result.id, result]));
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

try {
  console.log('\n🧪 doctor: static checks\n' + '='.repeat(40));

  await check('every check carries an id, a version, a title, a phase and a docs link', () => {
    assert.ok(DOCTOR_CHECKS.length >= 10);
    const ids = new Set();
    for (const definition of DOCTOR_CHECKS) {
      assert.match(definition.id, /^[a-z0-9-]+$/);
      assert.ok(!ids.has(definition.id), `duplicate id ${definition.id}`);
      ids.add(definition.id);
      assert.match(definition.since, /^\d+\.\d+\.\d+$/, definition.id);
      assert.ok(definition.title, definition.id);
      assert.ok(['static', 'build', 'built'].includes(definition.phase), definition.id);
      assert.match(definition.docs, /^https:\/\/github\.com\/cloudshipco\/astroadmin\/blob\/main\/docs\/doctor\.md#/, definition.id);
      assert.equal(typeof definition.run, 'function', definition.id);
    }
  });

  const healthy = await staticResults(makeSite());

  await check('a hosted-shape site passes every static check', () => {
    for (const id of ['astro-integration', 'hosted-preview-config', 'committed-lockfile', 'no-submodules', 'no-workspace-links']) {
      assert.equal(healthy[id]?.severity, 'pass', `${id}: ${JSON.stringify(healthy[id])}`);
    }
    assert.equal(healthy['sharp-loads'].severity, 'skip', 'no astro:assets, so sharp is not needed');
  });

  await check('a result carries the definition\'s version and docs link', () => {
    assert.equal(healthy['no-submodules'].since, '1.4.8');
    assert.ok(healthy['no-submodules'].docs.endsWith('#no-submodules'));
  });

  await check('integration MUTATION: removing astroadmin() from integrations fails', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, 'astro.config.mjs', HOSTED_CONFIG.replace('integrations: [astroadmin(), sitemap()]', 'integrations: [sitemap()]')));
    const results = await staticResults(siteDir);
    assert.equal(results['astro-integration'].severity, 'fail', JSON.stringify(results['astro-integration']));
  });

  await check('integration MUTATION: no astro.config at all fails', async () => {
    const siteDir = makeSite((dir) => fs.rmSync(path.join(dir, 'astro.config.mjs')));
    assert.equal((await staticResults(siteDir))['astro-integration'].severity, 'fail');
  });

  await check('integration: a TypeScript config with the integration renamed on import passes', async () => {
    const siteDir = makeSite((dir) => {
      fs.rmSync(path.join(dir, 'astro.config.mjs'));
      writeFile(dir, 'astro.config.ts', HOSTED_CONFIG.replace("import astroadmin from 'astroadmin/integration';", "import editor from 'astroadmin/integration';\nconst flag: boolean = true;")
        .replace('astroadmin()', 'editor()'));
    });
    const results = await staticResults(siteDir);
    assert.equal(results['astro-integration'].severity, 'pass', JSON.stringify(results['astro-integration']));
    assert.equal(results['hosted-preview-config'].severity, 'pass');
  });

  await check('preview config MUTATION: no allowedHosts warns', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, 'astro.config.mjs', HOSTED_CONFIG.replace("allowedHosts: ['.admin.example.com', 'localhost'],", '')));
    const result = (await staticResults(siteDir))['hosted-preview-config'];
    assert.equal(result.severity, 'warn');
    assert.match(result.message, /allowedHosts/);
  });

  await check('preview config MUTATION: hmr left on warns', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, 'astro.config.mjs', HOSTED_CONFIG.replace('hmr: false', 'hmr: true')));
    const result = (await staticResults(siteDir))['hosted-preview-config'];
    assert.equal(result.severity, 'warn');
    assert.match(result.message, /hmr/);
  });

  await check('lockfile MUTATION: an uncommitted bun.lock warns', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, '.gitignore', 'node_modules\ndist\nbun.lock\n'));
    assert.ok(fs.existsSync(path.join(siteDir, 'bun.lock')), 'the file is on disk, just not committed');
    assert.equal((await staticResults(siteDir))['committed-lockfile'].severity, 'warn');
  });

  await check('submodule MUTATION: a gitlink (mode 160000) fails', async () => {
    const siteDir = makeSite();
    // After the first commit: `git add -A` would stage the missing path's removal.
    git(siteDir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/theme`);
    git(siteDir, 'commit', '-q', '-m', 'add a submodule');
    const result = (await staticResults(siteDir))['no-submodules'];
    assert.equal(result.severity, 'fail', JSON.stringify(result));
    assert.match(result.message, /vendor\/theme/);
  });

  await check('workspace MUTATION: a package linked back into the repo fails', async () => {
    const siteDir = makeSite((dir) => {
      writeFile(dir, 'packages/ui/package.json', JSON.stringify({ name: '@example/ui' }));
      fs.mkdirSync(path.join(dir, 'node_modules', '@example'), { recursive: true });
      fs.symlinkSync(path.join(dir, 'packages', 'ui'), path.join(dir, 'node_modules', '@example', 'ui'), 'dir');
    });
    const result = (await staticResults(siteDir))['no-workspace-links'];
    assert.equal(result.severity, 'fail', JSON.stringify(result));
    assert.match(result.message, /@example\/ui/);
  });

  const assetsPage = "---\nimport { Image } from 'astro:assets';\n---\n<h1>Home</h1>\n";

  await check('sharp: a site using astro:assets with a working sharp passes', async () => {
    const siteDir = makeSite((dir) => {
      writeFile(dir, 'src/pages/index.astro', assetsPage);
      fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    });
    const result = (await staticResults(siteDir))['sharp-loads'];
    assert.equal(result.severity, 'pass', JSON.stringify(result));
  });

  await check('sharp MUTATION: a sharp that cannot load its native module fails', async () => {
    const siteDir = makeSite((dir) => {
      writeFile(dir, 'src/pages/index.astro', assetsPage);
      writeFile(dir, 'node_modules/sharp/package.json', JSON.stringify({ name: 'sharp', main: 'index.js' }));
      writeFile(dir, 'node_modules/sharp/index.js', "throw new Error('libstdc++.so.6: cannot open shared object file');\n");
    });
    const result = (await staticResults(siteDir))['sharp-loads'];
    assert.equal(result.severity, 'fail', JSON.stringify(result));
    assert.match(result.message, /libstdc\+\+/);
  });

  await check('sharp MUTATION: astro:assets with no sharp installed fails', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, 'src/pages/index.astro', assetsPage));
    assert.equal((await staticResults(siteDir))['sharp-loads'].severity, 'fail');
  });

  await check('a site that is not a git repo warns rather than crashing', async () => {
    const siteDir = path.join(tempRoot, 'not-a-repo');
    fs.mkdirSync(siteDir);
    writeFile(siteDir, 'astro.config.mjs', HOSTED_CONFIG);
    const results = await staticResults(siteDir);
    assert.equal(results['committed-lockfile'].severity, 'warn');
    assert.equal(results['astro-integration'].severity, 'pass');
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
