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
 *   build naming the value, and so does a missing poster.
 *
 * Then the built page in Chromium (Playwright, an existing headless shell;
 * set CHROMIUM_PATH to choose one): the video plays by itself, the button
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
import { spawnSync } from 'child_process';
import sharp from 'sharp';
import { chromium } from 'playwright-core';

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

/** A Chromium Playwright can drive: CHROMIUM_PATH, else a downloaded headless shell. */
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const shells = fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const shell of shells) {
    const candidate = path.join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined; // Playwright's own default
}

/** A static server for dist/, with Range support (Bun.file responses). */
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
      return new Response(Bun.file(filePath));
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
  await check('a /images/ poster is an optimised WebP no wider than posterWidth; an external one is untouched', () => {
    const poster = hero.match(/poster="([^"]+)"/)?.[1];
    assert.ok(poster && /^\/_astro\/.*\.webp$/.test(poster), `poster: ${poster}`);
    const posterFile = path.join(siteDir, 'dist', poster);
    const width = spawnSync('node', ['-e', `require('sharp')(${JSON.stringify(posterFile)}).metadata().then(m => console.log(m.width))`], { cwd: siteDir, encoding: 'utf8' }).stdout.trim();
    assert.strictEqual(Number(width), 1920, `poster width ${width}`);
    assert.match(videos.find((tag) => tag.includes('id="loop"')), /poster="https:\/\/example\.com\/still\.jpg"/);
  });

  // --- the browser ------------------------------------------------------
  server = serveDist();
  browser = await chromium.launch({ executablePath: chromiumPath() });
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
  await browser.close();
  browser = undefined;
  server.stop(true);
  server = undefined;

  // --- missing files fail the build -------------------------------------
  for (const [what, body, value] of [
    ['video', '<CmsVideo src="/images/gone.mp4" />', '/images/gone.mp4'],
    ['video (case differs)', '<CmsVideo src="/images/Hero.mp4" />', '/images/Hero.mp4'],
    ['poster', '<CmsVideo src="/images/hero.mp4" poster="/images/gone.png" />', '/images/gone.png'],
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
  });

  console.log(`\n${passed} passed`);
} finally {
  await browser?.close();
  server?.stop(true);
  fs.rmSync(workDir, { recursive: true, force: true });
}
