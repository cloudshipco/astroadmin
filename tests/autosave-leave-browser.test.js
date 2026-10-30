/**
 * An edit made just before the page goes away is saved (#103), in Chromium
 * (Playwright) against the real dashboard.
 *
 * The dashboard autosaves 1 s after the last input. Leaving the page inside
 * that second used to drop the edit: nothing flushed the debounce on unload.
 * Now beforeunload, pagehide and a hidden tab send the form as it is with a
 * keepalive request. Checked: a reload, a close and a navigation inside the
 * debounce each save the edit; a body over the keepalive cap asks the
 * browser to confirm leaving and, kept on the page, saves the ordinary way; a
 * save still waiting on its preview fetch when a hidden tab sends a newer
 * snapshot never POSTs its older one afterwards (a page restored from the
 * back/forward cache would); and an untouched entry is not rewritten.
 *
 * Runs createServer() in this process against a throwaway site (no git, no
 * Astro preview; the preview URL points at a port nothing serves, and the
 * stale-snapshot check holds its fetch with page.route). CHROMIUM_PATH picks
 * the browser, else a downloaded Playwright headless shell.
 *
 *   bun tests/autosave-leave-browser.test.js     (~10 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';
import { launchChromium } from './chromium-path.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-autosave-leave-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

const PREVIEW_ORIGIN = 'http://127.0.0.1:4997';

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('astroadmin.config.js', `export default { preview: { url: '${PREVIEW_ORIGIN}' } };\n`);
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: z.object({ title: z.string() }),
  }),
};
`);
const ENTRY_FILES = ['reload', 'close', 'navigate', 'large', 'stale', 'untouched'];
for (const slug of ENTRY_FILES) writeProjectFile(`src/content/pages/${slug}.md`, `---\ntitle: Start\n---\nBody.\n`);

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

const entryText = (slug) => fs.readFileSync(path.join(projectRoot, `src/content/pages/${slug}.md`), 'utf8');

/** Poll the file until `predicate` holds. */
async function waitForEntry(slug, predicate, what) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (predicate(entryText(slug))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what}; ${slug}.md is:\n${entryText(slug)}`);
}

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium(chromium);
const context = await browser.newContext();
const pageErrors = [];

async function openEntry(slug) {
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/dashboard/pages/${slug}`);
  await page.locator('[name="title"]').waitFor();
  return page;
}

/** Type a title and return at once, well inside the 1 s debounce. */
async function typeTitle(page, title) {
  const field = page.locator('[name="title"]');
  await field.click();
  await field.fill('');
  await page.keyboard.type(title);
}

try {
  const loginPage = await context.newPage();
  await loginPage.goto(`${base}/login`);
  await loginPage.fill('#username', 'admin');
  await loginPage.fill('#password', 'admin');
  await Promise.all([loginPage.waitForURL(/dashboard/), loginPage.press('#password', 'Enter')]);
  await loginPage.close();

  console.log('\n🧪 an edit made just before leaving the page\n' + '='.repeat(40));

  await check('a reload inside the debounce saves the edit', async () => {
    const page = await openEntry('reload');
    await typeTitle(page, 'Reloaded');
    await page.reload();
    await waitForEntry('reload', (text) => text.includes('title: Reloaded'), 'the edit was lost on reload');
    assert.ok(entryText('reload').includes('Body.'), 'the body survives');
    await page.close();
  });

  await check('closing the tab inside the debounce saves the edit', async () => {
    const page = await openEntry('close');
    await typeTitle(page, 'Closed');
    await page.close({ runBeforeUnload: true });
    await waitForEntry('close', (text) => text.includes('title: Closed'), 'the edit was lost on close');
  });

  await check('navigating to another site inside the debounce saves the edit', async () => {
    const page = await openEntry('navigate');
    await typeTitle(page, 'Navigated');
    await page.goto('about:blank');
    await waitForEntry('navigate', (text) => text.includes('title: Navigated'), 'the edit was lost on navigation');
    await page.close();
  });

  await check('a body over the keepalive cap asks to confirm leaving; staying saves it', async () => {
    const page = await openEntry('large');
    const longBody = 'Long body line.\n'.repeat(5000); // ~80 KB
    await page.locator('#markdown-body').evaluate((textarea, value) => { textarea.value = value; }, longBody);
    await typeTitle(page, 'Large');
    const dialogs = [];
    page.on('dialog', (dialog) => { dialogs.push(dialog.type()); dialog.dismiss(); });
    await page.reload({ timeout: 3000 }).catch(() => { /* dismissed: no navigation */ });
    assert.deepEqual(dialogs, ['beforeunload']);
    await waitForEntry('large', (text) => text.includes('title: Large') && text.includes(longBody.trim()), 'the large edit was not saved after staying');
    await page.close();
  });

  await check('a save waiting on its preview fetch does not POST its older snapshot after a newer one was sent', async () => {
    const page = await openEntry('stale');
    let releasePreview;
    const previewHeld = new Promise((resolve) => { releasePreview = resolve; });
    let previewAsked;
    const previewRequested = new Promise((resolve) => { previewAsked = resolve; });
    await page.route(`${PREVIEW_ORIGIN}/**`, async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.abort();
      previewAsked();
      await previewHeld;
      await route.fulfill({ status: 200, body: 'preview' });
    });
    const posts = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/content/')) posts.push(JSON.parse(request.postData()).data.title);
    });
    await typeTitle(page, 'Older');
    await previewRequested; // the debounced save took its snapshot and waits on the preview
    await typeTitle(page, 'Newer');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForEntry('stale', (text) => text.includes('title: Newer'), 'the hidden tab did not send the edit');
    releasePreview();
    await page.waitForTimeout(1500);
    assert.deepEqual(posts, ['Newer'], 'the older snapshot was POSTed after the newer one');
    assert.ok(entryText('stale').includes('title: Newer'), entryText('stale'));
    await page.close();
  });

  await check('an untouched entry is not rewritten when its page is reloaded', async () => {
    const before = entryText('untouched');
    const page = await openEntry('untouched');
    const posts = [];
    page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.url()); });
    await page.reload();
    await page.locator('[name="title"]').waitFor();
    await page.waitForTimeout(500);
    assert.deepEqual(posts, []);
    assert.equal(entryText('untouched'), before);
    await page.close();
  });

  await check('no page errors', async () => {
    assert.deepEqual(pageErrors, []);
  });
} finally {
  await browser.close();
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
