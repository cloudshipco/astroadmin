/**
 * `astroadmin doctor` builds when the system temp directory is on another
 * filesystem from the site (a tmpfs /tmp on Linux, a VM's shared folder).
 *
 * Astro moves a site's prerendered assets (an optimised image, say) from the
 * site's .astro into the outDir with rename(), which fails with EXDEV across
 * filesystems. The doctor used to build into os.tmpdir(); it now keeps the
 * outDir on the site's filesystem (server/doctor/checks.js doctorOutDirParent).
 *
 * macOS only: the other filesystem is a small disk image attached under the
 * test's temp directory (hdiutil) and detached afterwards. Elsewhere the test
 * says so and exits 0 without claiming a pass.
 *
 *   bun tests/doctor-cross-device.test.js     (~15 s)
 */

import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linkNodeModules } from './link-node-modules.js';

if (process.platform !== 'darwin') {
  console.log('⚠️  doctor-cross-device: needs hdiutil (macOS); NOT RUN on this platform.');
  process.exit(0);
}

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-xdev-')));
const imagePath = path.join(tempRoot, 'other.dmg');
const mountPoint = path.join(tempRoot, 'other');
// A 1x1 PNG, enough for astro:assets to optimise and emit an asset.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

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

let attached = false;
try {
  console.log('\n🧪 doctor: build with the temp directory on another filesystem\n' + '='.repeat(40));
  execFileSync('hdiutil', ['create', '-size', '64m', '-fs', 'HFS+', '-volname', 'aa-xdev', '-o', imagePath, '-quiet']);
  fs.mkdirSync(mountPoint);
  execFileSync('hdiutil', ['attach', imagePath, '-mountpoint', mountPoint, '-nobrowse', '-quiet']);
  attached = true;

  const siteDir = path.join(tempRoot, 'site');
  writeFile(siteDir, 'package.json', JSON.stringify({ type: 'module' }));
  writeFile(siteDir, 'astro.config.mjs', `import { defineConfig } from 'astro/config';
import astroadmin from 'astroadmin/integration';
export default defineConfig({ integrations: [astroadmin()] });
`);
  writeFile(siteDir, 'src/content.config.ts', `import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
export const collections = { pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }) };
`);
  writeFile(siteDir, 'src/content/pages/home.md', '---\ntitle: Home\n---\n');
  writeFile(siteDir, 'src/assets/dot.png', PNG);
  writeFile(siteDir, 'src/pages/index.astro', `---
import { Image } from 'astro:assets';
import dot from '../assets/dot.png';
---
<html><body><h1 data-aa-field="title">Home</h1><Image src={dot} alt="" /></body></html>
`);
  // A real node_modules directory on the site's filesystem, linking each package.
  linkNodeModules(repoRoot, siteDir);
  fs.symlinkSync(repoRoot, path.join(siteDir, 'node_modules', 'astroadmin'));

  check('the disk image is a different filesystem from the site (the condition under test)', () => {
    assert.notEqual(fs.statSync(mountPoint).dev, fs.statSync(siteDir).dev);
  });

  const run = spawnSync('bun', [path.join(repoRoot, 'bin/cli.js'), 'doctor', '--project', siteDir, '--json'], {
    encoding: 'utf-8',
    env: { ...process.env, TMPDIR: `${mountPoint}/` },
    timeout: 180_000,
  });
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    // reported below
  }

  check('the doctor ran and reported (positive control)', () => {
    assert.ok(report, `no JSON report:\n${run.stdout}\n${run.stderr}`);
  });

  check('the build passes with TMPDIR on another filesystem (no EXDEV)', () => {
    const build = report.results.find((result) => result.id === 'build-runs');
    assert.equal(build.severity, 'pass', JSON.stringify(build, null, 2));
    assert.doesNotMatch(JSON.stringify(report), /EXDEV/);
    const coverage = report.results.find((result) => result.id === 'click-to-edit-coverage');
    assert.notEqual(coverage.severity, 'skip', 'the built pages were read');
  });

  check('the doctor leaves nothing behind in the site', () => {
    const cache = path.join(siteDir, 'node_modules', '.cache');
    const leftovers = fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => name.startsWith('astroadmin-doctor-')) : [];
    assert.deepEqual(leftovers, []);
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  if (attached) {
    try {
      execFileSync('hdiutil', ['detach', mountPoint, '-quiet']);
    } catch {
      execFileSync('hdiutil', ['detach', mountPoint, '-force', '-quiet']);
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
