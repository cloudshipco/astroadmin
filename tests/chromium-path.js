/**
 * The Chromium the browser tests drive with playwright-core: CHROMIUM_PATH
 * when it is set, else the newest headless shell Playwright has downloaded on
 * this Mac (~/Library/Caches/ms-playwright), else undefined (Playwright's own
 * default). A helper, not a test: run-unit does not run it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const shells = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort((left, right) => Number(right.split('-').pop()) - Number(left.split('-').pop()))
    : [];
  for (const shell of shells) {
    const candidate = path.join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
