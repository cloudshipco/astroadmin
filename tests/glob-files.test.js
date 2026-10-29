/**
 * A glob() collection lists exactly the files Astro's glob loader loads.
 *
 * Astro 7 lists a glob() collection's files with tinyglobby
 * (astro/dist/content/loaders/glob.js: `tinyglobby(pattern, { cwd: base,
 * expandDirectories: false })`), and its watcher matches changed files with
 * picomatch (`isMatch(file, positive, { ignore: negations })`). Our own matcher
 * ignored `!` negations, so `['**' + '/*.md', '!**' + '/_*']` still listed
 * `_draft.md`, and it listed dotfiles and dot-directories (`.drafts/x.md`),
 * which tinyglobby skips. For each pattern below, `findMatchingFiles` must
 * equal Astro's list (restricted to the content extensions), and
 * `matchesAnyPattern` must agree with it file by file.
 *
 * Containment still holds: a symlink to a file or directory outside the
 * collection is never listed (Astro would follow it; the store refuses to read
 * through it), while a symlink to a file inside is.
 *
 *   bun tests/glob-files.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const repoRoot = path.resolve(import.meta.dir, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-glob-files-')));
process.env.ASTROADMIN_PROJECT_ROOT = scratch;

const { findMatchingFiles, matchesAnyPattern, CONTENT_EXTENSIONS } = await import('../server/utils/glob-files.js');

// tinyglobby as Astro resolves it, not whichever copy we might depend on.
const astroRequire = createRequire(path.join(repoRoot, 'node_modules/astro/package.json'));
const { glob: astroGlob } = await import(astroRequire.resolve('tinyglobby'));

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

const base = path.join(scratch, 'site/src/content/pages');
const outside = path.join(scratch, 'outside');
const files = [
  'a.md', '_draft.md', 'b.mdx', 'c.json', 'notes.txt', '.hidden.md',
  'nested/d.md', 'nested/_e.md', 'nested/.f.md', 'nested/g.json',
  'deep/er/h.md', 'deep/_skip/i.md',
  '.drafts/x.md', '.drafts/nested/y.md',
  '2024/first-post.md', 'fr/home.fr.md',
];
for (const file of files) {
  fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
  fs.writeFileSync(path.join(base, file), `---\ntitle: ${file}\n---\n`);
}
fs.mkdirSync(path.join(outside, 'dir'), { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.md'), 'outside\n');
fs.writeFileSync(path.join(outside, 'dir/leak.md'), 'outside\n');
fs.symlinkSync(path.join(outside, 'secret.md'), path.join(base, 'link-out.md'));
fs.symlinkSync(path.join(outside, 'dir'), path.join(base, 'dir-out'));
fs.symlinkSync(path.join(base, 'a.md'), path.join(base, 'link-in.md'));

const SYMLINKED_OUT = ['link-out.md', 'dir-out/leak.md'];
const isContent = (file) => CONTENT_EXTENSIONS.includes(path.extname(file).toLowerCase());

/** What Astro's glob loader would load, less what we refuse to follow. */
async function astroList(patterns) {
  const listed = await astroGlob(patterns, { cwd: base, expandDirectories: false });
  return listed.filter(isContent).filter((file) => !SYMLINKED_OUT.includes(file)).sort();
}

const PATTERNS = [
  ['**/*.md', '!**/_*'],
  ['**/*.md', '!**/_*/**', '!**/_*'],
  ['[!_]*.md'],
  ['**/[!_]*.md'],
  ['**/*.{md,mdx,json}'],
  ['*.{json,mdx}'],
  ['nested/**/*.md'],
  ['**/*'],
  ['./**/*.md'],
  ['**/*.md', '!nested/**'],
  ['{2024,fr}/*.md'],
  ['**/?.md'],
];

console.log('\n🧪 glob() collection file listing\n' + '='.repeat(40));

for (const patterns of PATTERNS) {
  await check(`${JSON.stringify(patterns)} lists what Astro lists`, async () => {
    const expected = await astroList(patterns);
    assert.ok(expected.length > 0, 'positive control: Astro lists something');
    const actual = await findMatchingFiles(base, patterns);
    assert.deepEqual(actual, expected);
  });

  await check(`${JSON.stringify(patterns)}: matchesAnyPattern agrees file by file`, async () => {
    const expected = new Set(await astroList(patterns));
    const disagreements = files.filter(isContent)
      .filter((file) => matchesAnyPattern(file, patterns) !== expected.has(file.replace(/^\.\//, '')));
    assert.deepEqual(disagreements, []);
  });
}

await check('the symlinks: one inside is listed, ones out are not, though Astro follows them', async () => {
  const astro = await astroGlob(['**/*.md'], { cwd: base, expandDirectories: false });
  assert.ok(SYMLINKED_OUT.every((file) => astro.includes(file)), `control: Astro follows them: ${astro}`);
  const ours = await findMatchingFiles(base, ['**/*.md']);
  assert.ok(ours.includes('link-in.md'), ours.join(', '));
  for (const file of SYMLINKED_OUT) assert.ok(!ours.includes(file), `${file} listed`);
});

await check('a pattern climbing out of the base lists nothing outside it', async () => {
  const ours = await findMatchingFiles(base, ['../../../../outside/**/*.md', '**/a.md']);
  assert.deepEqual(ours, ['a.md']);
});

await check('a missing base directory lists nothing', async () => {
  assert.deepEqual(await findMatchingFiles(path.join(scratch, 'missing'), ['**/*.md']), []);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(process.exitCode || 0);
