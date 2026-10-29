/**
 * The publish check builds a site whose installed packages ship .astro
 * components with a <style> or a bundled <script> (#89).
 *
 * The check's worktree gets a node_modules of links to the live checkout's
 * packages. Vite resolves a module through a link to its REAL path, so a
 * package's component is compiled as `<checkout>/node_modules/pkg/X.astro`,
 * outside the check's root. Astro keys the component's compile metadata by
 * that id, but looks it up for the component's style and script sub-modules
 * (`X.astro?astro&type=style...`) through normalizeFilename, which treats an
 * absolute path sharing no ancestor directory with the root as root-relative
 * and joins it onto the root. The lookup misses and the build fails with
 * "No cached compile metadata found". A checkout that happens to share a top
 * directory with the temp directory (on macOS, a checkout under /tmp and
 * TMPDIR under /var both live in /private) builds, which hid it.
 *
 * The layout here makes the shared ancestor impossible: the site lives in
 * the system temp directory and the check's temp directory (TMPDIR) under
 * this checkout's node_modules/.cache, so their first path segments differ
 * (asserted). The site's node_modules links this checkout's packages (astro
 * among them) and holds two REAL package directories, as an install does:
 * `astroadmin` (this checkout's package.json and components/, so the real
 * CmsVideo) and `widgets` (a component with a <style> and a bundled
 * <script>, one level down). The check must pass, the built page must carry
 * both components' markup, CSS and script (so the build really used them),
 * and the live packages must be left byte for byte as they were.
 *
 *   bun tests/check-linked-styles.test.js     (~2 s)
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linkNodeModules } from './link-node-modules.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-check-linked-styles-')));
const siteDir = path.join(workDir, 'site');
const cacheParent = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheParent, { recursive: true });
const checkTmpDir = fs.realpathSync(fs.mkdtempSync(path.join(cacheParent, 'aa-check-linked-styles-')));

const firstSegment = (target) => target.split(path.sep).filter(Boolean)[0];
const WIDGET_COLOUR = 'rgb(11, 22, 33)';
const WIDGET_COLOUR_BUILT = '#0b1621'; // the same colour, as the build minifies it
const WIDGET_SCRIPT_MARKER = 'widget-script-ran';

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/** Every file under a directory with its sha256, for a before/after comparison. */
function treeDigest(dir) {
  const lines = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else lines.push(`${path.relative(dir, full)} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir);
  return lines.join('\n');
}

/** Every file in a built site, concatenated (HTML, CSS and JS alike). */
function readBuilt(distDir) {
  const parts = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|css|js)$/.test(entry.name)) parts.push(fs.readFileSync(full, 'utf-8'));
    }
  };
  walk(distDir);
  return parts.join('\n');
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

try {
  // The layout precondition: nothing above both but the filesystem root.
  assert.notStrictEqual(firstSegment(siteDir), firstSegment(checkTmpDir),
    `the site (${siteDir}) and the check's temp directory (${checkTmpDir}) share a top directory, so this test could not fail; run it from a checkout outside ${path.sep}${firstSegment(siteDir)}`);

  // --- The site: links to this checkout's packages, plus two real packages ---
  linkNodeModules(repoRoot, siteDir, { skip: ['astroadmin', 'widgets'] });
  const astroadminDir = path.join(siteDir, 'node_modules', 'astroadmin');
  fs.mkdirSync(astroadminDir);
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(astroadminDir, 'package.json'));
  fs.cpSync(path.join(repoRoot, 'components'), path.join(astroadminDir, 'components'), { recursive: true });
  const widgetsDir = path.join(siteDir, 'node_modules', 'widgets');
  writeFile(widgetsDir, 'package.json', JSON.stringify({
    name: 'widgets', version: '1.0.0', type: 'module',
    exports: { './Widget.astro': './src/parts/Widget.astro' },
  }));
  writeFile(widgetsDir, 'src/parts/Widget.astro', `---
const { label } = Astro.props;
---
<p class="widget">{label}</p>
<style>
  .widget { color: ${WIDGET_COLOUR}; }
</style>
<script>
  document.querySelector('.widget')?.setAttribute('data-state', '${WIDGET_SCRIPT_MARKER}');
</script>
`);
  writeFile(widgetsDir, 'src/parts/notes.txt', 'not a component\n');

  writeFile(siteDir, 'package.json', JSON.stringify({ type: 'module' }));
  writeFile(siteDir, 'astro.config.mjs', 'export default {};\n');
  writeFile(siteDir, '.gitignore', 'node_modules\n.astro\ndist\n');
  writeFile(siteDir, 'public/images/loop.webm', fs.readFileSync(path.join(repoRoot, 'tests/fixtures/video/clip.webm')));
  writeFile(siteDir, 'src/pages/index.astro', `---
import CmsVideo from 'astroadmin/components/CmsVideo.astro';
import Widget from 'widgets/Widget.astro';
---
<html><body>
<CmsVideo src="/images/loop.webm" id="loop" />
<Widget label="hello" />
</body></html>
`);
  git(siteDir, 'init', '-q', '-b', 'main');
  git(siteDir, 'config', 'user.name', 'Test');
  git(siteDir, 'config', 'user.email', 'test@example.com');
  git(siteDir, 'add', '-A');
  git(siteDir, 'commit', '-q', '-m', 'initial');

  const livePackagesBefore = `${treeDigest(astroadminDir)}\n${treeDigest(widgetsDir)}`;

  process.env.ASTROADMIN_PROJECT_ROOT = siteDir;
  process.env.TMPDIR = checkTmpDir;
  assert.strictEqual(fs.realpathSync(os.tmpdir()), checkTmpDir, 'os.tmpdir() follows TMPDIR');
  const { checkHeadWithAstro } = await import('../server/utils/astro-check.js');

  let built = '';
  const result = await checkHeadWithAstro(
    { paths: { projectRoot: siteDir }, build: {} },
    { onBuilt: async ({ siteDir: checkSiteDir }) => { built = readBuilt(path.join(checkSiteDir, 'dist')); } },
  );

  await check('the check builds a site whose packages ship components with <style> and <script>', () => {
    assert.strictEqual(result.success, true, `the check failed:\n${String(result.rawOutput).slice(-3000)}`);
  });

  await check('the build used both components (markup, CSS and script)', () => {
    assert.match(built, /<video[^>]*id="loop"/, 'CmsVideo rendered');
    assert.match(built, /\/images\/loop\.webm/, 'CmsVideo source');
    assert.match(built, /<p class="widget[^"]*"[^>]*>hello<\/p>/, 'Widget rendered');
    const widgetRule = built.match(/\.widget\[data-astro-cid-[a-z0-9]+\]\{color:([^}]+)\}/);
    assert.ok(widgetRule, `the Widget's <style> is in the build: ${built.match(/\.widget[^{]*\{[^}]*\}/)}`);
    assert.strictEqual(widgetRule[1], WIDGET_COLOUR_BUILT);
    assert.ok(built.includes(WIDGET_SCRIPT_MARKER), "the Widget's <script> is in the build");
  });

  await check('the live packages are left as they were', () => {
    assert.strictEqual(`${treeDigest(astroadminDir)}\n${treeDigest(widgetsDir)}`, livePackagesBefore);
  });

  await check("the check's temp directory is removed", () => {
    assert.deepStrictEqual(fs.readdirSync(checkTmpDir), []);
  });

  console.log(`\n✅ check-linked-styles: ${passed} passed`);
} catch (error) {
  console.error(error);
  console.error(`\n❌ check-linked-styles: failed after ${passed} passed`);
  process.exitCode = 1;
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(checkTmpDir, { recursive: true, force: true });
}
