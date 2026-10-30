/**
 * An edit made just before the page goes away is saved (#103), in Chromium
 * (Playwright) against the real dashboard.
 *
 * The dashboard autosaves 1 s after the last input. Leaving the page inside
 * that second used to drop the edit: nothing flushed the debounce on unload.
 * Now beforeunload, pagehide and a hidden tab send the form as it is with a
 * keepalive request. Checked: a reload, a close and a navigation inside the
 * debounce each save the edit; a body over the keepalive cap is POSTed
 * before the browser asks to confirm leaving, and staying saves it; a
 * save still waiting on its preview fetch when a hidden tab sends a newer
 * snapshot never POSTs its older one afterwards (a page restored from the
 * back/forward cache would), and later leave events send nothing more; the
 * next save after returning to the tab waits for the leave save, so it lands
 * last; a leave save that fails is saved again the ordinary way; a leave save
 * reports validation ("Saved, needs fixing") and turns a new entry into an
 * ordinary one (title, picker, Delete), as an autosave does; and an untouched
 * entry is not rewritten.
 *
 * Runs createServer() in this process against a throwaway site (no git, no
 * Astro preview; the preview URL points at a port nothing serves, and the
 * stale-snapshot check holds its fetch with page.route). CHROMIUM_PATH picks
 * the browser, else a downloaded Playwright headless shell.
 *
 *   bun tests/autosave-leave-browser.test.js     (~20 s)
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
    schema: z.object({ title: z.string().min(1) }),
  }),
};
`);
const ENTRY_FILES = ['reload', 'close', 'navigate', 'large', 'stale', 'retry', 'invalid', 'order', 'untouched'];
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

const entryText = (slug) => { try { return fs.readFileSync(path.join(projectRoot, `src/content/pages/${slug}.md`), "utf8"); } catch { return ""; } };

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

/** Make the page believe its tab was hidden, as switching tabs does. */
const hideTab = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});

/** Record the title of every entry POST the page sends. */
function recordPosts(page) {
  const posts = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/content/')) posts.push(JSON.parse(request.postData()).data.title);
  });
  return posts;
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
    const posts = recordPosts(page);
    const dialogs = [];
    page.on('dialog', (dialog) => { dialogs.push([dialog.type(), posts.length]); dialog.dismiss(); });
    await page.reload({ timeout: 3000 }).catch(() => { /* dismissed: no navigation */ });
    // The POST is already out when the browser asks (no preview fetch first),
    // so leaving at the prompt does not drop it unsent.
    assert.deepEqual(dialogs, [['beforeunload', 1]]);
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
    const posts = recordPosts(page);
    await typeTitle(page, 'Older');
    await previewRequested; // the debounced save took its snapshot and waits on the preview
    await typeTitle(page, 'Newer');
    await hideTab(page);
    // Every leave event after the first finds nothing unsent.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForEntry('stale', (text) => text.includes('title: Newer'), 'the hidden tab did not send the edit');
    releasePreview();
    await page.waitForTimeout(1500);
    assert.deepEqual(posts, ['Newer'], 'the older snapshot was POSTed after the newer one');
    assert.ok(entryText('stale').includes('title: Newer'), entryText('stale'));
    await page.close();
  });

  await check('a save sent from a hidden tab that fails is saved again the ordinary way', async () => {
    const page = await openEntry('retry');
    let refused = 0;
    await page.route('**/api/content/pages/retry', async (route) => {
      if (route.request().method() === 'POST' && refused === 0) {
        refused++;
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Internal server error"}' });
      }
      return route.continue();
    });
    const posts = recordPosts(page);
    await typeTitle(page, 'Retried');
    await hideTab(page);
    await waitForEntry('retry', (text) => text.includes('title: Retried'), 'the failed save was not retried');
    assert.equal(refused, 1);
    assert.deepEqual(posts, ['Retried', 'Retried']);
    await page.close();
  });

  await check('the next save after returning to the tab waits for the one sent on leaving, so it lands last', async () => {
    const page = await openEntry('order');
    let held = 0;
    await page.route('**/api/content/pages/order', async (route) => {
      if (route.request().method() === 'POST' && held === 0) {
        held++;
        await new Promise((resolve) => setTimeout(resolve, 2500)); // the leave save is slow to arrive
      }
      return route.continue();
    });
    const posts = recordPosts(page);
    await typeTitle(page, 'Hidden');
    await hideTab(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await typeTitle(page, 'Back');
    await waitForEntry('order', (text) => text.includes('title: Back'), 'the save after returning was not written');
    await page.waitForTimeout(3000); // past the held save's release
    assert.ok(entryText('order').includes('title: Back'), `the leave save landed last:\n${entryText('order')}`);
    assert.deepEqual(posts, ['Hidden', 'Back']);
    await page.close();
  });

  await check('a save sent from a hidden tab reports what an autosave reports: needs fixing', async () => {
    const page = await openEntry('invalid');
    await typeTitle(page, '');
    await page.keyboard.press('Backspace'); // an input event with the box empty
    await hideTab(page);
    await waitForEntry('invalid', (text) => text.includes("title: ''") || /title: *\n/.test(text) || !text.includes('title:'), 'the empty title was not saved');
    await page.waitForFunction(() => document.getElementById('saveStatus').textContent === 'Saved, needs fixing', null, { timeout: 5000 });
    await page.close();
  });

  await check('a new entry saved from a hidden tab becomes an ordinary entry: title, picker, Delete', async () => {
    const page = await openEntry('reload');
    await page.evaluate(() => {
      const select = document.getElementById('pageSelector');
      const option = document.createElement('option');
      option.value = 'new:pages';
      select.append(option);
      select.value = 'new:pages';
      select.dispatchEvent(new Event('change'));
    });
    await page.fill('#newItemSlug', 'fresh');
    await page.locator('#newItemCreateBtn').click();
    await page.waitForFunction(() => document.getElementById('editorTitle').textContent === 'New: fresh');
    assert.equal(await page.locator('#deleteEntryBtn').isVisible(), false);
    await typeTitle(page, 'Fresh');
    await hideTab(page);
    await waitForEntry('fresh', (text) => text.includes('title: Fresh'), 'the new entry was not created');
    await page.waitForFunction(() => document.getElementById('editorTitle').textContent.startsWith('Editing: '), null, { timeout: 5000 });
    assert.equal(await page.locator('#deleteEntryBtn').isVisible(), true, 'Delete is offered');
    assert.equal(await page.locator('#pageSelector option[value="pages/fresh"]').count(), 1, 'the picker lists it');
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
