/**
 * The sign-in pages in real Chromium (playwright-core, an existing headless
 * shell; CHROMIUM_PATH overrides), against the in-process createServer() app.
 * These are the checks the old Playwright e2e suite (tests/e2e, which could
 * not run: #77) made, kept where they run: `/` and a signed-out dashboard go
 * to /login, a wrong password shows an error and stays there, the right one
 * opens the dashboard, and /login when signed in goes to the dashboard.
 *
 *   bun tests/login-browser.test.js     (~3 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';
import { launchChromium } from './chromium-path.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-login-browser-')));
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
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\n---\n');

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

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium(chromium);
const page = await browser.newPage();
const pathname = () => new URL(page.url()).pathname;

/** Is the element visible and the one a click at its centre would reach? */
async function reachable(selector) {
  return page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return hit === element || element.contains(hit);
  });
}

console.log('\n🧪 the sign-in pages\n' + '='.repeat(40));

try {
  await check('/ with no session goes to /login, whose form can be used', async () => {
    await page.goto(`${base}/`);
    await page.waitForURL(/\/login$/);
    for (const selector of ['#username', '#password', 'button[type="submit"]']) {
      assert.ok(await reachable(selector), `${selector} is not reachable`);
    }
  });

  await check('a signed-out /dashboard goes to /login', async () => {
    await page.goto(`${base}/dashboard`);
    await page.waitForURL(/\/login$/);
  });

  await check('a wrong password shows the error and stays on /login', async () => {
    await page.goto(`${base}/login`);
    await page.fill('#username', 'admin');
    await page.fill('#password', 'wrong');
    await page.click('button[type="submit"]');
    const error = page.locator('.error-message');
    await error.waitFor({ state: 'visible' });
    assert.match(await error.textContent(), /invalid/i);
    assert.equal(pathname(), '/login');
  });

  await check('the right password opens the dashboard', async () => {
    await page.fill('#password', 'admin');
    await Promise.all([page.waitForURL(/\/dashboard$/), page.click('button[type="submit"]')]);
  });

  await check('/login when signed in goes to the dashboard', async () => {
    await page.goto(`${base}/login`);
    await page.waitForURL(/\/dashboard$/);
    assert.equal(pathname(), '/dashboard');
    // Let the dashboard's own requests finish before the site is removed.
    await page.waitForLoadState('networkidle');
  });
} finally {
  await browser.close();
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
