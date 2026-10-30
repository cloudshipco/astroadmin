/**
 * components/CmsVideo.astro from the PUBLISHED tarball, in a real site, then
 * in a real browser.
 *
 * `npm pack` this checkout, install the tarball into a throwaway Astro 7.3.8
 * site (with its own sharp, for the poster), `astro build`, and check:
 *
 * - the markup: a <video> with muted, loop, playsinline and preload, NO
 *   autoplay attribute (the script starts it, so reduced motion can stop it),
 *   a <source> of the right type, the attributes the site passes (class,
 *   data-aa-field) on the <video>, wrapperClass on the wrapper, and a
 *   pause/play button that starts hidden;
 * - the poster: a /images/ PNG becomes an optimised WebP under /_astro/, no
 *   wider than posterWidth; an external poster stays as it is;
 * - an empty src renders nothing; a /images/ video with no file fails the
 *   build naming the value, and so does a missing poster (also one with a
 *   `?query` or `#fragment`, which is not part of the file but stays on the
 *   URL, also after optimising);
 * - symlinks: `public/images` itself a link to a shared folder outside the
 *   site (releases/N/public/images -> /srv/shared/images) builds, while a
 *   FILE that is a link out of public/ and its own folder still fails.
 *
 * The browser script must be a same-origin FILE: Astro inlines a small
 * component <script>, which a site's `script-src 'self'` blocks silently.
 *
 * Then the built page in Chromium (Playwright, an existing headless shell;
 * set CHROMIUM_PATH to choose one), served with a strict CSP
 * (`script-src 'self'`): the video plays by itself, the button
 * pauses and resumes it and says which it will do; under
 * `prefers-reduced-motion: reduce` it does not play and shows the poster,
 * and Play starts it. The browser checks use the WebM fixture (open-source
 * Chromium has no H.264).
 *
 *   bun tests/cms-video-packed.test.js     (~15 s warm; the first install needs the network)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { launchChromium } from './chromium-path.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const fixtures = path.join(repoRoot, 'tests/fixtures/video');
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cms-video-packed-')));
const siteDir = path.join(workDir, 'site');

let passed = 0;
async function check(name, fn) {
  await fn();
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

function buildSite() {
  fs.rmSync(path.join(siteDir, 'dist'), { recursive: true, force: true });
  return run('node', ['node_modules/astro/bin/astro.mjs', 'build'], siteDir, { NODE_ENV: 'production' });
}

function page(body) {
  return `---\nimport CmsVideo from 'astroadmin/components/CmsVideo.astro';\n---\n<html><body>\n${body}\n</body></html>\n`;
}

/**
 * The CSP every page is served with: a strict site's, which allows only
 * same-origin scripts. An inline script (which Astro makes of a small
 * component <script>) or a data: URL script is blocked by it, and nothing
 * else reports that: the video just never starts. Styles are allowed inline,
 * since Astro inlines small stylesheets too and that is the site's setting.
 */
const STRICT_CSP = "default-src 'self'; script-src 'self'; media-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'";

/** A static server for dist/, with Range support (Bun.file responses), pages under STRICT_CSP. */
function serveDist() {
  const distDir = path.join(siteDir, 'dist');
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      let pathname = decodeURIComponent(new URL(request.url).pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const filePath = path.join(distDir, pathname);
      if (!filePath.startsWith(distDir + path.sep) || !fs.existsSync(filePath)) return new Response('not found', { status: 404 });
      const headers = filePath.endsWith('.html') ? { 'Content-Security-Policy': STRICT_CSP } : {};
      return new Response(Bun.file(filePath), { headers });
    },
  });
}

let browser;
let server;
try {
  const pack = run('npm', ['pack', '--pack-destination', workDir, '--silent'], repoRoot);
  assert.strictEqual(pack.status, 0, pack.output);
  const tarball = path.join(workDir, pack.output.trim().split('\n').filter(Boolean).pop());

  writeSiteFile('package.json', JSON.stringify({
    name: 'cms-video-fixture',
    type: 'module',
    private: true,
    dependencies: { astro: '7.3.8', sharp: '^0.35.5', astroadmin: `file:${tarball}` },
  }, null, 2));
  writeSiteFile('astro.config.mjs', "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n");
  writeSiteFile('public/images/hero.mp4', fs.readFileSync(path.join(fixtures, 'clip.mp4')));
  writeSiteFile('public/images/loop.webm', fs.readFileSync(path.join(fixtures, 'clip.webm')));
  // A link out of the site (to a file a build must not publish): refused.
  fs.writeFileSync(path.join(workDir, 'outside.mp4'), fs.readFileSync(path.join(fixtures, 'clip.mp4')));
  fs.symlinkSync(path.join(workDir, 'outside.mp4'), path.join(siteDir, 'public/images/linked-out.mp4'));
  // In public/images but on no page: the glob bundled these too (#90).
  writeSiteFile('public/images/unused/spare.webm', fs.readFileSync(path.join(fixtures, 'clip.webm')));
  writeSiteFile('public/images/spare.png', await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer());
  const POSTER_WIDTH = 2400;
  writeSiteFile('public/images/still.png', await sharp({
    create: { width: POSTER_WIDTH, height: 1350, channels: 3, background: { r: 30, g: 90, b: 160 } },
  }).png().toBuffer());

  const goodPage = page([
    '<CmsVideo src="/images/hero.mp4" poster="/images/still.png" class="hero-video" data-aa-field="heroVideo" wrapperClass="hero-wrap" label="hero video" />',
    '<CmsVideo src="/images/loop.webm" poster="https://example.com/still.jpg" id="loop" />',
    '<CmsVideo src="" />',
    '<CmsVideo src="https://cdn.example.com/loop.mp4?v=2" id="remote" />',
  ].join('\n'));
  writeSiteFile('src/pages/index.astro', goodPage);
  // A site whose CSS is in cascade layers, as every Tailwind v4 site's is:
  // the layer order statement, a reset in `base` (Tailwind's preflight strips
  // a button's background), utilities in `utilities`, and one UNLAYERED site
  // rule. Unlayered CSS beats every layer whatever its specificity, so the
  // component's own rules must be layered below utilities, or
  // wrapperClass="absolute inset-0" is ignored.
  // The same site with its stylesheet linked from public/ at the end of the
  // body, so CmsVideo's CSS reaches the page first and its \`components\`
  // layer is declared before the site's layer order statement. (Astro puts
  // a site's own imported CSS before a package component's, so a site gets
  // this order only by loading its CSS late, as here.)
  writeSiteFile('public/site.css', `@layer theme, base, components, utilities;
@layer base { button { background: transparent; border-radius: 0; } }
@layer utilities { .absolute { position: absolute; } .inset-0 { inset: 0; } .h-full { height: 100%; } }
.hero { position: relative; width: 800px; height: 450px; display: flex; }
.restyled { --cms-video-toggle-background: rgb(255, 0, 0); }
`);
  writeSiteFile('src/pages/layers-late.astro', `---
import CmsVideo from 'astroadmin/components/CmsVideo.astro';
---
<html><head></head><body>
<section class="hero" id="hero"><CmsVideo src="/images/loop.webm" wrapperClass="absolute inset-0" class="h-full" id="covering" /><h1>Title</h1></section>
<div class="restyled"><CmsVideo src="/images/loop.webm" id="restyled" /></div>
<link rel="stylesheet" href="/site.css" is:inline>
</body></html>
`);
  writeSiteFile('src/pages/layers.astro', `---
import CmsVideo from 'astroadmin/components/CmsVideo.astro';
---
<html><head>
<style is:global>
  @layer theme, base, components, utilities;
  @layer base { button { background: transparent; border-radius: 0; } }
  @layer utilities {
    .absolute { position: absolute; }
    .inset-0 { inset: 0; }
    .h-full { height: 100%; }
  }
  .hero { position: relative; width: 800px; height: 450px; display: flex; }
  .restyled { --cms-video-toggle-background: rgb(255, 0, 0); }
</style>
</head><body>
<section class="hero" id="hero"><CmsVideo src="/images/loop.webm" wrapperClass="absolute inset-0" class="h-full" id="covering" /><h1>Title</h1></section>
<div class="restyled"><CmsVideo src="/images/loop.webm" id="restyled" /></div>
</body></html>
`);

  const install = run('bun', ['install', '--no-save'], siteDir);
  assert.strictEqual(install.status, 0, install.output);
  const installed = path.join(siteDir, 'node_modules', 'astroadmin');
  assert.ok(!fs.lstatSync(installed).isSymbolicLink(), 'astroadmin is a real install, not a link');
  assert.ok(fs.existsSync(path.join(installed, 'components', 'CmsVideo.astro')), 'the tarball ships the component');

  const good = buildSite();
  assert.strictEqual(good.status, 0, good.output);
  const html = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf8');
  const videos = html.match(/<video\b[^>]*>/g) || [];
  const wrappers = html.match(/<div[^>]*data-cms-video[^>]*>/g) || [];

  console.log('cms-video-packed:');
  await check('three videos render (one a remote file URL); an empty src renders nothing', () => {
    assert.strictEqual(videos.length, 3, html);
    assert.strictEqual(wrappers.length, 3, html);
    assert.match(html, /<source src="https:\/\/cdn\.example\.com\/loop\.mp4\?v=2" type="video\/mp4"/, 'a video file URL is used as it is, typed');
  });

  const hero = videos.find((tag) => tag.includes('hero-video'));
  await check('the <video> is muted, looping, inline and metadata-preloaded, with no autoplay attribute', () => {
    for (const tag of videos) {
      for (const attribute of ['muted', 'loop', 'playsinline']) assert.match(tag, new RegExp(`\\b${attribute}\\b`), `${attribute}: ${tag}`);
      assert.match(tag, /preload="metadata"/, tag);
      assert.doesNotMatch(tag, /\bautoplay\b/, tag);
    }
  });
  await check('sources carry their type; site attributes land on the <video>, wrapperClass on the wrapper', () => {
    assert.match(html, /<source src="\/images\/hero\.mp4" type="video\/mp4"/);
    assert.match(html, /<source src="\/images\/loop\.webm" type="video\/webm"/);
    assert.match(hero, /data-aa-field="heroVideo"/);
    assert.match(hero, /class="hero-video"/);
    assert.ok(wrappers.some((tag) => /class="cms-video hero-wrap"/.test(tag)), wrappers.join('\n'));
  });
  await check('a pause/play button ships with every video, hidden until the script wires it', () => {
    const buttons = html.match(/<button[^>]*data-cms-video-toggle[^>]*>/g) || [];
    assert.strictEqual(buttons.length, 3);
    for (const button of buttons) assert.match(button, /\bhidden\b/, button);
    assert.match(buttons[0], /aria-label="Play hero video"/);
  });
  await check('the browser script is a same-origin file, never inline or a data: URL (a strict CSP allows it)', () => {
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
    const inline = scripts.filter((tag) => !/\ssrc=/.test(tag) && /cms-video|matchMedia/.test(tag));
    assert.deepStrictEqual(inline, [], 'an inline CmsVideo script');
    const sources = [...new Set(scripts.map((tag) => tag.match(/\ssrc="([^"]+)"/)?.[1]).filter(Boolean))];
    assert.strictEqual(sources.length, 1, `one script file: ${sources}`);
    assert.match(sources[0], /^\/_astro\/cms-video-client\.[\w-]+\.js$/, sources[0]);
    const emitted = fs.readFileSync(path.join(siteDir, 'dist', sources[0]), 'utf8');
    assert.ok(emitted.includes('[data-cms-video]'), 'the emitted file is the script');
  });

  await check('a /images/ poster is an optimised WebP no wider than posterWidth; an external one is untouched', () => {
    const poster = hero.match(/poster="([^"]+)"/)?.[1];
    assert.ok(poster && /^\/_astro\/.*\.webp$/.test(poster), `poster: ${poster}`);
    const posterFile = path.join(siteDir, 'dist', poster);
    const width = spawnSync('node', ['-e', `require('sharp')(${JSON.stringify(posterFile)}).metadata().then(m => console.log(m.width))`], { cwd: siteDir, encoding: 'utf8' }).stdout.trim();
    assert.strictEqual(Number(width), 1920, `poster width ${width}`);
    assert.match(videos.find((tag) => tag.includes('id="loop"')), /poster="https:\/\/example\.com\/still\.jpg"/);
  });

  // #90: the existence check must not make Vite bundle the videos. A glob
  // entry is a module importing the file, so each video was emitted a second
  // time as _astro/<name>.<hash>.mp4, beside the copy public/ already serves.
  await check('each video ships once, from /images/: no copy under _astro/ (#90)', () => {
    const emitted = fs.readdirSync(path.join(siteDir, 'dist', '_astro'));
    assert.deepStrictEqual(emitted.filter((name) => /\.(mp4|webm)$/i.test(name)), [], `videos under _astro/: ${emitted.join(', ')}`);
    // Positive control: the videos the page plays are in the build, under /images/.
    for (const name of ['hero.mp4', 'loop.webm', 'unused/spare.webm']) assert.ok(fs.existsSync(path.join(siteDir, 'dist', 'images', name)), `dist/images/${name}`);
    assert.ok(emitted.some((name) => name.endsWith('.webp')), 'the _astro/ listing is the real one (the optimised poster is in it)');
    console.log(`  (info) _astro/ images: ${emitted.filter((name) => /\.(png|jpe?g|webp|avif)$/i.test(name)).join(', ')}`);
  });

  // --- the browser ------------------------------------------------------
  server = serveDist();
  browser = await launchChromium(chromium);
  const pageUrl = `http://127.0.0.1:${server.port}/`;

  /** Wait until the loop video's state matches, or fail with what it is. */
  async function videoState(tab) {
    return tab.evaluate(() => {
      const video = document.querySelector('#loop');
      const toggle = video.closest('[data-cms-video]').querySelector('[data-cms-video-toggle]');
      return { paused: video.paused, time: video.currentTime, label: toggle.getAttribute('aria-label'), hidden: toggle.hidden };
    });
  }

  await check('in a browser the video plays by itself; the button pauses and resumes it', async () => {
    const tab = await browser.newPage();
    const violations = [];
    // Script violations only: the page's remote video (cdn.example.com) is
    // blocked by media-src 'self', as it should be.
    tab.on('console', (message) => { if (/Content Security Policy/i.test(message.text()) && /script/i.test(message.text())) violations.push(message.text()); });
    await tab.goto(pageUrl);
    await tab.waitForFunction(() => {
      const video = document.querySelector('#loop');
      return !video.paused && video.currentTime > 0.2;
    }, null, { timeout: 10000 });
    let state = await videoState(tab);
    assert.strictEqual(state.hidden, false, 'the button is shown once wired');
    assert.strictEqual(state.label, 'Pause background video');

    // The button is reachable, not just present: the topmost element at its centre.
    const toggle = tab.locator('#loop').locator('xpath=..').locator('[data-cms-video-toggle]');
    const box = await toggle.boundingBox();
    const onTop = await tab.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-cms-video-toggle]') !== null, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    assert.ok(onTop, 'the button is the topmost element at its centre');

    await toggle.click();
    state = await videoState(tab);
    assert.strictEqual(state.paused, true, 'paused by the button');
    assert.strictEqual(state.label, 'Play background video');
    const pausedAt = state.time;
    await tab.waitForTimeout(500);
    assert.strictEqual((await videoState(tab)).time, pausedAt, 'stays paused');

    await toggle.click();
    await tab.waitForFunction(() => !document.querySelector('#loop').paused, null, { timeout: 5000 });
    assert.strictEqual((await videoState(tab)).label, 'Pause background video');
    assert.deepStrictEqual(violations, [], 'CSP script violations');
    await tab.close();
  });

  await check('under prefers-reduced-motion it does not play, and Play starts it', async () => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const tab = await context.newPage();
    await tab.goto(pageUrl);
    await tab.waitForFunction(() => !document.querySelector('#loop').closest('[data-cms-video]').querySelector('[data-cms-video-toggle]').hidden);
    await tab.waitForTimeout(1000);
    const state = await videoState(tab);
    assert.strictEqual(state.paused, true, 'not playing');
    assert.strictEqual(state.time, 0, 'never started');
    assert.strictEqual(state.label, 'Play background video');

    await tab.locator('#loop').locator('xpath=..').locator('[data-cms-video-toggle]').click();
    await tab.waitForFunction(() => !document.querySelector('#loop').paused, null, { timeout: 5000 });
    await context.close();
  });
  await check("in a layered (Tailwind v4) site, in either CSS order, utilities on wrapperClass win and the button keeps its look", async () => {
    // layers/: the site's CSS first (a layout importing it before any
    // component); layers-late/: CmsVideo's first. Both orders must hold.
    for (const route of ['layers/', 'layers-late/']) {
    const tab = await browser.newPage();
    await tab.goto(`${pageUrl}${route}`);
    await tab.waitForLoadState('load');
    // Which stylesheet the page met first: the site's (its layer order
    // statement) or CmsVideo's (its :where(.cms-video-toggle) rule).
    const siteFirst = await tab.evaluate(() => {
      const sheets = [...document.styleSheets].map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText).join('\n'));
      const site = sheets.findIndex((text) => text.includes('@layer theme'));
      const component = sheets.findIndex((text) => text.includes(':where(.cms-video-toggle)'));
      if (site === component) {
        const text = sheets[site];
        return text.indexOf('@layer theme') < text.indexOf(':where(.cms-video-toggle)');
      }
      return site < component;
    });
    assert.strictEqual(siteFirst, route === 'layers/', `${route}: the CSS order this page is meant to test`);
    const measured = await tab.evaluate(() => {
      const hero = document.querySelector('#hero').getBoundingClientRect();
      const wrapper = document.querySelector('#covering').closest('[data-cms-video]');
      const box = wrapper.getBoundingClientRect();
      // The visible circle is the button's face (the <button> itself is bare).
      const toggleStyle = (id) => getComputedStyle(document.querySelector(id).closest('[data-cms-video]').querySelector('.cms-video-toggle-face'));
      return {
        position: getComputedStyle(wrapper).position,
        covers: [box.left - hero.left, box.top - hero.top, box.width - hero.width, box.height - hero.height],
        defaultBackground: toggleStyle('#covering').backgroundColor,
        defaultRadius: toggleStyle('#covering').borderRadius,
        restyledBackground: toggleStyle('#restyled').backgroundColor,
      };
    });
    assert.strictEqual(measured.position, 'absolute', `${route}: the utility on wrapperClass`);
    assert.deepStrictEqual(measured.covers, [0, 0, 0, 0], `${route}: the wrapper covers the hero`);
    assert.strictEqual(measured.defaultBackground, 'rgba(0, 0, 0, 0.6)', `${route}: the button keeps its look over a base-layer reset`);
    assert.notStrictEqual(measured.defaultRadius, '0px', `${route}: the button stays round over a base-layer reset`);
    assert.strictEqual(measured.restyledBackground, 'rgb(255, 0, 0)', `${route}: the site's custom property restyles it`);
    await tab.close();
    }
  });

  await browser.close();
  browser = undefined;
  server.stop(true);
  server = undefined;

  // --- missing files fail the build -------------------------------------
  for (const [what, body, value] of [
    ['video', '<CmsVideo src="/images/gone.mp4" />', '/images/gone.mp4'],
    ['video (case differs)', '<CmsVideo src="/images/Hero.mp4" />', '/images/Hero.mp4'],
    ['video (folder case differs)', '<CmsVideo src="/images/Unused/spare.webm" />', '/images/Unused/spare.webm'],
    ['video with a fragment', '<CmsVideo src="/images/gone.mp4#t=5" />', '/images/gone.mp4#t=5'],
    ['video (a symlink out of the site)', '<CmsVideo src="/images/linked-out.mp4" />', '/images/linked-out.mp4'],
    ['poster', '<CmsVideo src="/images/hero.mp4" poster="/images/gone.png" />', '/images/gone.png'],
    ['poster with a ?query', '<CmsVideo src="/images/hero.mp4" poster="/images/gone.png?v=2" />', '/images/gone.png?v=2'],
    ['poster with a #fragment', '<CmsVideo src="/images/hero.mp4" poster="/images/gone.png#x" />', '/images/gone.png#x'],
    ['typed bare name', '<CmsVideo src="hero.mp4" />', 'hero.mp4'],
    ['YouTube page', '<CmsVideo src="https://www.youtube.com/watch?v=abc" />', 'https://www.youtube.com/watch?v=abc'],
  ]) {
    await check(`${what.startsWith('typed') || what.startsWith('YouTube') ? 'not a video file:' : 'a missing'} ${what} fails the build, naming the value`, () => {
      writeSiteFile('src/pages/index.astro', page(body));
      const failed = buildSite();
      assert.notStrictEqual(failed.status, 0, failed.output);
      assert.ok(failed.output.includes(`"${value}"`), failed.output);
    });
  }
  writeSiteFile('src/pages/index.astro', goodPage);

  await check('a local video with a ?query or #fragment is found (the file is the path before it) and keeps it', () => {
    writeSiteFile('src/pages/index.astro', page('<CmsVideo src="/images/hero.mp4#t=5" id="a" />\n<CmsVideo src="/images/loop.webm?v=2" id="b" />'));
    const built = buildSite();
    assert.strictEqual(built.status, 0, built.output);
    const builtHtml = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf8');
    assert.match(builtHtml, /<source src="\/images\/hero\.mp4#t=5" type="video\/mp4"/);
    assert.match(builtHtml, /<source src="\/images\/loop\.webm\?v=2" type="video\/webm"/);
  });
  writeSiteFile('src/pages/index.astro', goodPage);

  await check('a local poster with a ?query is found and optimised, and keeps the query', () => {
    writeSiteFile('src/pages/index.astro', page('<CmsVideo src="/images/hero.mp4" poster="/images/still.png?v=2" id="a" />'));
    const built = buildSite();
    assert.strictEqual(built.status, 0, built.output);
    const builtHtml = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf8');
    assert.match(builtHtml, /poster="\/_astro\/[^"?]+\.webp\?v=2"/, builtHtml.match(/<video\b[^>]*>/)?.[0]);
  });
  writeSiteFile('src/pages/index.astro', goodPage);

  // A common deploy layout keeps uploads outside each release:
  // releases/N/public/images -> /srv/shared/images. A symlinked FOLDER is the
  // site owner's layout and builds; a FILE that is itself a link out of the
  // folder it sits in is still refused (the build would publish its target).
  await check('a public/images that is a symlink to a shared folder outside the site builds; a file linking out still fails', () => {
    const imagesDir = path.join(siteDir, 'public/images');
    const sharedDir = path.join(workDir, 'shared-images');
    fs.renameSync(imagesDir, sharedDir);
    fs.symlinkSync(sharedDir, imagesDir);
    try {
      assert.ok(fs.lstatSync(imagesDir).isSymbolicLink(), 'positive control: public/images is a link');
      writeSiteFile('src/pages/index.astro', page('<CmsVideo src="/images/hero.mp4" poster="/images/still.png" id="a" />\n<CmsVideo src="/images/unused/spare.webm" id="b" />'));
      const built = buildSite();
      assert.strictEqual(built.status, 0, built.output);
      const builtHtml = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf8');
      assert.match(builtHtml, /<source src="\/images\/hero\.mp4" type="video\/mp4"/);
      assert.match(builtHtml, /<source src="\/images\/unused\/spare\.webm"/);
      assert.match(builtHtml, /poster="\/_astro\/[^"]+\.webp"/, 'the poster is optimised through the link');
      writeSiteFile('src/pages/index.astro', page('<CmsVideo src="/images/linked-out.mp4" />'));
      const refused = buildSite();
      assert.notStrictEqual(refused.status, 0, refused.output);
      assert.ok(refused.output.includes('"/images/linked-out.mp4"'), refused.output);
      writeSiteFile('src/pages/index.astro', page('<CmsVideo src="/images/Hero.mp4" />'));
      const wrongCase = buildSite();
      assert.notStrictEqual(wrongCase.status, 0, 'the exact-case check still applies through the link');
    } finally {
      fs.unlinkSync(imagesDir);
      fs.renameSync(sharedDir, imagesDir);
    }
  });
  writeSiteFile('src/pages/index.astro', goodPage);

  await check("with a `base`, local video and poster paths are served under it", () => {
    writeSiteFile('astro.config.mjs', "import { defineConfig } from 'astro/config';\nexport default defineConfig({ base: '/blog' });\n");
    writeSiteFile('src/pages/index.astro', page('<CmsVideo src="/images/hero.mp4" poster="/images/still.png" id="a" />\n<CmsVideo src="/images/loop.webm" poster="/images/logo.svg" id="b" />'));
    writeSiteFile('public/images/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
    const based = buildSite();
    assert.strictEqual(based.status, 0, based.output);
    const basedHtml = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf8');
    assert.match(basedHtml, /<source src="\/blog\/images\/hero\.mp4"/);
    assert.match(basedHtml, /<source src="\/blog\/images\/loop\.webm"/);
    assert.match(basedHtml, /poster="\/blog\/_astro\/[^"]+\.webp"/, 'the optimised poster');
    assert.match(basedHtml, /poster="\/blog\/images\/logo\.svg"/, 'an SVG poster as it is, under base');
    assert.match(basedHtml, /<script type="module" src="\/blog\/_astro\/cms-video-client\.[\w-]+\.js"/, 'the script file under base');
  });

  // --- astro dev (the editor's preview) ---------------------------------
  // `?url&no-inline` must resolve in dev too, where Vite serves the file
  // itself; the hosted preview is `astro dev`. Run as `astro dev --root site`
  // from the directory above the site, so the working directory is not the
  // site's root: a video uploaded after start is looked up in the SITE's
  // public/ (it read `process.cwd()/public`, and reported the upload
  // missing). `server.hmr: false`, as the hosted preview runs it: otherwise
  // the watcher can add the upload to the glob before the request lands.
  writeSiteFile('astro.config.mjs', "import { defineConfig } from 'astro/config';\nexport default defineConfig({ vite: { server: { hmr: false } } });\n");
  writeSiteFile('src/pages/index.astro', goodPage);
  writeSiteFile('src/pages/late.astro', page('<CmsVideo src="/images/late.webm" poster="/images/late-still.png" id="late" />'));
  const astroBin = path.relative(workDir, path.join(siteDir, 'node_modules/astro/bin/astro.mjs'));
  const rootArgs = ['--root', path.relative(workDir, siteDir)];
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: freePort } = probe.address();
      probe.close(() => resolve(freePort));
    });
  });
  const dev = spawn('node', [astroBin, 'dev', ...rootArgs, '--port', String(port), '--host', '127.0.0.1', '--ignore-lock'], {
    cwd: workDir,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let devOutput = '';
  dev.stdout.on('data', (chunk) => (devOutput += chunk));
  dev.stderr.on('data', (chunk) => (devOutput += chunk));
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    browser = await launchChromium(chromium);
    await check('in astro dev (the preview) the script loads and the video plays', async () => {
      const tab = await browser.newPage();
      await tab.goto(`http://127.0.0.1:${port}/`);
      await tab.waitForFunction(() => {
        const video = document.querySelector('#loop');
        return video && !video.paused && video.currentTime > 0.2;
      }, null, { timeout: 15000 }).catch((error) => { throw new Error(`${error.message}\n${devOutput.slice(-2000)}`); });
      assert.strictEqual(await tab.evaluate(() => document.querySelector('#loop').closest('[data-cms-video]').querySelector('[data-cms-video-toggle]').hidden), false);
      await tab.close();
    });
    await check('in astro dev from another directory, a video and poster uploaded after start are found in the site\'s public/', async () => {
      writeSiteFile('public/images/late.webm', fs.readFileSync(path.join(fixtures, 'clip.webm')));
      writeSiteFile('public/images/late-still.png', await sharp({
        create: { width: 64, height: 36, channels: 3, background: { r: 200, g: 40, b: 40 } },
      }).png().toBuffer());
      const lateHtml = await (await fetch(`http://127.0.0.1:${port}/late`)).text();
      assert.match(lateHtml, /<source src="\/images\/late\.webm" type="video\/webm"/, `${lateHtml.slice(0, 1500)}\n${devOutput.slice(-2000)}`);
      assert.match(lateHtml, /poster="\/images\/late-still\.png"/, lateHtml.slice(0, 1500));
      assert.doesNotMatch(devOutput, /names a local file/, 'no missing-file error');
    });
    await browser.close();
    browser = undefined;
  } finally {
    dev.kill();
    spawnSync('node', [astroBin, 'dev', 'stop', ...rootArgs], { cwd: workDir, encoding: 'utf8' });
  }

  console.log(`\n${passed} passed`);
} finally {
  await browser?.close();
  server?.stop(true);
  fs.rmSync(workDir, { recursive: true, force: true });
}
