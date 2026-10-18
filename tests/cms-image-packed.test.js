/**
 * components/CmsImage.astro from the PUBLISHED tarball, in a real site:
 *
 * `npm pack` this checkout, install the tarball into a throwaway Astro 7.3.8
 * site with its own `sharp` ^0.35.5 (a real copy in node_modules, not a link
 * to this checkout), and `astro build` it. Then:
 *
 * - a raster /images/ path renders a <picture> with an AVIF and a WebP
 *   source of several widths, none wider than the original, and a JPEG
 *   fallback smaller than the original; the attributes the site passes
 *   (class, data-aa-field) land on the <img>;
 * - an upper-case `.JPG` upload in a subfolder is optimised too (the glob
 *   matches extensions in any case);
 * - SVG and external URLs stay plain <img>s with their original src;
 * - a /images/ path with no file, and one that differs only in case, each
 *   fail the build with an error naming the content value.
 *
 * Needs the network the first time (the site's install), then bun's cache.
 *
 *   bun tests/cms-image-packed.test.js     (~30 s warm)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import sharp from 'sharp';

const repoRoot = path.resolve(import.meta.dir, '..');
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cms-image-packed-')));
const siteDir = path.join(workDir, 'site');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
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

/** A noisy photo-like image; `seed` colours make every file's bytes distinct. */
async function photo(width, height, format, [red, green, blue]) {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: red, g: green, b: blue }, noise: { type: 'gaussian', mean: 120, sigma: 40 } },
  });
  return format === 'png' ? image.png().toBuffer() : image.jpeg({ quality: 95 }).toBuffer();
}

function buildSite() {
  fs.rmSync(path.join(siteDir, 'dist'), { recursive: true, force: true });
  return run('node', ['node_modules/astro/bin/astro.mjs', 'build'], siteDir);
}

function page(body) {
  return `---\nimport CmsImage from 'astroadmin/components/CmsImage.astro';\n---\n<html><body>\n${body}\n</body></html>\n`;
}

try {
  // --- the tarball -------------------------------------------------------
  const pack = run('npm', ['pack', '--pack-destination', workDir, '--silent'], repoRoot);
  assert.strictEqual(pack.status, 0, pack.output);
  const tarball = path.join(workDir, pack.output.trim().split('\n').filter(Boolean).pop());
  assert.ok(fs.existsSync(tarball), `npm pack produced ${tarball}`);

  // --- the site ----------------------------------------------------------
  writeSiteFile(
    'package.json',
    JSON.stringify(
      {
        name: 'cms-image-fixture',
        type: 'module',
        private: true,
        dependencies: { astro: '7.3.8', sharp: '^0.35.5', astroadmin: `file:${tarball}` },
      },
      null,
      2,
    ),
  );
  writeSiteFile('astro.config.mjs', "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n");
  const PHOTO_WIDTH = 1200;
  const photoPng = await photo(PHOTO_WIDTH, 800, 'png', [200, 60, 40]);
  const shotJpg = await photo(900, 600, 'jpeg', [40, 90, 200]);
  writeSiteFile('public/images/photo.png', photoPng);
  writeSiteFile('public/images/gallery/Shot.JPG', shotJpg);
  writeSiteFile(
    'public/images/logo.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  writeSiteFile(
    'src/pages/index.astro',
    page(
      [
        '<CmsImage src="/images/photo.png" alt="Photo" sizes="(min-width: 800px) 600px, 100vw" class="photo" data-aa-field="hero" />',
        '<CmsImage src="/images/gallery/Shot.JPG" alt="Shot" sizes="100vw" />',
        '<CmsImage src="/images/logo.svg" alt="Logo" sizes="40px" />',
        '<CmsImage src="https://example.com/remote.jpg" alt="Remote" sizes="100vw" />',
        '<CmsImage src="" alt="Empty" sizes="100vw" />',
      ].join('\n'),
    ),
  );

  const install = run('bun', ['install', '--no-save'], siteDir);
  assert.strictEqual(install.status, 0, install.output);
  const installed = path.join(siteDir, 'node_modules', 'astroadmin');
  assert.ok(!fs.lstatSync(installed).isSymbolicLink(), 'astroadmin is a real install, not a link');
  assert.ok(fs.existsSync(path.join(installed, 'components', 'CmsImage.astro')), 'the tarball ships the component');
  const versionOf = (name) => JSON.parse(fs.readFileSync(path.join(siteDir, 'node_modules', name, 'package.json'), 'utf8')).version;
  assert.strictEqual(versionOf('astro'), '7.3.8');
  const [sharpMajor, sharpMinor, sharpPatch] = versionOf('sharp').split('.').map(Number);
  assert.ok(sharpMajor > 0 || sharpMinor > 35 || (sharpMinor === 35 && sharpPatch >= 4), `site sharp ${versionOf('sharp')} >= 0.35.4`);

  // --- a good build ------------------------------------------------------
  const good = buildSite();
  assert.strictEqual(good.status, 0, good.output);
  const html = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf8');
  const pictures = html.match(/<picture>.*?<\/picture>/gs) || [];

  /** The width descriptors in a srcset, e.g. [400, 640, 1200]. */
  const widthsOf = (srcset) => [...srcset.matchAll(/ (\d+)w/g)].map((match) => Number(match[1]));
  const sourceSrcset = (picture, type) => {
    const match = picture.match(new RegExp(`<source[^>]*type="image/${type}"[^>]*>`));
    assert.ok(match, `a ${type} <source> in ${picture}`);
    return match[0].match(/srcset="([^"]+)"/)[1];
  };

  console.log('cms-image-packed:');
  check('two raster images become <picture>s', () => {
    assert.strictEqual(pictures.length, 2, html);
  });

  const photoPicture = pictures.find((picture) => picture.includes('alt="Photo"'));
  check('the PNG has AVIF and WebP sources of several widths, capped at the original', () => {
    for (const type of ['avif', 'webp']) {
      const srcset = sourceSrcset(photoPicture, type);
      const widths = widthsOf(srcset);
      assert.ok(widths.length >= 3, `${type}: several widths, got ${widths}`);
      assert.strictEqual(Math.max(...widths), PHOTO_WIDTH, `${type}: the largest is the original's width`);
      assert.ok(srcset.split(',').every((candidate) => candidate.trim().startsWith('/_astro/')), srcset);
      assert.ok(srcset.includes(`.${type} `), `${type} files: ${srcset}`);
    }
    assert.ok(photoPicture.includes('sizes="(min-width: 800px) 600px, 100vw"'), 'sizes is passed through');
  });

  check('the fallback is a JPEG, smaller than the original', () => {
    const img = photoPicture.match(/<img[^>]*>/)[0];
    const fallback = img.match(/ src="([^"]+)"/)[1];
    assert.ok(/^\/_astro\/.*\.jpg$/.test(fallback), fallback);
    const bytes = fs.statSync(path.join(siteDir, 'dist', fallback)).size;
    assert.ok(bytes < photoPng.length, `fallback ${bytes} B < original ${photoPng.length} B`);
  });

  check('class and data-aa-field land on the <img>', () => {
    const img = photoPicture.match(/<img[^>]*>/)[0];
    assert.ok(img.includes('data-aa-field="hero"'), img);
    assert.ok(/class="[^"]*\bphoto\b/.test(img), img);
  });

  check('an upper-case .JPG in a subfolder is optimised', () => {
    const shotPicture = pictures.find((picture) => picture.includes('alt="Shot"'));
    assert.ok(shotPicture, 'Shot.JPG became a <picture>');
    const widths = widthsOf(sourceSrcset(shotPicture, 'avif'));
    assert.ok(widths.length >= 2 && Math.max(...widths) === 900, `widths ${widths}`);
  });

  check('SVG and external URLs stay plain <img>s; empty renders nothing', () => {
    assert.ok(/<img src="\/images\/logo.svg" alt="Logo"/.test(html), html);
    assert.ok(/<img src="https:\/\/example.com\/remote.jpg" alt="Remote"/.test(html), html);
    assert.ok(!html.includes('alt="Empty"'), html);
    assert.ok(!html.includes('data-cms-image'), 'no dev-original marker in a build');
  });

  // --- strict errors at build --------------------------------------------
  const goodPage = fs.readFileSync(path.join(siteDir, 'src/pages/index.astro'), 'utf8');
  for (const [name, bad] of [
    ['a missing file', '/images/missing.png'],
    ['a path differing only in case', '/images/Photo.png'],
  ]) {
    check(`${name} fails the build, naming the content value`, () => {
      writeSiteFile('src/pages/index.astro', page(`<CmsImage src="${bad}" alt="" sizes="100vw" />`));
      const result = buildSite();
      assert.notStrictEqual(result.status, 0, `the build should fail for ${bad}`);
      assert.ok(result.output.includes(`CmsImage: "${bad}" names a local image`), result.output);
    });
  }
  writeSiteFile('src/pages/index.astro', goodPage);

  console.log(`\ncms-image-packed: ${passed} passed`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
