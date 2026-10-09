/**
 * astroadmin doctor in the editor: the publish check's own build is scanned
 * for click-to-edit coverage, the latest result is served at
 * /api/doctor/latest, and nothing about it can fail or hold up a publish.
 *
 * Drives the real publish handler against a throwaway Astro site with a bare
 * remote (this repo's Astro builds it). ~10-20 s.
 *
 *   bun tests/doctor-publish.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-publish-'));
const remoteDir = path.join(tempRoot, 'remote.git');
const projectRoot = path.join(tempRoot, 'site');

// Must be set before config loads, hence the dynamic imports below.
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
delete process.env.GIT_AUTO_PUSH;

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function createJsonResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remoteDir);
fs.mkdirSync(projectRoot);
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeFile(projectRoot, 'package.json', JSON.stringify({ type: 'module' }));
writeFile(projectRoot, 'astro.config.mjs', 'export default {};\n');
writeFile(projectRoot, 'astroadmin.config.js', "export default { git: { enabled: true, paths: ['src/content/'] } };\n");
writeFile(projectRoot, '.gitignore', 'node_modules\n.astro\ndist\n');
writeFile(projectRoot, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({ title: z.string(), headline: z.string(), blurb: z.string() }),
});

export const collections = { pages };
`);
writeFile(projectRoot, 'src/content/pages/home.md', '---\ntitle: Example home\nheadline: Welcome to the example site\nblurb: Everything here is an example of something.\n---\n');
// The headline is annotated, the blurb is not, and the title is only in <head>.
writeFile(projectRoot, 'src/pages/index.astro', `---
import { getEntry } from 'astro:content';
const home = await getEntry('pages', 'home');
---
<html><head><title>{home.data.title}</title></head><body>
<h1 data-aa-field="headline">{home.data.headline}</h1>
<p>{home.data.blurb}</p>
</body></html>
`);

git(projectRoot, 'init', '-q', '-b', 'main');
git(projectRoot, 'config', 'user.name', 'Test');
git(projectRoot, 'config', 'user.email', 'test@example.com');
git(projectRoot, 'add', '-A');
git(projectRoot, 'commit', '-q', '-m', 'initial');
git(projectRoot, 'remote', 'add', 'origin', remoteDir);
git(projectRoot, 'push', '-q', '-u', 'origin', 'main');

const { publishHandler } = await import('../server/api/publish.js');
const { checkHeadWithAstro } = await import('../server/utils/astro-check.js');
const { getConfig } = await import('../server/config.js');
const { default: doctorRouter, getLatestDoctorResult, recordDoctorAfterCheck, resetLatestDoctorResult, outDirFor } = await import('../server/doctor/editor.js');

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

const checkDirsNow = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('astroadmin-check-')).sort();

try {
  console.log('\n🧪 doctor: the editor scans the publish check\'s build\n' + '='.repeat(40));

  await check('the output directory comes from --outDir, else astro.config, else dist', () => {
    assert.equal(outDirFor('bunx --bun astro build --outDir dist', null), 'dist');
    assert.equal(outDirFor('astro build --outDir=out/site', 'ignored'), 'out/site');
    assert.equal(outDirFor('astro build --outDir "my out"', null), 'my out');
    assert.equal(outDirFor('astro build', 'public-build'), 'public-build');
    assert.equal(outDirFor('astro build', null), 'dist');
  });

  await check('a publish records the coverage of the commit it built', async () => {
    resetLatestDoctorResult();
    const checkDirsBefore = checkDirsNow();
    writeFile(projectRoot, 'src/content/pages/home.md', '---\ntitle: Example home\nheadline: Welcome to the example site\nblurb: Everything here is an example of something else.\n---\n');
    const res = createJsonResponse();
    await publishHandler({ body: { message: 'Content update' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.pushed, true);

    const result = getLatestDoctorResult();
    assert.ok(result, 'a result was recorded');
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.commit, git(projectRoot, 'rev-parse', 'HEAD'));
    assert.deepEqual(result.coverage, { covered: 1, total: 2, byCollection: [{ collection: 'pages', entries: 1, fields: 2, covered: 1 }] });
    assert.ok(result.durationMs < 3000, `the scan took ${result.durationMs} ms`);
    assert.ok(result.results.some((item) => item.id === 'click-to-edit-coverage' && item.severity === 'warn'));
    assert.ok(result.results.every((item) => !('data' in item)), 'the long per-entry lists stay out of the stored result');
    assert.deepEqual(checkDirsNow(), checkDirsBefore, 'the check\'s temp dir is still deleted');
  });

  await check('GET /api/doctor/latest serves the recorded result', async () => {
    const app = express();
    app.use('/api/doctor', doctorRouter);
    const server = app.listen(4471);
    try {
      const response = await fetch('http://127.0.0.1:4471/api/doctor/latest');
      const body = await response.json();
      assert.equal(body.success, true);
      assert.equal(body.result.coverage.covered, 1);
      assert.equal(body.result.coverage.total, 2);
    } finally {
      server.close();
    }
  });

  const fullConfig = await getConfig();

  await check('a scan that exceeds its cap is "unavailable" and the check still passes', async () => {
    resetLatestDoctorResult();
    const startedAt = Date.now();
    const result = await checkHeadWithAstro(fullConfig, {
      onBuilt: (build) => recordDoctorAfterCheck(fullConfig, build, {
        timeoutMs: 50,
        loadEntries: () => new Promise(() => {}), // never settles
      }),
    });
    assert.equal(result.success, true, result.output);
    assert.equal(getLatestDoctorResult().status, 'unavailable');
    assert.match(getLatestDoctorResult().reason, /50 ms/);
    assert.ok(Date.now() - startedAt < 60_000);
  });

  await check('an error in the scan is "unavailable", never a failed check', async () => {
    resetLatestDoctorResult();
    const result = await checkHeadWithAstro(fullConfig, {
      onBuilt: (build) => recordDoctorAfterCheck(fullConfig, build, { loadEntries: async () => { throw new Error('store unreadable'); } }),
    });
    assert.equal(result.success, true, result.output);
    assert.deepEqual({ status: getLatestDoctorResult().status, reason: getLatestDoctorResult().reason }, { status: 'unavailable', reason: 'store unreadable' });
  });

  await check('even a hook that throws cannot fail the check', async () => {
    const result = await checkHeadWithAstro(fullConfig, { onBuilt: async () => { throw new Error('boom'); } });
    assert.equal(result.success, true, result.output);
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
