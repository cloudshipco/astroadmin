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
 * <script>, one level down), and one pnpm-style package: `pnpm-widget` is a
 * link into `node_modules/.pnpm/pnpm-widget@1.0.0/node_modules/`, where its
 * own dependency `pnpm-dep` sits beside it (reachable from nowhere else)
 * and ships a styled component of its own (`Dep.astro`, used by the
 * widget), which the check must mirror too.
 * The check must pass, the built page must carry the components' markup,
 * CSS and script (so the build really used them), and the live packages,
 * the store and node_modules' own entries must be left as they were.
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
const PNPM_COLOUR = 'rgb(44, 55, 66)';
const PNPM_COLOUR_BUILT = '#2c3742';
const PNPM_DEP_MARKER = 'from-the-pnpm-dependency';
const PNPM_DEP_COLOUR = 'rgb(1, 2, 3)';
const PNPM_DEP_COLOUR_BUILT = '#010203';

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/**
 * Every file under a directory with its sha256, and every link with its
 * target, for a before/after comparison. `depth` stops the walk (1: the
 * directory's own entries only).
 */
function treeDigest(dir, { depth = Infinity } = {}) {
  const lines = [];
  const walk = (current, level) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (entry.isSymbolicLink()) lines.push(`${relative} -> ${fs.readlinkSync(full)}`);
      else if (entry.isDirectory()) {
        lines.push(`${relative}/`);
        if (level < depth) walk(full, level + 1);
      } else lines.push(`${relative} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir, 1);
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

  // A pnpm install: the package's real directory is in the virtual store
  // (node_modules/.pnpm, a dot-directory the check does not link), with its
  // own dependency beside it, and node_modules/<name> is a symbolic link.
  const pnpmStore = path.join(siteDir, 'node_modules', '.pnpm');
  const pnpmPackageDir = path.join(pnpmStore, 'pnpm-widget@1.0.0', 'node_modules', 'pnpm-widget');
  writeFile(pnpmPackageDir, 'package.json', JSON.stringify({
    name: 'pnpm-widget', version: '1.0.0', type: 'module',
    exports: { './PnpmWidget.astro': './PnpmWidget.astro' },
  }));
  writeFile(pnpmPackageDir, 'PnpmWidget.astro', `---
import { greeting } from 'pnpm-dep';
import Dep from 'pnpm-dep/Dep.astro';
---
<p class="pnpm-widget">{greeting}</p><Dep />
<style>
  .pnpm-widget { color: ${PNPM_COLOUR}; }
</style>
`);
  const pnpmDepDir = path.join(pnpmStore, 'pnpm-dep@1.0.0', 'node_modules', 'pnpm-dep');
  writeFile(pnpmDepDir, 'package.json', JSON.stringify({ name: 'pnpm-dep', version: '1.0.0', type: 'module', exports: { '.': './index.js', './Dep.astro': './Dep.astro' } }));
  // A styled component in the dependency too: reachable only through the
  // store, never from a top-level link.
  writeFile(pnpmDepDir, 'Dep.astro', `<span class="dep-astro">dep</span>\n<style>.dep-astro { color: ${PNPM_DEP_COLOUR}; }</style>\n`);
  writeFile(pnpmDepDir, 'index.js', `export const greeting = '${PNPM_DEP_MARKER}';\n`);
  // As pnpm links them: relative links, the dependency reachable only from beside the package.
  fs.symlinkSync('../../pnpm-dep@1.0.0/node_modules/pnpm-dep', path.join(pnpmStore, 'pnpm-widget@1.0.0', 'node_modules', 'pnpm-dep'));
  fs.symlinkSync('.pnpm/pnpm-widget@1.0.0/node_modules/pnpm-widget', path.join(siteDir, 'node_modules', 'pnpm-widget'));

  writeFile(siteDir, 'package.json', JSON.stringify({ type: 'module' }));
  writeFile(siteDir, 'astro.config.mjs', 'export default {};\n');
  writeFile(siteDir, '.gitignore', 'node_modules\n.astro\ndist\n');
  writeFile(siteDir, 'public/images/loop.webm', fs.readFileSync(path.join(repoRoot, 'tests/fixtures/video/clip.webm')));
  writeFile(siteDir, 'src/pages/index.astro', `---
import CmsVideo from 'astroadmin/components/CmsVideo.astro';
import Widget from 'widgets/Widget.astro';
import PnpmWidget from 'pnpm-widget/PnpmWidget.astro';
---
<html><body>
<CmsVideo src="/images/loop.webm" id="loop" />
<Widget label="hello" />
<PnpmWidget />
</body></html>
`);
  git(siteDir, 'init', '-q', '-b', 'main');
  git(siteDir, 'config', 'user.name', 'Test');
  git(siteDir, 'config', 'user.email', 'test@example.com');
  git(siteDir, 'add', '-A');
  git(siteDir, 'commit', '-q', '-m', 'initial');

  const liveStore = path.join(siteDir, 'node_modules', '.astro');
  const livePackages = () => [
    treeDigest(astroadminDir), treeDigest(widgetsDir), treeDigest(pnpmStore),
    treeDigest(path.join(siteDir, 'node_modules'), { depth: 1 }),
    fs.existsSync(liveStore) ? treeDigest(liveStore) : 'no data store',
  ].join('\n');
  const livePackagesBefore = livePackages();

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

  await check('the pnpm-installed component built, with its <style> and its own dependency', () => {
    assert.match(built, new RegExp(`<p class="pnpm-widget[^"]*"[^>]*>${PNPM_DEP_MARKER}</p>`), 'PnpmWidget rendered its dependency');
    const rule = built.match(/\.pnpm-widget\[data-astro-cid-[a-z0-9]+\]\{color:([^}]+)\}/);
    assert.ok(rule, "the PnpmWidget's <style> is in the build");
    assert.strictEqual(rule[1], PNPM_COLOUR_BUILT);
  });

  await check("the pnpm package's own dependency's styled component built (a store package, not linked from the top)", () => {
    assert.match(built, /<span class="dep-astro[^"]*"[^>]*>dep<\/span>/, 'Dep rendered');
    const rule = built.match(/\.dep-astro\[data-astro-cid-[a-z0-9]+\]\{color:([^}]+)\}/);
    assert.ok(rule, "Dep's <style> is in the build");
    assert.strictEqual(rule[1], PNPM_DEP_COLOUR_BUILT);
  });

  await check('the live packages (and the store) are left as they were', () => {
    assert.strictEqual(livePackages(), livePackagesBefore);
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
