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
 * - every variant is encoded at quality 80 by default (Sharp's own AVIF
 *   default is 50): each emitted AVIF, WebP and JPEG file is byte-identical
 *   to the site's sharp encoding the same resize at q80, and differs from
 *   the q50 encode; `quality={50}` overrides it; a site that sets a quality
 *   in `image.service.config` keeps it; a PNG fallback gets no quality
 *   (a PNG quality makes Sharp quantise to a palette);
 * - an upper-case `.JPG` upload in a subfolder is optimised too (the glob
 *   matches extensions in any case);
 * - SVG and external URLs stay plain <img>s with their original src;
 * - a /images/ path with no file, and one that differs only in case, each
 *   fail the build with an error naming the content value;
 * - in `astro dev`, a file added after start renders as the plain original
 *   (data-cms-image="dev-original"), and a malformed %-escape is the strict
 *   error, not a URIError.
 *
 * Needs the network the first time (the site's install), then bun's cache.
 *
 *   bun tests/cms-image-packed.test.js     (~30 s warm)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'module';
import net from 'net';
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
  // Wider than the largest candidate width (2560): its own width must not
  // become a srcset candidate, or a 6000px upload ships 6000w variants.
  const WIDE_WIDTH = 3000;
  const wideJpg = await photo(WIDE_WIDTH, 1000, 'jpeg', [90, 160, 60]);
  writeSiteFile('public/images/photo.png', photoPng);
  const lowPng = await photo(1000, 700, 'png', [120, 180, 90]);
  const flatPng = await photo(700, 500, 'png', [60, 60, 160]);
  writeSiteFile('public/images/low.png', lowPng);
  writeSiteFile('public/images/flat.png', flatPng);
  writeSiteFile('public/images/wide.jpg', wideJpg);
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
        '<CmsImage src="/images/wide.jpg" alt="Wide" sizes="100vw" />',
        '<CmsImage src="/images/low.png" alt="Low" sizes="100vw" quality={50} />',
        '<CmsImage src="/images/flat.png" alt="Flat" sizes="100vw" fallbackFormat="png" />',
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
  check('five raster images become <picture>s', () => {
    assert.strictEqual(pictures.length, 5, html);
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

  // --- quality -------------------------------------------------------------
  // Method: re-run Astro 7.3.8's Sharp pipeline (sharp.js `transform`: rotate,
  // resize by width, or width and height for the fallback, then the format's
  // encoder) with the SITE's sharp on the original upload, at known
  // qualities, and compare bytes. The encoders are deterministic for one
  // sharp/libvips build, so the emitted file equals exactly one reference.
  // Each check also asserts the q50 and q80 references differ, so a match
  // cannot be a coincidence of quality not mattering on this input.
  const siteSharp = createRequire(path.join(siteDir, 'package.json'))('sharp');
  async function reference(original, { width, height }, format, quality) {
    const pipeline = siteSharp(original, { failOn: 'none', pages: -1 }).rotate();
    pipeline.resize(height ? { width, height, withoutEnlargement: true } : { width, withoutEnlargement: true });
    const options = quality === undefined ? undefined : { quality };
    if (format === 'avif') pipeline.avif(options);
    else if (format === 'webp') pipeline.webp(options);
    else if (format === 'png') pipeline.png(options);
    else pipeline.jpeg(options);
    return pipeline.toBuffer();
  }
  /** The emitted file for one srcset width, e.g. 800. */
  const variantAt = (picture, type, width) => {
    const candidate = sourceSrcset(picture, type)
      .split(',')
      .map((entry) => entry.trim().split(/\s+/))
      .find(([, descriptor]) => descriptor === `${width}w`);
    assert.ok(candidate, `a ${width}w ${type} candidate in ${picture}`);
    return fs.readFileSync(path.join(siteDir, 'dist', candidate[0]));
  };
  const fallbackOf = (picture) => {
    const src = picture.match(/<img[^>]*>/)[0].match(/ src="([^"]+)"/)[1];
    return fs.readFileSync(path.join(siteDir, 'dist', src));
  };
  /** Which of `qualities` produced `emitted`, or a description of the miss. */
  async function encodedAt(emitted, original, size, format, qualities) {
    const references = new Map();
    for (const quality of qualities) references.set(quality, await reference(original, size, format, quality));
    const sizes = [...references.values()].map((buffer) => buffer.length);
    assert.strictEqual(new Set(sizes).size, sizes.length, `${format} references must differ: ${sizes}`);
    for (const [quality, buffer] of references) if (buffer.equals(emitted)) return quality;
    return `none (emitted ${emitted.length} B; references ${[...references].map(([quality, buffer]) => `q${quality ?? 'default'} ${buffer.length} B`).join(', ')})`;
  }

  const photoSize = { width: 800 };
  const avifQuality = await encodedAt(variantAt(photoPicture, 'avif', 800), photoPng, photoSize, 'avif', [50, 80]);
  check('the default AVIF is encoded at q80, not Sharp\'s q50', () => {
    assert.strictEqual(avifQuality, 80);
  });
  const webpQuality = await encodedAt(variantAt(photoPicture, 'webp', 800), photoPng, photoSize, 'webp', [50, 80]);
  check('the default WebP is encoded at q80', () => {
    assert.strictEqual(webpQuality, 80);
  });
  const jpegQuality = await encodedAt(fallbackOf(photoPicture), photoPng, { width: PHOTO_WIDTH, height: 800 }, 'jpeg', [50, 80]);
  check('the default JPEG fallback is encoded at q80', () => {
    assert.strictEqual(jpegQuality, 80);
  });
  const lowPicture = pictures.find((picture) => picture.includes('alt="Low"'));
  const lowQualities = [];
  for (const type of ['avif', 'webp']) lowQualities.push(await encodedAt(variantAt(lowPicture, type, 640), lowPng, { width: 640 }, type, [50, 80]));
  lowQualities.push(await encodedAt(fallbackOf(lowPicture), lowPng, { width: 1000, height: 700 }, 'jpeg', [50, 80]));
  check('quality={50} overrides the default for every variant', () => {
    assert.deepStrictEqual(lowQualities, [50, 50, 50]);
  });
  const flatPicture = pictures.find((picture) => picture.includes('alt="Flat"'));
  const flatQualities = [
    await encodedAt(fallbackOf(flatPicture), flatPng, { width: 700, height: 500 }, 'png', [undefined, 80]),
    await encodedAt(variantAt(flatPicture, 'avif', 640), flatPng, { width: 640 }, 'avif', [50, 80]),
  ];
  check('a PNG fallback gets no quality (no palette), so its AVIF keeps Sharp\'s default', () => {
    assert.deepStrictEqual(flatQualities, [undefined, 50]);
  });

  check('an upper-case .JPG in a subfolder is optimised', () => {
    const shotPicture = pictures.find((picture) => picture.includes('alt="Shot"'));
    assert.ok(shotPicture, 'Shot.JPG became a <picture>');
    const widths = widthsOf(sourceSrcset(shotPicture, 'avif'));
    assert.ok(widths.length >= 2 && Math.max(...widths) === 900, `widths ${widths}`);
  });

  check('an original wider than every candidate stops at the largest candidate', () => {
    const widePicture = pictures.find((picture) => picture.includes('alt="Wide"'));
    for (const type of ['avif', 'webp']) {
      const widths = widthsOf(sourceSrcset(widePicture, type));
      assert.ok(!widths.includes(WIDE_WIDTH), `${type}: no ${WIDE_WIDTH}w candidate, got ${widths}`);
      assert.strictEqual(Math.max(...widths), 2560, `${type}: the largest is 2560, got ${widths}`);
    }
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

  // --- a site's own encoder quality wins over the default ------------------
  writeSiteFile(
    'astro.config.mjs',
    "import { defineConfig } from 'astro/config';\n" +
      'export default defineConfig({ image: { service: { config: { avif: { quality: 60 } } } } });\n',
  );
  writeSiteFile('src/pages/index.astro', page('<CmsImage src="/images/photo.png" alt="Photo" sizes="100vw" />'));
  const configured = buildSite();
  assert.strictEqual(configured.status, 0, configured.output);
  const configuredHtml = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf8');
  const configuredPicture = configuredHtml.match(/<picture>.*?<\/picture>/s)[0];
  const configuredQualities = [
    await encodedAt(variantAt(configuredPicture, 'avif', 800), photoPng, photoSize, 'avif', [60, 80]),
    await encodedAt(variantAt(configuredPicture, 'webp', 800), photoPng, photoSize, 'webp', [50, 80]),
  ];
  check('image.service.config.avif.quality is kept, not overridden by the default', () => {
    // AVIF at the site's 60; WebP at Sharp's own default, which is 80.
    assert.deepStrictEqual(configuredQualities, [60, 80]);
  });
  writeSiteFile('astro.config.mjs', "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n");
  writeSiteFile('src/pages/index.astro', goodPage);

  // --- astro dev ---------------------------------------------------------
  // A file added after the dev server starts is not in the glob yet: it
  // renders as the plain original. A malformed escape is "missing" (the
  // strict error), not an unhandled URIError.
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: freePort } = probe.address();
      probe.close(() => resolve(freePort));
    });
  });
  writeSiteFile(
    'src/pages/dev.astro',
    page('<CmsImage src="/images/late.png" alt="Late" sizes="100vw" class="late" data-aa-field="late" />'),
  );
  writeSiteFile('src/pages/malformed.astro', page('<CmsImage src="/images/bad%E0%A4%A.jpg" alt="" sizes="100vw" />'));
  const dev = spawn('node', ['node_modules/astro/bin/astro.mjs', 'dev', '--port', String(port), '--host', '127.0.0.1', '--ignore-lock'], {
    cwd: siteDir,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let devOutput = '';
  dev.stdout.on('data', (chunk) => (devOutput += chunk));
  dev.stderr.on('data', (chunk) => (devOutput += chunk));
  try {
    const devPage = async (route) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}${route}`);
          return await response.text();
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      throw new Error(`astro dev never answered on ${port}:\n${devOutput}`);
    };
    await devPage('/'); // started, glob read
    writeSiteFile('public/images/late.png', await photo(500, 300, 'png', [10, 10, 220]));
    const lateHtml = await devPage('/dev');
    check('dev: an upload newer than the glob renders as the plain original', () => {
      const img = lateHtml.match(/<img[^>]*alt="Late"[^>]*>/);
      assert.ok(img, lateHtml.slice(0, 2000));
      assert.ok(img[0].includes('src="/images/late.png"'), img[0]);
      assert.ok(img[0].includes('data-cms-image="dev-original"'), img[0]);
      assert.ok(img[0].includes('data-aa-field="late"') && img[0].includes('late'), img[0]);
    });
    // A render error in dev answers 200 with only the overlay client; the
    // error itself is in the server log.
    await devPage('/malformed');
    for (let attempt = 0; attempt < 50 && !/names a local image|URI malformed/.test(devOutput); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check('dev: a malformed %-escape is reported as a missing image, not a URIError', () => {
      assert.ok(/CmsImage: \\?"\/images\/bad%E0%A4%A\.jpg\\?" names a local image/.test(devOutput), devOutput.slice(-3000));
      assert.ok(!/URI malformed/.test(devOutput), 'no URIError');
    });
  } finally {
    // --ignore-lock keeps Astro 7 in the foreground as our child (without it
    // `astro dev` detaches and outlives the test); stop it either way.
    dev.kill();
    spawnSync('node', ['node_modules/astro/bin/astro.mjs', 'dev', 'stop'], { cwd: siteDir, encoding: 'utf8' });
  }

  console.log(`\ncms-image-packed: ${passed} passed`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
