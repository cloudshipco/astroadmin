/**
 * `astroadmin doctor` on the command line: --json is the only thing on
 * stdout, --build reads an existing build, and the exit code is 1 exactly when
 * a check fails.
 *
 *   bun tests/doctor-cli.test.js
 */

import assert from 'assert';
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-cli-'));

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function makeSite(name, astroConfig) {
  const siteDir = path.join(tempRoot, name);
  fs.mkdirSync(siteDir);
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(siteDir, 'node_modules'), 'dir');
  writeFile(siteDir, 'package.json', JSON.stringify({ type: 'module' }));
  if (astroConfig) writeFile(siteDir, 'astro.config.mjs', astroConfig);
  writeFile(siteDir, '.gitignore', 'node_modules\n');
  writeFile(siteDir, 'bun.lock', '{}\n');
  writeFile(siteDir, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = { pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ headline: z.string() }) }) };
`);
  writeFile(siteDir, 'src/content/pages/home.md', '---\nheadline: Welcome to the example site\n---\n');
  // A build made earlier, passed with --build.
  writeFile(siteDir, 'prebuilt/index.html', '<html><body><h1 data-aa-field="headline">Welcome to the example site</h1></body></html>');
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: siteDir });
  execFileSync('/usr/bin/git', ['add', '-A'], { cwd: siteDir });
  execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'initial'], { cwd: siteDir });
  return siteDir;
}

function doctor(siteDir, ...extra) {
  return spawnSync('bun', [path.join(repoRoot, 'bin/cli.js'), 'doctor', '--project', siteDir, '--build', path.join(siteDir, 'prebuilt'), ...extra], { encoding: 'utf-8' });
}

const HOSTED = `import { defineConfig } from 'astro/config';
import astroadmin from 'astroadmin/integration';
export default defineConfig({ integrations: [astroadmin()], vite: { server: { allowedHosts: ['localhost'], hmr: false } } });
`;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
async function checkAsync(name, fn) {
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
  console.log('\n🧪 doctor: the CLI\n' + '='.repeat(40));
  const healthy = makeSite('healthy', HOSTED);
  const broken = makeSite('broken', null);

  check('a healthy site exits 0, and --json prints only JSON with every check', () => {
    const run = doctor(healthy, '--json');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.ok, true);
    const byId = Object.fromEntries(report.results.map((result) => [result.id, result]));
    assert.equal(byId['build-runs'].severity, 'skip', 'the existing build was used');
    assert.equal(byId['click-to-edit-coverage'].severity, 'pass', JSON.stringify(byId['click-to-edit-coverage']));
    assert.match(byId['click-to-edit-coverage'].message, /1 of 1/);
  });

  check('cards: a page-less entry is covered by its card, and a bad data-aa-entry on a page no entry owns is found', () => {
    const cards = makeSite('cards', HOSTED);
    writeFile(cards, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ headline: z.string() }) }),
  services: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/services' }), schema: z.object({ title: z.string() }) }),
};
`);
    writeFile(cards, 'src/content/services/garden-design.md', '---\ntitle: Garden design for any plot\n---\n');
    writeFile(cards, 'prebuilt/index.html', `<html><body><h1 data-aa-field="headline">Welcome to the example site</h1>
<ul><li data-aa-entry="services/garden-design"><h3 data-aa-field="title">Garden design for any plot</h3></li></ul></body></html>`);
    // A listing page that belongs to no entry, with a reference to a service that does not exist.
    writeFile(cards, 'prebuilt/all-services/index.html', '<html><body><ul><li data-aa-entry="services/tree-work"><h3 data-aa-field="title">Tree work</h3></li></ul></body></html>');
    const run = doctor(cards, '--json');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const byId = Object.fromEntries(JSON.parse(run.stdout).results.map((result) => [result.id, result]));
    assert.match(byId['click-to-edit-coverage'].message, /2 of 2 .*pages 1\/1, services 1\/1/, byId['click-to-edit-coverage'].message);
    assert.equal(byId['click-to-edit-names'].severity, 'warn');
    assert.deepEqual(byId['click-to-edit-names'].details, ['/all-services: data-aa-entry="services/tree-work"']);
  });

  check('a failing check (no astro.config) exits 1 and the text report names it', () => {
    const run = doctor(broken);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /FAIL Astro integration \(since 0\.2\.0\)/);
    assert.match(run.stdout, /docs\/doctor\.md#astro-integration/);
  });

  const { findAstroExecutable } = await import('../server/utils/astro-bin.js');
  const doctorBuilding = (siteDir) => spawnSync('bun', [path.join(repoRoot, 'bin/cli.js'), 'doctor', '--project', siteDir, '--json'], { encoding: 'utf-8', timeout: 120_000 });

  await checkAsync('the build uses the site\'s installed astro: its own, or one hoisted above a monorepo subdir, else none', async () => {
    // The bin astro's own package.json declares, as its .bin link would run it.
    const astroPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', 'astro', 'package.json'), 'utf-8'));
    const installedAstro = fs.realpathSync(path.join(repoRoot, 'node_modules', 'astro', typeof astroPackage.bin === 'string' ? astroPackage.bin : astroPackage.bin.astro));
    const own = makeSite('own-astro', HOSTED);
    assert.equal(await findAstroExecutable(own), installedAstro);
    // A site in a subdirectory, with node_modules hoisted to the repository root.
    const monorepo = path.join(tempRoot, 'monorepo');
    writeFile(monorepo, 'apps/site/package.json', '{}');
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(monorepo, 'node_modules'), 'dir');
    execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: monorepo });
    assert.equal(await findAstroExecutable(path.join(monorepo, 'apps/site')), installedAstro);
    // None installed: null, never a download.
    const bare = path.join(tempRoot, 'bare');
    writeFile(bare, 'package.json', '{}');
    assert.equal(await findAstroExecutable(bare), null);
  });

  await checkAsync('a site with no installed astro fails the build check clearly, without fetching one', async () => {
    const bare = path.join(tempRoot, 'no-astro');
    writeFile(bare, 'package.json', JSON.stringify({ type: 'module' }));
    writeFile(bare, 'astro.config.mjs', HOSTED);
    writeFile(bare, 'src/pages/index.astro', '<h1>Home</h1>\n');
    const startedAt = Date.now();
    const run = doctorBuilding(bare);
    const report = JSON.parse(run.stdout);
    const build = report.results.find((result) => result.id === 'build-runs');
    assert.equal(build.severity, 'fail', JSON.stringify(build));
    assert.match(build.message, /astro is not installed/i, build.message);
    assert.ok(Date.now() - startedAt < 30_000, `took ${Date.now() - startedAt} ms`);
    assert.equal(fs.existsSync(path.join(bare, 'node_modules')), false, 'nothing was installed into the site');
  });

  await checkAsync('control: a site with astro installed builds with it (no --build) and the built checks run', async () => {
    const site = makeSite('builds', HOSTED);
    // The site's own node_modules: this repo's astro and zod (the editor's
    // schema reader needs the site's zod), and astroadmin itself (which the
    // config imports and this repo's node_modules does not hold). No .bin, so
    // a runner that ignored the installed package would have to fetch one.
    fs.rmSync(path.join(site, 'node_modules'));
    fs.mkdirSync(path.join(site, 'node_modules'));
    for (const name of ['astro', 'zod']) fs.symlinkSync(path.join(repoRoot, 'node_modules', name), path.join(site, 'node_modules', name), 'dir');
    fs.symlinkSync(repoRoot, path.join(site, 'node_modules', 'astroadmin'), 'dir');
    writeFile(site, 'src/pages/index.astro', `---
import { getEntry } from 'astro:content';
const home = await getEntry('pages', 'home');
---
<html><body><h1 data-aa-field="headline">{home.data.headline}</h1></body></html>
`);
    const run = doctorBuilding(site);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const byId = Object.fromEntries(JSON.parse(run.stdout).results.map((result) => [result.id, result]));
    assert.equal(byId['build-runs'].severity, 'pass', JSON.stringify(byId['build-runs']));
    assert.match(byId['click-to-edit-coverage'].message, /1 of 1/);
  });

  await checkAsync('an --build directory with no HTML fails, and the built checks do not pass', async () => {
    const site = makeSite('empty-build', HOSTED);
    fs.mkdirSync(path.join(site, 'empty-dist'));
    const run = spawnSync('bun', [path.join(repoRoot, 'bin/cli.js'), 'doctor', '--project', site, '--build', path.join(site, 'empty-dist'), '--json'], { encoding: 'utf-8' });
    const byId = Object.fromEntries(JSON.parse(run.stdout).results.map((result) => [result.id, result]));
    assert.equal(byId['build-runs'].severity, 'fail', JSON.stringify(byId['build-runs']));
    for (const id of ['block-index', 'click-to-edit-coverage', 'click-to-edit-names', 'click-to-edit-links']) {
      assert.notEqual(byId[id].severity, 'pass', `${id}: ${JSON.stringify(byId[id])}`);
    }
    assert.equal(run.status, 1);
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
