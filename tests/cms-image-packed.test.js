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
 * - SVG and external URLs stay plain <img>s with their original src; under
 *   `base: '/blog'` a local one is served under the base (/blog/images/...)
 *   and an external one is untouched;
 * - a /images/ path with no file, and one that differs only in case, each
 *   fail the build with an error naming the content value;
 * - a build with NODE_ENV=test (Astro then sets DEV=true, MODE stays
 *   'production') still keeps AVIF and still fails on a missing path;
 * - in `astro dev`, a <picture> has WebP sources and no AVIF (the build
 *   keeps AVIF in every <picture>);
 * - in `astro dev`, a file added after start renders as the plain original
 *   (data-cms-image="dev-original"), and a malformed %-escape is the strict
 *   error, not a URIError;
 * - both dev checks hold with NODE_ENV=production too (DEV is then false),
 *   and when `astro dev --root site` runs from the directory above the site
 *   (public/ is the site's, not the working directory's);
 * - focal point and crop (#82), from public/images/.metadata.json: a stored
 *   point is `object-position: 30% 20%` on the <img>, merged after the
 *   site's style string (`width: 100%; object-position: ...`) or into its
 *   style object (replacing the object's own objectPosition);
 *   `focalPoint={false}` opts out; a plain <img> (SVG) reads a legacy
 *   bare-filename entry, which applies to `/images/<name>` only and never
 *   to the same name in a subfolder (`/images/team/<name>` got it); an
 *   out-of-range point and a non-object entry are ignored; a stored crop
 *   without `astroadmin/image-service` fails the build naming the image and
 *   the setting; with the service the <img> is the crop's 600x400, the
 *   srcset widths follow it, the point is translated into the crop frame,
 *   and each emitted AVIF, WebP and JPEG is byte-identical to the site's
 *   sharp doing the service's own steps (rotate, extract, lossless PNG,
 *   then Astro's resize and encode at q80); the same service configured
 *   through a local re-export named by absolute path builds the same crop
 *   (CmsImage reads the loaded service's `supportsCrop` marker, not the
 *   entrypoint string, which failed the build); with no
 *   metadata file the page is byte-identical to the build before the file
 *   existed; in `astro dev` a point written after start is in the next
 *   render and a later change in the one after, a crop rides the /_image URL
 *   as `crop=` and (where Astro's dev endpoint serves at all, i.e. not under
 *   NODE_ENV=production) the served fallback is the 600x400 crop.
 *
 * Needs the network the first time (the site's install), then bun's cache.
 *
 *   bun tests/cms-image-packed.test.js     (~30 s warm)
 *
 * `bun test tests/cms-image-packed.test.js` works too; it sets NODE_ENV=test,
 * which the children inherit unless a check sets its own.
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

function run(command, args, cwd, envOverrides = {}) {
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', ...envOverrides };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
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

/**
 * `astro build`. `envOverrides` sets the child's env, e.g. { NODE_ENV: 'test' }:
 * Astro derives import.meta.env.DEV from NODE_ENV, not from the command, so a
 * build under a non-production NODE_ENV (CI, `bun test`) has DEV=true while
 * MODE stays 'production'.
 */
function buildSite(envOverrides = {}) {
  fs.rmSync(path.join(siteDir, 'dist'), { recursive: true, force: true });
  return run('node', ['node_modules/astro/bin/astro.mjs', 'build'], siteDir, envOverrides);
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
  writeSiteFile('public/images/.hidden.png', flatPng);
  writeSiteFile('public/images/wide.jpg', wideJpg);
  writeSiteFile('public/images/gallery/Shot.JPG', shotJpg);
  // One name at two depths, for the legacy bare-filename metadata key (#82).
  const legacyPng = await photo(500, 400, 'png', [170, 120, 30]);
  const teamLegacyPng = await photo(500, 400, 'png', [30, 120, 170]);
  writeSiteFile('public/images/legacy.png', legacyPng);
  writeSiteFile('public/images/team/legacy.png', teamLegacyPng);
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
  check('build: every <picture> keeps an AVIF source (dev-only WebP must not leak into builds)', () => {
    for (const picture of pictures) assert.ok(picture.includes('type="image/avif"'), picture);
  });
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
  // Twice: as inherited, and with NODE_ENV=test, which makes Astro's DEV true
  // in a build. The dev-original fallback must not apply in either (the case
  // path exists on a case-insensitive disk, so a DEV gate would render it).
  for (const [envLabel, envOverrides] of [['', {}], [' (NODE_ENV=test)', { NODE_ENV: 'test' }]]) {
    for (const [name, bad] of [
      ['a missing file', '/images/missing.png'],
      ['a path differing only in case', '/images/Photo.png'],
      // On disk but outside the glob (it skips dotfiles) on any filesystem.
      ['a dotfile the glob skips', '/images/.hidden.png'],
    ]) {
      check(`${name} fails the build, naming the content value${envLabel}`, () => {
        writeSiteFile('src/pages/index.astro', page(`<CmsImage src="${bad}" alt="" sizes="100vw" />`));
        const result = buildSite(envOverrides);
        assert.notStrictEqual(result.status, 0, `the build should fail for ${bad}`);
        assert.ok(result.output.includes(`CmsImage: "${bad}" names a local image`), result.output);
      });
    }
  }
  writeSiteFile('src/pages/index.astro', goodPage);

  // --- a build under a non-production NODE_ENV keeps AVIF -----------------
  const testEnvBuild = buildSite({ NODE_ENV: 'test' });
  assert.strictEqual(testEnvBuild.status, 0, testEnvBuild.output);
  const testEnvHtml = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf8');
  check('build with NODE_ENV=test: every <picture> keeps an AVIF source', () => {
    const testEnvPictures = testEnvHtml.match(/<picture>.*?<\/picture>/gs) || [];
    assert.strictEqual(testEnvPictures.length, 5, testEnvHtml);
    for (const picture of testEnvPictures) assert.ok(picture.includes('type="image/avif"'), picture);
    assert.ok(!testEnvHtml.includes('data-cms-image'), 'no dev-original marker in a build');
  });

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

  // --- a site with a `base` ----------------------------------------------
  // Public files are then served at /blog/images/..., so the files CmsImage
  // leaves unoptimised need the base too; an external URL does not.
  writeSiteFile('astro.config.mjs', "import { defineConfig } from 'astro/config';\nexport default defineConfig({ base: '/blog' });\n");
  const based = buildSite();
  assert.strictEqual(based.status, 0, based.output);
  const basedHtml = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf8');
  check("with a `base`, an SVG's src is under it; an external URL and Astro's own URLs are as they were", () => {
    assert.ok(/<img src="\/blog\/images\/logo.svg" alt="Logo"/.test(basedHtml), basedHtml);
    assert.ok(/<img src="https:\/\/example.com\/remote.jpg" alt="Remote"/.test(basedHtml), basedHtml);
    const basedPhoto = (basedHtml.match(/<picture>.*?<\/picture>/gs) || []).find((picture) => picture.includes('alt="Photo"'));
    assert.ok(basedPhoto, basedHtml);
    assert.ok(sourceSrcset(basedPhoto, 'avif').split(',').every((candidate) => candidate.trim().startsWith('/blog/_astro/')), basedPhoto);
    assert.ok(!basedHtml.includes('/blog/blog/'), 'the base is added once');
  });
  writeSiteFile('astro.config.mjs', "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n");

  // --- focal point and crop (#82) ------------------------------------------
  // The admin writes public/images/.metadata.json, keyed by site path with
  // legacy entries keyed by bare filename. CmsImage reads a focal point into
  // object-position (merged after the site's own style) and a crop into the
  // image service, which the site must enable.
  const METADATA_FILE = 'public/images/.metadata.json';
  const focalPage = page(
    [
      '<CmsImage src="/images/photo.png" alt="Photo" sizes="100vw" style="width: 100%" class="hero" data-aa-field="hero" />',
      '<CmsImage src="/images/photo.png" alt="Opted out" sizes="100vw" focalPoint={false} />',
      "<CmsImage src=\"/images/photo.png\" alt=\"Object\" sizes=\"100vw\" style={{ width: '100%', objectPosition: 'left top' }} />",
      '<CmsImage src="/images/logo.svg" alt="Logo" sizes="40px" />',
      '<CmsImage src="/images/gallery/Shot.JPG" alt="Shot" sizes="100vw" />',
      '<CmsImage src="/images/flat.png" alt="Flat" sizes="100vw" />',
      '<CmsImage src="/images/legacy.png" alt="Legacy" sizes="100vw" />',
      '<CmsImage src="/images/team/legacy.png" alt="Team legacy" sizes="100vw" />',
    ].join('\n'),
  );
  writeSiteFile('src/pages/focal.astro', focalPage);
  const CROP_SERVICE_CONFIG =
    "import { defineConfig } from 'astro/config';\n" +
    "export default defineConfig({ image: { service: { entrypoint: 'astroadmin/image-service' } } });\n";
  const imgOf = (markup, alt) => {
    const match = markup.match(new RegExp(`<img[^>]*alt="${alt}"[^>]*>`));
    assert.ok(match, `an <img alt="${alt}"> in ${markup}`);
    return match[0];
  };
  const styleOf = (img) => img.match(/ style="([^"]*)"/)?.[1];

  fs.rmSync(path.join(siteDir, METADATA_FILE), { force: true });
  const beforeMetadata = buildSite();
  assert.strictEqual(beforeMetadata.status, 0, beforeMetadata.output);
  const focalHtmlBefore = fs.readFileSync(path.join(siteDir, 'dist', 'focal', 'index.html'), 'utf8');
  // Control: the only object-position is the one the "Object" slot passes itself.
  assert.strictEqual((focalHtmlBefore.match(/object-position/g) || []).length, 1, focalHtmlBefore);
  assert.strictEqual(styleOf(imgOf(focalHtmlBefore, 'Object')), 'width:100%;object-position:left top', imgOf(focalHtmlBefore, 'Object'));
  assert.strictEqual(styleOf(imgOf(focalHtmlBefore, 'Photo')), 'width: 100%', imgOf(focalHtmlBefore, 'Photo'));

  const focalMetadata = {
    '/images/photo.png': { alt: 'A photo', focalPoint: { x: 30, y: 20 } },
    'logo.svg': { focalPoint: { x: 70, y: 10 } }, // a legacy entry, by bare filename
    '/images/gallery/Shot.JPG': { focalPoint: { x: 150, y: 20 } }, // out of range: ignored
    '/images/flat.png': 'junk', // not an entry: ignored
    'legacy.png': { focalPoint: { x: 10, y: 90 } }, // legacy: an older admin keyed only /images/<name>
  };
  writeSiteFile(METADATA_FILE, JSON.stringify(focalMetadata, null, 2));
  const withPoints = buildSite();
  assert.strictEqual(withPoints.status, 0, withPoints.output);
  const focalHtml = fs.readFileSync(path.join(siteDir, 'dist', 'focal', 'index.html'), 'utf8');
  check('a stored focal point is object-position on the <img>, merged after the site\'s style string', () => {
    const img = imgOf(focalHtml, 'Photo');
    assert.strictEqual(styleOf(img), 'width: 100%; object-position: 30% 20%', img);
    assert.ok(img.includes('data-aa-field="hero"') && /class="[^"]*\bhero\b/.test(img), 'the other attributes stay');
    assert.ok(!/crop=/.test(img) && !focalHtml.includes('[object Object]'), 'no crop attribute leaks');
  });
  check('a site style OBJECT gets object-position too, replacing its own', () => {
    const img = imgOf(focalHtml, 'Object');
    assert.strictEqual(styleOf(img), 'width:100%;object-position:30% 20%', img);
  });
  check('focalPoint={false} opts a slot out', () => {
    assert.strictEqual(styleOf(imgOf(focalHtml, 'Opted out')), undefined, imgOf(focalHtml, 'Opted out'));
  });
  check('a plain <img> (SVG) with a legacy bare-filename entry gets the point too', () => {
    const img = imgOf(focalHtml, 'Logo');
    assert.strictEqual(styleOf(img), 'object-position: 70% 10%', img);
    assert.ok(img.includes('src="/images/logo.svg"'), img);
  });
  check('an out-of-range point and a malformed entry are ignored', () => {
    assert.strictEqual(styleOf(imgOf(focalHtml, 'Shot')), undefined, imgOf(focalHtml, 'Shot'));
    assert.strictEqual(styleOf(imgOf(focalHtml, 'Flat')), undefined, imgOf(focalHtml, 'Flat'));
  });
  check('a legacy bare-filename entry applies to /images/<name> only, never to the same name in a subfolder', () => {
    const img = imgOf(focalHtml, 'Legacy');
    assert.strictEqual(styleOf(img), 'object-position: 10% 90%', img);
    const nested = imgOf(focalHtml, 'Team legacy');
    assert.strictEqual(styleOf(nested), undefined, `an unrelated photo got the point: ${nested}`);
  });

  // A crop: 25%/12.5% in, half the width and height of the 1200x800 photo,
  // so 600x400 at (300, 100); the point (60%, 20%) of the original is
  // (70%, 15%) of the crop.
  const crop = { x: 25, y: 12.5, width: 50, height: 50 };
  const cropBox = { left: 300, top: 100, width: 600, height: 400 };
  focalMetadata['/images/photo.png'] = { focalPoint: { x: 60, y: 20 }, crop };
  writeSiteFile(METADATA_FILE, JSON.stringify(focalMetadata, null, 2));
  check('a stored crop without the image service fails the build, naming the image and the setting', () => {
    const result = buildSite();
    assert.notStrictEqual(result.status, 0, 'the build should fail');
    assert.ok(result.output.includes('/images/photo.png'), result.output);
    assert.ok(result.output.includes('astroadmin/image-service'), result.output);
  });

  writeSiteFile('astro.config.mjs', CROP_SERVICE_CONFIG);
  const cropped = buildSite();
  assert.strictEqual(cropped.status, 0, cropped.output);
  const cropHtml = fs.readFileSync(path.join(siteDir, 'dist', 'focal', 'index.html'), 'utf8');
  const cropPicture = (cropHtml.match(/<picture>.*?<\/picture>/gs) || []).find((picture) => picture.includes('alt="Photo"'));
  assert.ok(cropPicture, cropHtml);
  check('with the service, the <img> size and the srcset widths follow the crop, and the point is translated into it', () => {
    const img = imgOf(cropPicture, 'Photo');
    assert.ok(img.includes('width="600"') && img.includes('height="400"'), img);
    assert.strictEqual(styleOf(img), 'width: 100%; object-position: 70% 15%', img);
    for (const type of ['avif', 'webp']) {
      assert.deepStrictEqual(widthsOf(sourceSrcset(cropPicture, type)), [400, 600], type);
    }
    assert.ok(!/crop=/.test(img) && !cropHtml.includes('[object Object]'), 'no crop attribute leaks');
    const optedOut = imgOf(cropHtml, 'Opted out');
    assert.ok(optedOut.includes('width="600"') && styleOf(optedOut) === undefined, `cropped, no point: ${optedOut}`);
  });
  // The service's own two steps: rotate and extract, kept lossless, then
  // Astro's resize and encode on that.
  const croppedPng = await siteSharp(photoPng, { failOn: 'none' }).rotate().extract(cropBox).png({ compressionLevel: 0 }).toBuffer();
  const cropQualities = [
    await encodedAt(variantAt(cropPicture, 'avif', 400), croppedPng, { width: 400, height: 267 }, 'avif', [50, 80]),
    await encodedAt(variantAt(cropPicture, 'webp', 400), croppedPng, { width: 400, height: 267 }, 'webp', [50, 80]),
    await encodedAt(fallbackOf(cropPicture), croppedPng, { width: 600, height: 400 }, 'jpeg', [50, 80]),
  ];
  check('each emitted AVIF, WebP and JPEG is byte-identical to sharp rotate -> extract -> resize -> encode at q80', () => {
    assert.deepStrictEqual(cropQualities, [80, 80, 80]);
  });
  const croppedFallbackSize = await siteSharp(fallbackOf(cropPicture)).metadata();
  check('the cropped fallback is 600x400', () => {
    assert.deepStrictEqual([croppedFallbackSize.width, croppedFallbackSize.height], [600, 400]);
  });

  // The same service by another spelling: Astro takes a string or URL for
  // the entrypoint, so a site may name a local file that re-exports it, by
  // absolute path. CmsImage must recognise the LOADED service (its own
  // marker), not the string `astroadmin/image-service`.
  writeSiteFile('image-service.mjs', "export { default } from 'astroadmin/image-service';\n");
  writeSiteFile(
    'astro.config.mjs',
    "import { defineConfig } from 'astro/config';\n" +
      "import { fileURLToPath } from 'node:url';\n" +
      "export default defineConfig({ image: { service: { entrypoint: fileURLToPath(new URL('./image-service.mjs', import.meta.url)) } } });\n",
  );
  const croppedLocal = buildSite();
  check('the service configured through a local re-export (an absolute path) builds the crop', () => {
    assert.strictEqual(croppedLocal.status, 0, croppedLocal.output);
  });
  const localHtml = fs.readFileSync(path.join(siteDir, 'dist', 'focal', 'index.html'), 'utf8');
  const localPicture = (localHtml.match(/<picture>.*?<\/picture>/gs) || []).find((picture) => picture.includes('alt="Photo"'));
  assert.ok(localPicture, localHtml);
  const localQualities = [
    await encodedAt(variantAt(localPicture, 'avif', 400), croppedPng, { width: 400, height: 267 }, 'avif', [50, 80]),
    await encodedAt(variantAt(localPicture, 'webp', 400), croppedPng, { width: 400, height: 267 }, 'webp', [50, 80]),
    await encodedAt(fallbackOf(localPicture), croppedPng, { width: 600, height: 400 }, 'jpeg', [50, 80]),
  ];
  check('...and each emitted file is the same crop, byte-identical to sharp rotate -> extract -> resize -> encode at q80', () => {
    assert.deepStrictEqual(localQualities, [80, 80, 80]);
    const img = imgOf(localPicture, 'Photo');
    assert.ok(img.includes('width="600"') && img.includes('height="400"'), img);
    assert.strictEqual(styleOf(img), 'width: 100%; object-position: 70% 15%', img);
  });
  fs.rmSync(path.join(siteDir, 'image-service.mjs'));

  fs.rmSync(path.join(siteDir, METADATA_FILE));
  writeSiteFile('astro.config.mjs', "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n");
  const afterMetadata = buildSite();
  assert.strictEqual(afterMetadata.status, 0, afterMetadata.output);
  check('with no metadata file the page is byte-identical to the build before it existed (no empty style, no reordering)', () => {
    const focalHtmlAfter = fs.readFileSync(path.join(siteDir, 'dist', 'focal', 'index.html'), 'utf8');
    assert.strictEqual(focalHtmlAfter, focalHtmlBefore);
    assert.strictEqual(styleOf(imgOf(focalHtmlAfter, 'Logo')), undefined);
  });
  fs.rmSync(path.join(siteDir, 'src/pages/focal.astro'));

  // --- astro dev ---------------------------------------------------------
  // A file added after the dev server starts is not in the glob yet: it
  // renders as the plain original. A malformed escape is "missing" (the
  // strict error), not an unhandled URIError. Run twice: as inherited, and
  // with NODE_ENV=production, under which Astro's DEV is false in dev (the
  // dev-only behaviours must follow the command, i.e. MODE).
  // `server.hmr: false`, as a proxied hosted preview runs it: without it the
  // watcher can add the late upload to the glob before the request lands.
  // The crop service is on here too: in dev a stored crop reaches the
  // /_image endpoint as a `crop=` parameter.
  writeSiteFile(
    'astro.config.mjs',
    "import { defineConfig } from 'astro/config';\n" +
      "export default defineConfig({ vite: { server: { hmr: false } }, image: { service: { entrypoint: 'astroadmin/image-service' } } });\n",
  );
  writeSiteFile('src/pages/focal.astro', focalPage);
  /**
   * `fromParent`: run `astro dev --root site` from the directory above the
   * site, as a site kept in a subfolder of its repo is. The dev-original
   * lookup must then use the site's root, not the process's working
   * directory (it read `process.cwd()/public`, and reported the upload missing).
   */
  /**
   * `cropService: false`: a dev server on a site WITHOUT the crop service. A
   * stored crop cannot apply there (a build would fail); dev renders the
   * photo uncropped and must say so where the editor looks: the <img> is
   * marked data-cms-image="crop-skipped" and the server log warns.
   */
  async function devChecks(envLabel, envOverrides, lateName, { fromParent = false, cropService = true } = {}) {
    if (!cropService) {
      writeSiteFile(
        'astro.config.mjs',
        "import { defineConfig } from 'astro/config';\nexport default defineConfig({ vite: { server: { hmr: false } } });\n",
      );
    }
    const port = await new Promise((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port: freePort } = probe.address();
        probe.close(() => resolve(freePort));
      });
    });
    writeSiteFile(
      'src/pages/dev.astro',
      page(`<CmsImage src="/images/${lateName}" alt="Late" sizes="100vw" class="late" data-aa-field="late" />`),
    );
    writeSiteFile('src/pages/malformed.astro', page('<CmsImage src="/images/bad%E0%A4%A.jpg" alt="" sizes="100vw" />'));
    const devCwd = fromParent ? workDir : siteDir;
    const astroBin = path.relative(devCwd, path.join(siteDir, 'node_modules/astro/bin/astro.mjs'));
    const rootArgs = fromParent ? ['--root', path.relative(devCwd, siteDir)] : [];
    const dev = spawn('node', [astroBin, 'dev', ...rootArgs, '--port', String(port), '--host', '127.0.0.1', '--ignore-lock'], {
      cwd: devCwd,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', ...envOverrides },
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
      const devIndexHtml = await devPage('/'); // started, glob read
      if (!cropService) {
        writeSiteFile(METADATA_FILE, JSON.stringify({ '/images/photo.png': { focalPoint: { x: 30, y: 20 }, crop } }));
        const skippedHtml = await devPage('/focal');
        fs.rmSync(path.join(siteDir, METADATA_FILE), { force: true });
        check(`dev${envLabel}: a stored crop the site cannot apply is skipped, marked crop-skipped and warned about`, () => {
          const img = imgOf(skippedHtml, 'Photo');
          assert.ok(img.includes('data-cms-image="crop-skipped"'), img);
          assert.ok(!/[?&]crop=/.test(img), `no crop on the URL: ${img}`);
          assert.ok(img.includes(`width="${Math.min(PHOTO_WIDTH, 1600)}"`), `the original's width, not the crop's: ${img}`);
          // The point stays in the ORIGINAL's frame when the crop is skipped.
          assert.strictEqual(styleOf(img), 'width: 100%; object-position: 30% 20%', img);
          assert.ok(/CmsImage: "\/images\/photo\.png" has a crop stored/.test(devOutput), devOutput.slice(-2000));
        });
        return;
      }
      check(`dev${envLabel}: pictures have WebP sources but no AVIF (AVIF encodes take ~20 s each in dev)`, () => {
        const devPhoto = (devIndexHtml.match(/<picture\b.*?<\/picture>/gs) || []).find((picture) => picture.includes('alt="Photo"'));
        assert.ok(devPhoto, `a Photo <picture> in dev: ${devIndexHtml.slice(0, 2000)}`);
        assert.ok(devPhoto.includes('type="image/webp"'), devPhoto);
        assert.ok(!devIndexHtml.includes('type="image/avif"'), 'an AVIF <source> in dev');
        const fallback = devPhoto.match(/<img[^>]*>/)[0];
        assert.ok(/f=jpg|\.jpg/.test(fallback), `the fallback is still a JPEG: ${fallback}`);
      });
      writeSiteFile(`public/images/${lateName}`, await photo(500, 300, 'png', [10, 10, 220]));
      const lateHtml = await devPage('/dev');
      check(`dev${envLabel}: an upload newer than the glob renders as the plain original`, () => {
        const img = lateHtml.match(/<img[^>]*alt="Late"[^>]*>/);
        assert.ok(img, lateHtml.slice(0, 2000));
        assert.ok(img[0].includes(`src="/images/${lateName}"`), img[0]);
        assert.ok(img[0].includes('data-cms-image="dev-original"'), img[0]);
        assert.ok(img[0].includes('data-aa-field="late"') && img[0].includes('late'), img[0]);
      });
      // A focal point written to .metadata.json after the server started
      // reaches the next render (the reader re-reads on a changed mtime or
      // size); a crop reaches the /_image endpoint and is applied there.
      fs.rmSync(path.join(siteDir, METADATA_FILE), { force: true });
      const focalNone = await devPage('/focal');
      assert.strictEqual(styleOf(imgOf(focalNone, 'Photo')), 'width: 100%', `control: no point stored: ${imgOf(focalNone, 'Photo')}`);
      writeSiteFile(METADATA_FILE, JSON.stringify({ '/images/photo.png': { focalPoint: { x: 30, y: 20 } } }));
      const focalFirst = await devPage('/focal');
      writeSiteFile(METADATA_FILE, JSON.stringify({ '/images/photo.png': { focalPoint: { x: 55, y: 65.5 }, crop } }));
      const focalSecond = await devPage('/focal');
      check(`dev${envLabel}: a focal point written after start is in the next render, and a later change in the one after`, () => {
        assert.strictEqual(styleOf(imgOf(focalFirst, 'Photo')), 'width: 100%; object-position: 30% 20%', imgOf(focalFirst, 'Photo'));
        // (55, 65.5) of the original is (60, 106) of the crop: clamped to 100.
        assert.strictEqual(styleOf(imgOf(focalSecond, 'Photo')), 'width: 100%; object-position: 60% 100%', imgOf(focalSecond, 'Photo'));
      });
      const devCroppedImg = imgOf(focalSecond, 'Photo');
      const devCroppedSrc = devCroppedImg.match(/ src="([^"]+)"/)[1].replace(/&amp;/g, '&');
      check(`dev${envLabel}: a stored crop sizes the <img> and rides the /_image URL as crop=`, () => {
        assert.ok(devCroppedImg.includes('width="600"') && devCroppedImg.includes('height="400"'), devCroppedImg);
        assert.ok(/[?&]crop=25(%2C|,)12\.5(%2C|,)50(%2C|,)50(&|$)/.test(devCroppedSrc), devCroppedSrc);
      });
      // Astro's own dev image endpoint (endpoint/dev.js) answers "Invalid
      // endpoint" whenever import.meta.env.DEV is false, which `astro dev`
      // under NODE_ENV=production is; the served bytes can only be checked
      // where that endpoint serves at all.
      if (envOverrides.NODE_ENV !== 'production') {
        const devCroppedResponse = await fetch(`http://127.0.0.1:${port}${devCroppedSrc}`);
        const devCroppedBytes = Buffer.from(await devCroppedResponse.arrayBuffer());
        assert.strictEqual(devCroppedResponse.status, 200, `/_image answered ${devCroppedResponse.status}: ${devCroppedBytes.toString('utf8').slice(0, 300)}\n${devOutput.slice(-1500)}`);
        const devCroppedSize = await siteSharp(devCroppedBytes).metadata();
        check(`dev${envLabel}: the /_image endpoint serves the 600x400 crop`, () => {
          assert.deepStrictEqual([devCroppedSize.width, devCroppedSize.height], [600, 400]);
        });
      }
      fs.rmSync(path.join(siteDir, METADATA_FILE), { force: true });
      // A render error in dev answers 200 with only the overlay client; the
      // error itself is in the server log.
      await devPage('/malformed');
      for (let attempt = 0; attempt < 50 && !/names a local image|URI malformed/.test(devOutput); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      check(`dev${envLabel}: a malformed %-escape is reported as a missing image, not a URIError`, () => {
        assert.ok(/CmsImage: \\?"\/images\/bad%E0%A4%A\.jpg\\?" names a local image/.test(devOutput), devOutput.slice(-3000));
        assert.ok(!/URI malformed/.test(devOutput), 'no URIError');
      });
    } finally {
      // --ignore-lock keeps Astro 7 in the foreground as our child (without it
      // `astro dev` detaches and outlives the test); stop it either way.
      dev.kill();
      spawnSync('node', [astroBin, 'dev', 'stop', ...rootArgs], { cwd: devCwd, encoding: 'utf8' });
    }
  }
  await devChecks('', {}, 'late.png');
  await devChecks(' (NODE_ENV=production)', { NODE_ENV: 'production' }, 'late-prod.png');
  await devChecks(' (run from the parent directory with --root)', {}, 'late-root.png', { fromParent: true });
  await devChecks(' (no crop service)', {}, 'late-noservice.png', { cropService: false });

  console.log(`\ncms-image-packed: ${passed} passed`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
