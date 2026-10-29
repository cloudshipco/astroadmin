/**
 * The dashboard header and the markdown body toolbar, laid out in Chromium
 * (Playwright) at phone, tablet and desktop widths.
 *
 * Measured, not screenshotted. At each width:
 *  - the page has no horizontal scroll (scrollWidth <= innerWidth);
 *  - every header control (entry picker, View live site, Publish, Changes,
 *    Logout) is inside the viewport and `elementFromPoint` at its centre is
 *    the control itself or a descendant. The dashboard clips its own overflow
 *    (`overflow: hidden`), so the scroll check alone passes while Publish is
 *    cut off: the hit test is the check that catches it. The same holds with
 *    the longest save status showing, and that text moves no button;
 *  - the Changes panel opens inside the viewport with its close button on top;
 *  - on a touch screen (the 360/390/768 contexts emulate one) each header
 *    control and toolbar button is at least 40px in both directions;
 *  - every toolbar button and the expand button beside it is hit-testable and
 *    no two of their boxes intersect (the expand button used to sit on top
 *    of the toolbar's first row, covering the link button).
 *
 * Runs createServer() in this process against a throwaway site (no git, no
 * Astro preview). CHROMIUM_PATH picks the browser, else a downloaded
 * Playwright headless shell. LAYOUT_SCREENSHOTS=<dir> saves a screenshot per
 * width there.
 *
 *   bun tests/dashboard-layout-browser.test.js     (~4 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { chromium } from 'playwright-core';
import { chromiumPath } from './chromium-path.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-dashboard-layout-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
// With a public URL the header also shows "View live site": the widest header.
process.env.PUBLIC_URL = 'https://example.com';
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
    schema: z.object({ title: z.string() }),
  }),
};
`);
const ABOUT_FILE = 'src/content/pages/about.md';
const ABOUT_TEXT = '---\ntitle: About us\n---\n\nA paragraph of body text.\n\n## A heading\n\nMore text.\n';
writeProjectFile(ABOUT_FILE, ABOUT_TEXT);
writeProjectFile('.gitignore', 'node_modules\n');
// A git repository with no remote, so the header shows Changes too.
const runGit = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: projectRoot, stdio: 'ignore' });
runGit('init', '-q', '-b', 'main');
runGit('add', '-A');
runGit('commit', '-q', '-m', 'Initial');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.message}`);
    process.exitCode = 1;
  }
}

/**
 * Measure, in the page, each element matching `selectors` (hidden ones are
 * skipped): its box, whether it lies inside the viewport, and whether the
 * topmost element at its centre is it or a descendant.
 */
async function measure(page, selectors) {
  return page.evaluate((selectorList) => {
    const results = [];
    for (const selector of selectorList) {
      for (const element of document.querySelectorAll(selector)) {
        if (element.hidden || element.getClientRects().length === 0) continue;
        const box = element.getBoundingClientRect();
        const centreX = box.left + box.width / 2;
        const centreY = box.top + box.height / 2;
        const inside = box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight;
        const topmost = document.elementFromPoint(centreX, centreY);
        const name = element.id ? `#${element.id}` : (element.dataset.mdAction ?? element.className.split(' ')[0]);
        results.push({
          name,
          box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
          inside,
          hit: topmost !== null && (topmost === element || element.contains(topmost)),
          topmost: topmost ? (topmost.id ? `#${topmost.id}` : topmost.getAttribute('class') || topmost.tagName) : null,
        });
      }
    }
    return results;
  }, selectors);
}

function intersects(first, second) {
  return first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
}

const round = (value) => Math.round(value);
const describe = (control) => `${control.name} [${round(control.box.left)},${round(control.box.top)} ${round(control.box.width)}x${round(control.box.height)}]`;

const HEADER_CONTROLS = ['.entry-picker-button', '#viewLiveBtn', '#publishBtn', '#changesBtn', '#logoutBtn'];
const TOOLBAR_CONTROLS = ['.md-toolbar-btn', '.textarea-expand-btn'];
const MIN_TOUCH_TARGET = 40;

const WIDTHS = [
  { width: 360, height: 780, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 768, height: 1024, touch: true },
  { width: 1024, height: 768, touch: false },
  { width: 1280, height: 800, touch: false },
];

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: chromiumPath() });
const pageErrors = [];
const screenshotDirectory = process.env.LAYOUT_SCREENSHOTS;

try {
  console.log('\n🧪 dashboard header and markdown toolbar layout\n' + '='.repeat(48));
  for (const { width, height, touch } of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch && width < 768 });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${base}/login`);
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin');
    await Promise.all([page.waitForURL(/dashboard/), page.press('#password', 'Enter')]);
    await page.goto(`${base}/dashboard/pages/about`);
    await page.locator('.md-toolbar').waitFor();
    await page.locator('#viewLiveBtn:not([hidden])').waitFor();
    await page.locator('.md-toolbar').evaluate((toolbar) => toolbar.scrollIntoView({ block: 'center' }));

    const scroll = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    const header = await measure(page, HEADER_CONTROLS);
    const toolbar = await measure(page, TOOLBAR_CONTROLS);
    if (screenshotDirectory) {
      fs.mkdirSync(screenshotDirectory, { recursive: true });
      await page.screenshot({ path: path.join(screenshotDirectory, `dashboard-${width}.png`) });
    }
    console.log(`\n${width}px: scrollWidth ${scroll.scrollWidth} / innerWidth ${scroll.innerWidth}`);
    console.log(`  header:  ${header.map((control) => `${describe(control)}${control.inside ? '' : ' OUTSIDE'}${control.hit ? '' : ` COVERED by ${control.topmost}`}`).join('; ')}`);
    console.log(`  toolbar: ${toolbar.map((control) => `${describe(control)}${control.hit ? '' : ` COVERED by ${control.topmost}`}`).join('; ')}`);

    await check(`${width}px: no horizontal page scroll`, () => {
      assert.ok(scroll.scrollWidth <= scroll.innerWidth, `scrollWidth ${scroll.scrollWidth} > innerWidth ${scroll.innerWidth}`);
    });

    await check(`${width}px: every header control is in the viewport and on top at its centre`, () => {
      assert.equal(header.length, HEADER_CONTROLS.length, `found ${header.map((control) => control.name).join(', ')}`);
      const unreachable = header.filter((control) => !control.inside || !control.hit);
      assert.deepEqual(unreachable.map(describe), []);
    });

    // The save status changes on every autosave; its longest message must not
    // move, cover or push out any header control.
    await page.evaluate(() => { document.getElementById('saveStatus').textContent = 'New translation - unsaved'; });
    const headerWithStatus = await measure(page, HEADER_CONTROLS);
    const statusBox = await page.locator('#saveStatus').boundingBox();
    await page.evaluate(() => { document.getElementById('saveStatus').textContent = ''; });
    await check(`${width}px: a long save status moves no header control`, () => {
      assert.ok(statusBox.width > 0 && statusBox.x >= 0 && statusBox.x + statusBox.width <= width, `status box ${JSON.stringify(statusBox)}`);
      const buttons = (controls) => controls.filter((control) => control.name.startsWith('#')).map(describe);
      assert.deepEqual(buttons(headerWithStatus), buttons(header));
      assert.deepEqual(headerWithStatus.filter((control) => !control.inside || !control.hit).map(describe), []);
    });

    await check(`${width}px: every toolbar button and the expand button are on top, none overlapping`, () => {
      assert.equal(toolbar.length, 12, `found ${toolbar.length} toolbar controls`);
      const unreachable = toolbar.filter((control) => !control.inside || !control.hit);
      assert.deepEqual(unreachable.map((control) => `${describe(control)} covered by ${control.topmost}`), []);
      const overlaps = [];
      for (let first = 0; first < toolbar.length; first++) {
        for (let second = first + 1; second < toolbar.length; second++) {
          if (intersects(toolbar[first].box, toolbar[second].box)) overlaps.push(`${toolbar[first].name} / ${toolbar[second].name}`);
        }
      }
      assert.deepEqual(overlaps, []);
    });

    // Notices open under the header, whatever its height: a real toast (Cmd/Ctrl+S
    // saves the unchanged form and says so) and the publish-problems panel (shown
    // after a refused publish, so placed here with its own class).
    const headerBottom = await page.locator('.topbar-shopify').evaluate((header) => header.getBoundingClientRect().bottom);
    await page.keyboard.press('Control+s');
    await page.locator('.notification').first().waitFor();
    // One at a time: they share a corner, and the toast is drawn over the panel.
    const notices = await measure(page, ['.notification']);
    await page.evaluate(() => {
      document.querySelectorAll('.notification').forEach((notice) => notice.remove());
      const panel = document.createElement('div');
      panel.className = 'publish-problems-panel';
      panel.textContent = 'This entry has a problem.';
      document.body.appendChild(panel);
    });
    notices.push(...await measure(page, ['.publish-problems-panel']));
    await page.evaluate(() => document.querySelector('.publish-problems-panel').remove());
    await check(`${width}px: a toast and the publish-problems panel open below the header, on top`, () => {
      assert.equal(notices.length, 2, `found ${notices.map((notice) => notice.name).join(', ')}`);
      const misplaced = notices.filter((notice) => notice.box.top < headerBottom || !notice.inside || !notice.hit);
      assert.deepEqual(misplaced.map((notice) => `${describe(notice)} (header ends at ${round(headerBottom)})`), []);
    });

    let closeButton = null;
    await check(`${width}px: the Changes panel opens inside the viewport, its close button on top`, async () => {
      await page.locator('#changesBtn').click();
      await page.locator('.changes-panel [data-close-changes]').waitFor();
      const [panel] = await measure(page, ['.changes-panel']);
      const [close] = await measure(page, ['.changes-panel [data-close-changes]']);
      closeButton = close;
      assert.ok(panel.box.left >= 0 && panel.box.top >= 0 && panel.box.right <= width, `panel ${describe(panel)}`);
      assert.ok(close.inside && close.hit, `close ${describe(close)} covered by ${close.topmost}`);
      await page.locator('.changes-panel [data-close-changes]').click();
    });

    if (touch) {
      await check(`${width}px (touch): header and toolbar targets are at least ${MIN_TOUCH_TARGET}px`, () => {
        assert.ok(closeButton, 'control: the Changes panel close button was measured');
        const small = [...header, ...toolbar, closeButton].filter((control) => control.box.width < MIN_TOUCH_TARGET || control.box.height < MIN_TOUCH_TARGET);
        assert.deepEqual(small.map(describe), []);
      });
    }
    await context.close();
  }

  await check('opening the entry at every width rewrote nothing', () => {
    assert.equal(fs.readFileSync(path.join(projectRoot, ABOUT_FILE), 'utf8'), ABOUT_TEXT);
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
