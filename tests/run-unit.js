/**
 * Runs the fast, server-less tests one after another, each as its own
 * `bun tests/<name>.test.js` process (never `bun test`, which sets
 * NODE_ENV=test for every spawned astro build; see CLAUDE.md), and prints
 * one line per file plus a summary. Exits non-zero if any file fails.
 *
 * `npm test` and `npm run test:unit` both run this.
 *
 * Not listed: the shelved SQLite store (`npm run test:db`), and the slow ones that run full
 * Astro builds or a browser (publish-check, publish-refusal-*, cms-*-packed,
 * component-preview, dev-toolbar, cli-dev, doctor-*, video-picker-browser,
 * dashboard-layout-browser,
 * image-*-astro builds). Run those by name before a release.
 *
 *   bun tests/run-unit.js            every file below
 *   bun tests/run-unit.js git ui     only files whose name contains a word
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));

const FAST_TESTS = [
  'content-files', 'content-round-trip', 'serializer-fidelity', 'save-body',
  'file-entry-id', 'file-entry-keys', 'export-files', 'import-files',
  'form-generator', 'extract-fields', 'untouched-fields', 'untouched-structure',
  'primitive-top-level-array', 'clean-nullable', 'blank-optional-round-trip', 'refused-blanks',
  'date-round-trip', 'gallery-structural', 'modal-escape', 'modal-scroll-lock',
  'ui-escaping',
  'colour-field', 'text-field-sizing', 'nested-array-indexes',
  'schema-markers', 'date-marker', 'stand-in-marks', 'schema-references',
  'schema-refinements', 'route-detection', 'content-validation',
  'content-problems', 'block-reveal', 'changes-panel-renames', 'entry-urls',
  'content-traversal', 'glob-files', 'file-collection-listing', 'live-url', 'live-status', 'preview-live-link',
  'preview-click', 'preview-cache-bust', 'preview-routes',
  'markdown-transforms', 'markdown-body-not-named', 'focus-editor-field',
  'api-basics', 'api-response', 'login-log', 'rate-limit', 'cross-origin', 'auth',
  'error-paths', 'image-serving', 'image-symlink', 'image-picker-astro',
  'video-upload', 'git-api', 'git-subdir', 'git-subdir-routes',
  'git-paths-scope', 'git-paths-commit', 'git-log-limit', 'checkout-lock', 'publish-sync',
  'publish-message', 'publish-api', 'publish-failure', 'publish-live-status',
  'deploy',
  'build-failure', 'build-deploy-responses', 'production-build',
];

const filters = process.argv.slice(2);
const selected = filters.length === 0
  ? FAST_TESTS
  : FAST_TESTS.filter((name) => filters.some((word) => name.includes(word)));

const failures = [];
const started = Date.now();
for (const name of selected) {
  const file = path.join(testsDirectory, `${name}.test.js`);
  const fileStarted = Date.now();
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const seconds = ((Date.now() - fileStarted) / 1000).toFixed(1);
  const passed = run.status === 0;
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name} (${seconds}s)`);
  if (!passed) failures.push({ name, output: `${run.stdout}${run.stderr}` });
}

for (const { name, output } of failures) {
  console.log(`\n--- ${name} ---\n${output.split('\n').slice(-40).join('\n')}`);
}
const totalSeconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n${selected.length - failures.length} of ${selected.length} files passed in ${totalSeconds}s.`);
if (selected.length === 0) {
  console.log('No test file matched; nothing ran.');
  process.exitCode = 1;
} else if (failures.length > 0) {
  process.exitCode = 1;
}
