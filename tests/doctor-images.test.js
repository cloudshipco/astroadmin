/**
 * astroadmin doctor: the optimised-images checks.
 *
 * - unoptimised-images (built): every <img> whose src is a raster under
 *   /images/ with no srcset, and whose original in public/ is over 300 KB,
 *   is listed with its page, file and size. Optimised output (<picture> with
 *   /_astro/ variants), images with a srcset, SVGs, small files and external
 *   URLs stay quiet.
 * - cms-image-prerequisites (static): when the site's source uses CmsImage,
 *   the SITE's sharp (resolved from the site root, as `astro build` resolves
 *   it, not from Astro's own folder) must be >= 0.35.4 and Astro >= 7; on
 *   Astro 7, an unset vite.build.cssTarget warns. A publicDir other than
 *   ./public (or one not readable statically) warns for CmsImage and for
 *   CmsVideo, whose globs are fixed at /public/images/** (#86).
 *
 * Each is shown red on a mutated copy of a healthy fixture.
 *
 *   bun tests/doctor-images.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDoctor, DOCTOR_CHECKS } from '../server/doctor/index.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-images-'));

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/** `bytes` of distinct content, so no two fixture files are identical. */
function fileOfSize(bytes, seed) {
  const buffer = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index += 1) buffer[index] = (index * 31 + seed * 7) % 251;
  return buffer;
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

let siteCounter = 0;
function newDir() {
  const dir = path.join(tempRoot, `site-${++siteCounter}`);
  fs.mkdirSync(dir);
  return dir;
}

// --- unoptimised-images ------------------------------------------------------

const OPTIMISED_HOME = `<!DOCTYPE html><html><head><title>Home</title></head><body>
<img src="/images/logo.png" alt="Logo">
<picture><source srcset="/_astro/hero.a_1.avif 400w, /_astro/hero.a_2.avif 800w" type="image/avif">
<img src="/_astro/hero.a_3.jpg" srcset="/_astro/hero.a_4.jpg 400w, /_astro/hero.a_3.jpg 800w" alt="Hero"></picture>
<img src="/images/team.jpg" srcset="/images/team-400.jpg 400w, /images/team.jpg 1200w" alt="Team">
<img src="/images/diagram.svg" alt="Diagram">
<img src="https://example.com/remote.jpg" alt="Remote">
</body></html>`;

function makeBuiltSite(homeHtml, aboutHtml = null) {
  const siteDir = newDir();
  writeFile(siteDir, 'public/images/logo.png', fileOfSize(20 * 1024, 1)); // small: quiet
  writeFile(siteDir, 'public/images/hero.png', fileOfSize(900 * 1024, 2));
  writeFile(siteDir, 'public/images/team.jpg', fileOfSize(700 * 1024, 3));
  writeFile(siteDir, 'public/images/diagram.svg', fileOfSize(500 * 1024, 4)); // not raster
  writeFile(siteDir, 'public/images/gallery/Shot One.JPG', fileOfSize(1536 * 1024, 5));
  writeFile(siteDir, 'dist/index.html', homeHtml);
  if (aboutHtml) writeFile(siteDir, 'dist/about/index.html', aboutHtml);
  return siteDir;
}

async function imagesResult(siteDir) {
  const report = await runDoctor({
    projectRoot: siteDir,
    distDir: path.join(siteDir, 'dist'),
    phases: ['build', 'built'],
    loadEntries: async () => ({ entries: [] }),
  });
  const result = report.results.find((item) => item.id === 'unoptimised-images');
  assert.ok(result, `the doctor has an unoptimised-images check (ids: ${report.results.map((item) => item.id).join(', ')})`);
  return result;
}

await check('images: optimised output, srcsets, SVGs, small files and URLs pass', async () => {
  const result = await imagesResult(makeBuiltSite(OPTIMISED_HOME));
  assert.equal(result.severity, 'pass', JSON.stringify(result));
});

await check('images MUTATION: plain <img>s of large originals warn, naming page, file and size', async () => {
  const plainHero = OPTIMISED_HOME.replace(/<picture>[\s\S]*?<\/picture>/, '<img src="/images/hero.png" alt="Hero">');
  const about = '<!DOCTYPE html><html><body><img src="/images/hero.png" alt=""><p><img src="/images/gallery/Shot%20One.JPG" alt="A shot"></p></body></html>';
  const result = await imagesResult(makeBuiltSite(plainHero, about));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.equal(result.title, 'Unoptimised images');
  const details = result.details.join('\n');
  assert.ok(details.includes('/: /images/hero.png (900 KB)'), details);
  assert.ok(details.includes('/about: /images/hero.png (900 KB)'), details);
  assert.ok(details.includes('/about: /images/gallery/Shot%20One.JPG (1.5 MB)'), details);
  assert.ok(!/logo|team|diagram|remote/.test(details), `only the unoptimised large rasters: ${details}`);
  assert.ok(result.message.includes('optimised-images.md'), result.message);
  assert.ok(result.message.includes('3 '), result.message);
});

await check('images: an <img> inside <template> or <noscript> is not counted', async () => {
  const hidden = OPTIMISED_HOME.replace('</body>', '<noscript><img src="/images/hero.png"></noscript><template><img src="/images/hero.png"></template></body>');
  assert.equal((await imagesResult(makeBuiltSite(hidden))).severity, 'pass');
});

await check('images: no build to read is a skip', async () => {
  const report = await runDoctor({ projectRoot: newDir(), build: false, phases: ['build', 'built'], loadEntries: async () => ({ entries: [] }) });
  assert.equal(report.results.find((item) => item.id === 'unoptimised-images').severity, 'skip');
});

// --- cms-image-prerequisites -------------------------------------------------

const CONFIG_WITH_CSS_TARGET = `import { defineConfig } from 'astro/config';
import astroadmin from 'astroadmin/integration';
export default defineConfig({
  integrations: [astroadmin()],
  vite: {
    build: { cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'] },
  },
});
`;
const CONFIG_WITHOUT_CSS_TARGET = `import { defineConfig } from 'astro/config';
import astroadmin from 'astroadmin/integration';
export default defineConfig({ integrations: [astroadmin()] });
`;
const PAGE_USING_CMS_IMAGE = `---
import CmsImage from 'astroadmin/components/CmsImage.astro';
---
<CmsImage src="/images/hero.jpg" alt="" sizes="100vw" />
`;

function fakePackage(dir, relativeDir, name, version) {
  writeFile(dir, path.join(relativeDir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
  writeFile(dir, path.join(relativeDir, 'index.js'), 'module.exports = {};\n');
}

/** A site using CmsImage on Astro 7.3.8 with its own sharp 0.35.5 and a cssTarget. */
function makePrereqSite({ sharp = '0.35.5', astro = '7.3.8', config = CONFIG_WITH_CSS_TARGET, page = PAGE_USING_CMS_IMAGE, astroNestedSharp = null } = {}) {
  const siteDir = newDir();
  writeFile(siteDir, 'package.json', JSON.stringify({ name: 'example-site', type: 'module' }));
  writeFile(siteDir, 'astro.config.mjs', config);
  writeFile(siteDir, 'src/pages/index.astro', page);
  if (sharp) fakePackage(siteDir, 'node_modules/sharp', 'sharp', sharp);
  if (astro) fakePackage(siteDir, 'node_modules/astro', 'astro', astro);
  if (astroNestedSharp) fakePackage(siteDir, 'node_modules/astro/node_modules/sharp', 'sharp', astroNestedSharp);
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: siteDir });
  return siteDir;
}

async function prereqResult(siteDir) {
  const report = await runDoctor({ projectRoot: siteDir, build: false, phases: ['static'] });
  const result = report.results.find((item) => item.id === 'cms-image-prerequisites');
  assert.ok(result, `the doctor has a cms-image-prerequisites check (ids: ${report.results.map((item) => item.id).join(', ')})`);
  return result;
}

await check('prerequisites: CmsImage on Astro 7.3.8 with site sharp 0.35.5 and a cssTarget passes', async () => {
  const result = await prereqResult(makePrereqSite());
  assert.equal(result.severity, 'pass', JSON.stringify(result));
  assert.ok(result.message.includes('0.35.5') && result.message.includes('7.3.8'), result.message);
});

await check('prerequisites: a site that does not use CmsImage is a skip', async () => {
  const result = await prereqResult(makePrereqSite({ sharp: '0.33.5', astro: '6.4.8', page: '<h1>Home</h1>\n' }));
  assert.equal(result.severity, 'skip', JSON.stringify(result));
});

await check('prerequisites MUTATION: the site\'s sharp 0.35.3 fails', async () => {
  const result = await prereqResult(makePrereqSite({ sharp: '0.35.3' }));
  assert.equal(result.severity, 'fail', JSON.stringify(result));
  assert.ok(result.message.includes('0.35.3') && result.message.includes('0.35.4'), result.message);
});

await check('prerequisites MUTATION: a patched sharp inside Astro\'s folder does not count; the site\'s 0.33.5 fails', async () => {
  const result = await prereqResult(makePrereqSite({ sharp: '0.33.5', astroNestedSharp: '0.35.5' }));
  assert.equal(result.severity, 'fail', JSON.stringify(result));
  assert.ok(result.message.includes('0.33.5'), result.message);
});

await check('prerequisites MUTATION: no sharp of the site\'s own fails', async () => {
  const result = await prereqResult(makePrereqSite({ sharp: null, astroNestedSharp: '0.35.5' }));
  assert.equal(result.severity, 'fail', JSON.stringify(result));
});

await check('prerequisites MUTATION: Astro 6.4.8 fails', async () => {
  const result = await prereqResult(makePrereqSite({ astro: '6.4.8' }));
  assert.equal(result.severity, 'fail', JSON.stringify(result));
  assert.ok(result.message.includes('6.4.8'), result.message);
});

await check('prerequisites MUTATION: Astro 7 with no vite.build.cssTarget warns', async () => {
  const result = await prereqResult(makePrereqSite({ config: CONFIG_WITHOUT_CSS_TARGET }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('cssTarget'), result.message);
});

// #86: the components' globs are fixed at /public/images/**, so a custom
// publicDir finds no image or video. The doctor warns, naming the setting.
const configWithPublicDir = (value) => CONFIG_WITH_CSS_TARGET.replace('integrations: [astroadmin()],', `integrations: [astroadmin()],\n  publicDir: ${value},`);
const PAGE_USING_CMS_VIDEO = `---
import CmsVideo from 'astroadmin/components/CmsVideo.astro';
---
<CmsVideo src="/images/intro.mp4" />
`;

await check('prerequisites MUTATION: CmsImage with publicDir \'./static\' warns, naming publicDir (#86)', async () => {
  const result = await prereqResult(makePrereqSite({ config: configWithPublicDir("'./static'") }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('publicDir') && result.message.includes('./static'), result.message);
});

await check('prerequisites MUTATION: CmsVideo alone with publicDir \'static\' warns, naming publicDir (#86)', async () => {
  const result = await prereqResult(makePrereqSite({ config: configWithPublicDir("'static'"), page: PAGE_USING_CMS_VIDEO }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('publicDir') && result.message.includes('CmsVideo'), result.message);
});

await check('prerequisites MUTATION: a publicDir the doctor cannot read statically warns to check by hand (#86)', async () => {
  const result = await prereqResult(makePrereqSite({ config: configWithPublicDir("new URL('./static/', import.meta.url)") }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('publicDir'), result.message);
});

await check('prerequisites MUTATION: a custom publicDir and no cssTarget warn about both (#86)', async () => {
  const config = CONFIG_WITHOUT_CSS_TARGET.replace('integrations: [astroadmin()]', "integrations: [astroadmin()], publicDir: './static'");
  const result = await prereqResult(makePrereqSite({ config }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('publicDir') && result.message.includes('cssTarget'), result.message);
});

await check('prerequisites: publicDir set to \'./public\' (or \'public/\') is the default and passes (#86 control)', async () => {
  for (const value of ["'./public'", "'public/'"]) {
    const result = await prereqResult(makePrereqSite({ config: configWithPublicDir(value) }));
    assert.equal(result.severity, 'pass', `${value}: ${JSON.stringify(result)}`);
  }
});

await check('prerequisites: a site using neither component is a skip whatever its publicDir (#86 control)', async () => {
  const result = await prereqResult(makePrereqSite({ config: configWithPublicDir("'./static'"), page: '<h1>Home</h1>\n' }));
  assert.equal(result.severity, 'skip', JSON.stringify(result));
});

await check('both checks name the version that added them', async () => {
  for (const id of ['unoptimised-images', 'cms-image-prerequisites']) {
    const definition = DOCTOR_CHECKS.find((item) => item.id === id);
    assert.ok(definition && /^\d+\.\d+\.\d+$/.test(definition.since), `${id} since`);
  }
});

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(`\n📊 ${passed} checks passed.`);
