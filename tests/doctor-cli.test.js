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

  check('a failing check (no astro.config) exits 1 and the text report names it', () => {
    const run = doctor(broken);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /FAIL Astro integration \(since 0\.2\.0\)/);
    assert.match(run.stdout, /docs\/doctor\.md#astro-integration/);
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
