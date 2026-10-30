/**
 * The video picker in the real dashboard, in Chromium (Playwright).
 *
 * happy-dom proves the renderer; this proves the wiring around it: a
 * `heroVideo` field shows the video picker; its library lists only videos
 * (as <video> thumbnails) while an image field's lists only images; choosing
 * a video autosaves `/images/<file>` to disk; "Upload New" sends a WebM
 * through the real upload route and saves it; an oversized file is refused in
 * the browser before any request; and an untouched entry is never rewritten.
 *
 * Runs createServer() in this process against a throwaway site (no git, no
 * Astro preview). CHROMIUM_PATH picks the browser, else a downloaded
 * Playwright headless shell.
 *
 *   bun tests/video-picker-browser.test.js     (~10 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';
import { launchChromium } from './chromium-path.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const fixtures = path.join(repoRoot, 'tests/fixtures/video');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-video-picker-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: z.object({ title: z.string(), heroVideo: z.string().optional(), heroImage: z.string().optional() }),
  }),
};
`);
const HOME_FILE = 'src/content/pages/home.md';
const HOME_TEXT = '---\ntitle: Home\nheroImage: /images/still.png\n---\n';
writeProjectFile(HOME_FILE, HOME_TEXT);
writeProjectFile('public/images/still.png', Buffer.from('89504e470d0a1a0a', 'hex'));
writeProjectFile('public/images/waves.webm', fs.readFileSync(path.join(fixtures, 'clip.webm')));

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

const homeText = () => fs.readFileSync(path.join(projectRoot, HOME_FILE), 'utf8');

/** Poll the file until `predicate` holds (saves are debounced). */
async function waitForFile(predicate, what) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate(homeText())) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what}; the file is:\n${homeText()}`);
}

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium(chromium);
const page = await browser.newPage();
const uploads = [];
page.on('request', (request) => {
  if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/images') uploads.push(request.url());
});
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await Promise.all([page.waitForURL(/dashboard/), page.press('#password', 'Enter')]);
  await page.goto(`${base}/dashboard/pages/home`);
  const videoPicker = page.locator('.image-picker[data-field="heroVideo"]');
  const imagePicker = page.locator('.image-picker[data-field="heroImage"]');
  await videoPicker.waitFor();

  console.log('\n🧪 the video picker in the dashboard\n' + '='.repeat(40));

  await check('heroVideo is the video picker; opening the entry rewrites nothing', async () => {
    assert.equal(await videoPicker.getAttribute('data-video'), '');
    assert.equal(await imagePicker.getAttribute('data-video'), null);
    await page.waitForTimeout(1500); // longer than the autosave debounce
    assert.equal(homeText(), HOME_TEXT);
  });

  const modal = page.locator('#imageLibraryModal');
  await check("the video picker's library lists only videos, as <video> thumbnails", async () => {
    await videoPicker.locator('[data-browse]').click();
    await modal.locator('.image-library-item').first().waitFor();
    assert.equal(await modal.locator('.image-modal-title').textContent(), 'Video Library');
    const urls = await modal.locator('.image-library-item').evaluateAll((items) => items.map((item) => item.dataset.url));
    assert.deepEqual(urls, ['/images/waves.webm']);
    assert.equal(await modal.locator('.image-library-item video').count(), 1);
    assert.equal(await modal.locator('.image-library-item img').count(), 0);
    // The thumbnail starts with preload="none" and is loaded once in view: it
    // must actually reach its first frame's metadata.
    await page.waitForFunction(() => document.querySelector('#imageLibraryModal .image-library-item video')?.readyState >= 1, null, { timeout: 5000 });
    assert.equal(await modal.locator('[data-file-input]').getAttribute('accept'), 'video/mp4,video/webm,.mp4,.webm');
  });

  await check('choosing a video saves its /images/ path to disk', async () => {
    await modal.locator('.image-library-item').first().click();
    assert.equal(await modal.locator('[data-alt-field]').isHidden(), true, 'no alt text for a video');
    await modal.locator('[data-select]').click();
    await waitForFile((text) => text.includes('heroVideo: /images/waves.webm'), 'heroVideo was not saved');
    assert.ok(homeText().includes('heroImage: /images/still.png'), 'the image field is untouched');
    assert.equal(await videoPicker.locator('video[data-preview-img]').getAttribute('src'), '/images/waves.webm');
  });

  await check("reopened on the field's video, the library has it selected: named, and Select takes it", async () => {
    await videoPicker.locator('[data-browse]').click();
    await modal.locator('.image-library-item.selected').waitFor();
    await page.waitForFunction(() => !document.querySelector('#imageLibraryModal [data-select]').disabled);
    assert.match(await modal.locator('[data-selected-info]').textContent(), /^waves\.webm \(/);
    await modal.locator('[data-cancel]').click();
  });

  await check("the image picker's library (same modal, reopened) lists only images", async () => {
    await imagePicker.locator('[data-browse]').click();
    // The modal is shared: none of the video list may survive into this
    // opening, even before the new list arrives.
    assert.equal(await modal.locator('.image-library-item[data-url$=".webm"]').count(), 0, 'videos shown in the image library');
    await modal.locator('.image-library-item').first().waitFor();
    assert.equal(await modal.locator('.image-modal-title').textContent(), 'Image Library');
    const urls = await modal.locator('.image-library-item').evaluateAll((items) => items.map((item) => item.dataset.url));
    assert.deepEqual(urls, ['/images/still.png']);
    await modal.locator('[data-cancel]').click();
  });

  await check('Upload New sends a WebM and saves the uploaded path', async () => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), videoPicker.locator('[data-upload]').click()]);
    assert.equal(await chooser.element().getAttribute('accept'), 'video/mp4,video/webm,.mp4,.webm');
    await chooser.setFiles(path.join(fixtures, 'clip.webm'));
    await waitForFile((text) => /heroVideo: \/images\/clip-\d+\.webm/.test(text), 'the uploaded video was not saved');
    assert.ok(uploads.at(-1).endsWith('/api/images?kind=video'), `upload URL ${uploads.at(-1)}`);
    const saved = homeText().match(/heroVideo: (\/images\/clip-\d+\.webm)/)[1];
    assert.ok(fs.readFileSync(path.join(projectRoot, 'public', saved)).equals(fs.readFileSync(path.join(fixtures, 'clip.webm'))));
  });

  await check('a video over 20MB is refused in the browser, before any upload request', async () => {
    const oversized = path.join(projectRoot, 'big.mp4');
    fs.writeFileSync(oversized, Buffer.alloc(20 * 1024 * 1024 + 1));
    const uploadsBefore = uploads.length;
    const textBefore = homeText();
    const dialog = page.waitForEvent('dialog').then(async (shown) => {
      const message = shown.message();
      await shown.dismiss();
      return message;
    });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), videoPicker.locator('[data-upload]').click()]);
    await chooser.setFiles(oversized);
    assert.equal(await dialog, 'Upload failed: Videos must be under 20MB; export at 720p, about 20 seconds');
    assert.equal(uploads.length, uploadsBefore, 'no upload request was sent');
    assert.equal(homeText(), textBefore);
    assert.ok(uploadsBefore > 0, 'positive control: the earlier upload was seen');
  });

  await check('an image chosen in the video picker is refused in the browser (accept is only a hint)', async () => {
    const stillPath = path.join(projectRoot, 'other.png');
    fs.writeFileSync(stillPath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const uploadsBefore = uploads.length;
    const textBefore = homeText();
    const dialog = page.waitForEvent('dialog').then(async (shown) => {
      const message = shown.message();
      await shown.dismiss();
      return message;
    });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), videoPicker.locator('[data-upload]').click()]);
    await chooser.setFiles(stillPath);
    assert.equal(await dialog, 'Upload failed: This field takes a video (MP4 or WebM)');
    assert.equal(uploads.length, uploadsBefore, 'no upload request was sent');
    assert.equal(homeText(), textBefore);
  });

  await check('a link typed into the video box saves as typed, with no <video> preview', async () => {
    const box = videoPicker.locator('input[name="heroVideo"]');
    await box.fill('https://www.youtube.com/watch?v=abc');
    await waitForFile((text) => text.includes("heroVideo: 'https://www.youtube.com/watch?v=abc'") || text.includes('heroVideo: https://www.youtube.com/watch?v=abc'), 'the typed link was not saved');
    assert.equal(await videoPicker.locator('[data-preview]').isHidden(), true, 'no player for a link');
    assert.equal(await videoPicker.locator('[data-placeholder]').isVisible(), true);
  });

  await check('a file of the wrong kind dropped on the library says why it is refused', async () => {
    await videoPicker.locator('[data-browse]').click();
    await modal.locator('.image-library-item').first().waitFor();
    const uploadsBefore = uploads.length;
    const dialog = page.waitForEvent('dialog').then(async (shown) => {
      const message = shown.message();
      await shown.dismiss();
      return message;
    });
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'dropped.png', { type: 'image/png' }));
      document.querySelector('#imageLibraryModal [data-upload-zone]').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    assert.equal(await dialog, 'Upload failed: This field takes a video (MP4 or WebM)');
    assert.equal(uploads.length, uploadsBefore, 'no upload request was sent');
    await modal.locator('[data-cancel]').click();
  });

  await check('no script errors on the page', () => {
    assert.deepEqual(pageErrors, []);
  });
} finally {
  await browser.close();
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
