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
 * - image-crop-service (static): images.crop in astroadmin.config.js without
 *   image.service.entrypoint 'astroadmin/image-service' in the Astro config,
 *   the service without images.crop, and a crop stored in
 *   public/images/.metadata.json on a site without the service (named by its
 *   site-path key) each warn; both opt-ins pass; neither is a skip.
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
// url imported whole (`import * as url` or a default import), its
// fileURLToPath called as a method.
const namespaceConfig = (binding, value) => configWithPublicDir(value).replace("import { defineConfig } from 'astro/config';", `import { defineConfig } from 'astro/config';\nimport ${binding} from 'node:url';`);
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
  const result = await prereqResult(makePrereqSite({ config: configWithPublicDir("process.env.PUBLIC_FOLDER") }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('publicDir') && result.message.includes('not a value the doctor can read statically'), result.message);
});

// Values the doctor can read without running the config: a template literal
// with no expressions, and a URL relative to the config file (Astro accepts
// a URL, and fileURLToPath of one is the documented idiom).
await check('prerequisites: publicDir as `./public`, a URL or fileURLToPath of one to ./public is the default and passes', async () => {
  const urlConfig = (value) => configWithPublicDir(value).replace("import { defineConfig } from 'astro/config';", "import { defineConfig } from 'astro/config';\nimport { fileURLToPath } from 'node:url';");
  assert.ok(urlConfig('x').includes("from 'node:url'"), 'the import was added');
  assert.ok(namespaceConfig('* as url', 'x').includes("import * as url from 'node:url'"), 'the import was added');
  for (const config of [
    configWithPublicDir('`./public`'),
    configWithPublicDir("new URL('./public/', import.meta.url)"),
    urlConfig("fileURLToPath(new URL('./public', import.meta.url))"),
    urlConfig('fileURLToPath(new URL(`public/`, import.meta.url))'),
    namespaceConfig('* as url', "url.fileURLToPath(new URL('./public', import.meta.url))"),
    namespaceConfig('nodeUrl', "nodeUrl.fileURLToPath(new URL('./public', import.meta.url))"),
  ]) {
    const result = await prereqResult(makePrereqSite({ config }));
    assert.equal(result.severity, 'pass', `${config}\n${JSON.stringify(result)}`);
  }
});

await check('prerequisites MUTATION: publicDir as `./static` or fileURLToPath(new URL(\'./static\', ...)) warns, naming the folder', async () => {
  const urlConfig = configWithPublicDir("fileURLToPath(new URL('./static', import.meta.url))").replace("import { defineConfig } from 'astro/config';", "import { defineConfig } from 'astro/config';\nimport { fileURLToPath } from 'url';");
  for (const config of [configWithPublicDir('`./static`'), urlConfig, namespaceConfig('* as url', "url.fileURLToPath(new URL('./static', import.meta.url))")]) {
    const result = await prereqResult(makePrereqSite({ config }));
    assert.equal(result.severity, 'warn', `${config}\n${JSON.stringify(result)}`);
    assert.match(result.message, /publicDir is set to '(\.\/)?static'/, result.message);
  }
});

await check('prerequisites MUTATION: a template literal with an expression is not read as a string', async () => {
  const result = await prereqResult(makePrereqSite({ config: `const folder = 'public';\n${configWithPublicDir('`./${folder}`')}` }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('not a value the doctor can read statically'), result.message);
});

// A config the doctor cannot read at all is a different problem from a
// publicDir it cannot read: the warning says which.
await check('prerequisites MUTATION: a config the doctor cannot read statically says so, not that publicDir is unreadable', async () => {
  const configs = {
    'a spread and no publicDir': CONFIG_WITH_CSS_TARGET.replace('integrations: [astroadmin()],', 'integrations: [astroadmin()],\n  ...sharedOptions,').replace("import { defineConfig } from 'astro/config';", "import { defineConfig } from 'astro/config';\nimport sharedOptions from './shared.mjs';"),
    'an async defineConfig': "import { defineConfig } from 'astro/config';\nexport default defineConfig(async () => ({ integrations: [] }));\n",
    'a syntax error': 'export default {{{\n',
  };
  assert.ok(configs['a spread and no publicDir'].includes('...sharedOptions'), 'the spread was added');
  for (const [name, config] of Object.entries(configs)) {
    const result = await prereqResult(makePrereqSite({ config }));
    assert.equal(result.severity === 'warn' || result.severity === 'fail', true, `${name}: ${JSON.stringify(result)}`);
    const text = [result.message, ...result.details].join(' ');
    assert.ok(text.includes('could not read the Astro config statically to find publicDir'), `${name}: ${text}`);
    assert.ok(!text.includes('not a value the doctor can read statically'), `${name}: ${text}`);
  }
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

// --- image-crop-service ------------------------------------------------------
//
// A crop an editor sets (public/images/.metadata.json) is applied only by
// astroadmin/image-service, and the editor shows the crop control only with
// images.crop in astroadmin.config.js. Each half without the other warns, and
// so does a crop already stored on a site without the service, since a build
// that renders it fails.

const SERVICE_ENTRYPOINT = "image: { service: { entrypoint: 'astroadmin/image-service' } },";
const configWithImage = (imageOption) => CONFIG_WITH_CSS_TARGET.replace('integrations: [astroadmin()],', `integrations: [astroadmin()],\n  ${imageOption}`);
const CONFIG_WITH_CROP_SERVICE = configWithImage(SERVICE_ENTRYPOINT);
const ADMIN_CONFIG_WITH_CROP = 'export default { images: { crop: true } };\n';
const METADATA_WITH_CROPS = JSON.stringify({
  '/images/team/photo.jpg': { alt: 'The team', crop: { x: 10, y: 5, width: 60, height: 80 } },
  'legacy.jpg': { crop: { x: 0, y: 0, width: 50, height: 50 } },
  '/images/hero.jpg': { alt: 'Hero', focalPoint: { x: 30, y: 20 } },
  '/images/plain.jpg': { alt: 'Plain', crop: null },
}, null, 2);
const METADATA_WITHOUT_CROPS = JSON.stringify({ '/images/hero.jpg': { alt: 'Hero', focalPoint: { x: 30, y: 20 } } });

/** A CmsImage site (makePrereqSite) plus an astroadmin.config.js and a metadata file. */
function makeCropSite({ config = CONFIG_WITH_CROP_SERVICE, adminConfig = ADMIN_CONFIG_WITH_CROP, metadata = METADATA_WITHOUT_CROPS } = {}) {
  const siteDir = makePrereqSite({ config });
  if (adminConfig !== null) writeFile(siteDir, 'astroadmin.config.js', adminConfig);
  if (metadata !== null) writeFile(siteDir, 'public/images/.metadata.json', metadata);
  return siteDir;
}

async function cropResult(siteDir) {
  const report = await runDoctor({ projectRoot: siteDir, build: false, phases: ['static'] });
  const result = report.results.find((item) => item.id === 'image-crop-service');
  assert.ok(result, `the doctor has an image-crop-service check (ids: ${report.results.map((item) => item.id).join(', ')})`);
  const text = [result.title, result.message, ...result.details].join('\n');
  assert.ok(!text.includes(siteDir), `no server path in the result: ${text}`);
  return result;
}

await check('crop: images.crop true and image.service.entrypoint astroadmin/image-service passes (a const too)', async () => {
  const viaConst = `const service = { entrypoint: 'astroadmin/image-service' };\n${configWithImage('image: { service },')}`;
  for (const config of [CONFIG_WITH_CROP_SERVICE, viaConst]) {
    const result = await cropResult(makeCropSite({ config }));
    assert.equal(result.severity, 'pass', `${config}\n${JSON.stringify(result)}`);
  }
});

await check('crop: a site with neither opt-in and no stored crop is a skip (focal points and alt text alone are fine)', async () => {
  for (const site of [
    makeCropSite({ config: CONFIG_WITH_CSS_TARGET, adminConfig: null, metadata: null }),
    makeCropSite({ config: CONFIG_WITH_CSS_TARGET, adminConfig: 'export default { images: { crop: false } };\n' }),
    makeCropSite({ config: CONFIG_WITH_CSS_TARGET, adminConfig: 'export default { preview: { url: "http://localhost:4321" } };\n' }),
  ]) {
    const result = await cropResult(site);
    assert.equal(result.severity, 'skip', JSON.stringify(result));
  }
});

await check('crop MUTATION: images.crop true without the service warns, naming both settings and the publish check', async () => {
  const result = await cropResult(makeCropSite({ config: CONFIG_WITH_CSS_TARGET }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('images.crop') && result.message.includes('astroadmin/image-service'), result.message);
  assert.ok(result.message.includes('image.service.entrypoint') && result.message.includes('publish'), result.message);
  assert.ok(result.message.includes('optimised-images.md#crop'), result.message);
});

await check('crop MUTATION: another entrypoint with images.crop true warns, naming it', async () => {
  const result = await cropResult(makeCropSite({ config: configWithImage("image: { service: { entrypoint: './src/my-service.js' } },") }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes("'./src/my-service.js'") && result.message.includes('astroadmin/image-service'), result.message);
});

await check('crop MUTATION: the service set but images.crop not true warns that editors cannot crop', async () => {
  for (const adminConfig of [null, 'export default { images: { crop: false } };\n', 'export default { images: {} };\n']) {
    const result = await cropResult(makeCropSite({ adminConfig }));
    assert.equal(result.severity, 'warn', `${adminConfig}\n${JSON.stringify(result)}`);
    assert.ok(result.message.includes('images.crop') && result.message.includes('astroadmin.config.js'), result.message);
    assert.ok(/cannot crop/.test(result.message), result.message);
  }
});

await check('crop MUTATION: a stored crop on a site without the service warns, naming the image by its site path', async () => {
  for (const adminConfig of [null, ADMIN_CONFIG_WITH_CROP]) {
    const result = await cropResult(makeCropSite({ config: CONFIG_WITH_CSS_TARGET, adminConfig, metadata: METADATA_WITH_CROPS }));
    assert.equal(result.severity, 'warn', JSON.stringify(result));
    assert.ok(result.message.includes('.metadata.json') && result.message.includes('2 '), result.message);
    const details = result.details.join('\n');
    assert.ok(details.includes('/images/team/photo.jpg') && details.includes('legacy.jpg'), details);
    assert.ok(!details.includes('hero.jpg') && !details.includes('plain.jpg'), `only entries with a crop: ${details}`);
  }
});

await check('crop: a stored crop with the service set passes (control)', async () => {
  const result = await cropResult(makeCropSite({ metadata: METADATA_WITH_CROPS }));
  assert.equal(result.severity, 'pass', JSON.stringify(result));
  assert.ok(result.message.includes('2 '), result.message);
});

await check('crop MUTATION: a service the doctor cannot read statically warns to check by hand only when a crop is in play', async () => {
  const unreadable = configWithImage('image: { service: sharpImageService() },').replace("import { defineConfig } from 'astro/config';", "import { defineConfig, sharpImageService } from 'astro/config';");
  assert.ok(unreadable.includes('sharpImageService()'), 'the call was added');
  for (const options of [{ config: unreadable }, { config: unreadable, adminConfig: null, metadata: METADATA_WITH_CROPS }]) {
    const result = await cropResult(makeCropSite(options));
    assert.equal(result.severity, 'warn', JSON.stringify(result));
    assert.ok(result.message.includes('check by hand') && result.message.includes('image.service.entrypoint'), result.message);
  }
  const quiet = await cropResult(makeCropSite({ config: unreadable, adminConfig: null }));
  assert.equal(quiet.severity, 'skip', JSON.stringify(quiet));
});

await check('crop MUTATION: an astroadmin.config.js that does not load warns, naming the file', async () => {
  const result = await cropResult(makeCropSite({ adminConfig: 'throw new Error("boom");\n' }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('astroadmin.config.js') && result.message.includes('boom'), result.message);
});

await check('crop MUTATION: a .metadata.json that is not JSON warns', async () => {
  const result = await cropResult(makeCropSite({ metadata: '{ not json' }));
  assert.equal(result.severity, 'warn', JSON.stringify(result));
  assert.ok(result.message.includes('.metadata.json'), result.message);
});

await check('the checks name the version that added them', async () => {
  for (const id of ['unoptimised-images', 'cms-image-prerequisites', 'image-crop-service']) {
    const definition = DOCTOR_CHECKS.find((item) => item.id === id);
    assert.ok(definition && /^\d+\.\d+\.\d+$/.test(definition.since), `${id} since`);
  }
});

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(`\n📊 ${passed} checks passed.`);
