/**
 * The Chromium the browser tests drive with playwright-core: CHROMIUM_PATH
 * when it is set, else a headless shell Playwright has downloaded (into
 * PLAYWRIGHT_BROWSERS_PATH, or ~/Library/Caches/ms-playwright on macOS,
 * ~/.cache/ms-playwright on Linux): the revision this playwright-core pins in
 * its browsers.json when that one is there, else the newest. Undefined when
 * there is none (Playwright's own default, which then fails to launch unless
 * its pinned revision is downloaded). A helper, not a test: run-unit does not
 * run it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** How to get a headless shell, for a test that cannot launch one. */
export const INSTALL_CHROMIUM_HINT = 'No Chromium for the browser checks: run `npx playwright-core install chromium-headless-shell` '
  + '(into Playwright\'s cache), or set CHROMIUM_PATH to a Chromium or chrome-headless-shell executable.';

function browsersCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Caches/ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

/** The executable inside a chromium_headless_shell-<revision> folder, per platform. */
function shellExecutables() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? ['chrome-headless-shell-mac-arm64/chrome-headless-shell']
      : ['chrome-headless-shell-mac-x64/chrome-headless-shell'];
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64'
      ? ['chrome-headless-shell-linux-arm64/chrome-headless-shell', 'chrome-linux/headless_shell']
      : ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell'];
  }
  return [];
}

/** The headless-shell revision this playwright-core was built for, or null. */
function pinnedRevision() {
  try {
    // Not in the package's exports: read it beside package.json.
    const packageDir = path.dirname(require.resolve('playwright-core/package.json'));
    const { browsers } = JSON.parse(fs.readFileSync(path.join(packageDir, 'browsers.json'), 'utf-8'));
    return browsers.find((browser) => browser.name === 'chromium-headless-shell')?.revision ?? null;
  } catch {
    return null;
  }
}

export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = browsersCache();
  const revisionOf = (name) => name.split('-').pop();
  const pinned = pinnedRevision();
  const shells = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort((left, right) => {
        if (revisionOf(left) === pinned) return -1;
        if (revisionOf(right) === pinned) return 1;
        return Number(revisionOf(right)) - Number(revisionOf(left));
      })
    : [];
  for (const shell of shells) {
    for (const executable of shellExecutables()) {
      const candidate = path.join(cache, shell, executable);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Launch Chromium for a test, failing with INSTALL_CHROMIUM_HINT (not
 * Playwright's "Executable doesn't exist" for a revision nobody downloaded)
 * when there is none. A test that guards a security property fails rather
 * than skipping its browser checks.
 * @param {import('playwright-core').BrowserType} chromium
 */
export async function launchChromium(chromium) {
  const executablePath = chromiumPath();
  try {
    return await chromium.launch({ executablePath });
  } catch (error) {
    throw new Error(`${INSTALL_CHROMIUM_HINT}\n(${executablePath ? `${executablePath}: ` : ''}${error.message.split('\n')[0]})`);
  }
}
