/**
 * What an editor is told when the site's own Astro refuses a commit, from
 * REAL builds: the publish check (checkHeadWithAstro) on a throwaway site,
 * and the 422 body the publish routes send (checkRefusalBody).
 *
 * The refusal carries no Astro text (it names server paths, and guessing
 * which text is a path could not be made complete). Each case asserts what
 * the editor does get: the sentence for Astro's error code, the refused
 * entry, and AstroAdmin's own validation of that entry at the checked
 * commit (field path, message, accepted values). Each has a positive
 * control: Astro's raw output, naming the check's worktree, is in the
 * server log.
 *
 *   (i)   a zod enum whose values look like server paths ('/home/about')
 *   (ii)  a missing image() file
 *   (iii) an MDX syntax error (needs @astrojs/mdx installed; skipped, and
 *         said so, when it is not)
 *   (iv)  invalid frontmatter YAML
 *   and: a locale file, a nested id, a data entry's invalid JSON, and an
 *   entry fixed in the working tree but not in the commit.
 *
 *   bun tests/publish-refusal-reasons.test.js     (~20 s: one build per case)
 */

import assert from 'assert';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-refusal-reasons-')));
const projectRoot = path.join(scratch, 'site');
fs.mkdirSync(projectRoot);

for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
delete process.env.ASTROADMIN_CONTENT_STORE;

let mdxInstalled = false;
try {
  createRequire(path.join(repoRoot, 'package.json')).resolve('@astrojs/mdx');
  mdxInstalled = true;
} catch {
  // not installed: case (iii) is skipped, loudly
}

const git = (...args) => execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf-8' }).trim();
function writeFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeFile('package.json', JSON.stringify({ type: 'module' }));
writeFile('.gitignore', 'node_modules\n.astro\ndist\n');
writeFile('astro.config.mjs', mdxInstalled
  ? "import mdx from '@astrojs/mdx';\nexport default { integrations: [mdx()] };\n"
  : 'export default {};\n');
writeFile('astroadmin.config.js', "export default { git: { enabled: true, paths: ['src/content/'] }, i18n: { enabled: true, defaultLocale: 'en', locales: ['en', 'fr'] } };\n");
writeFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { file, glob } from 'astro/loaders';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.${mdxInstalled ? '{md,mdx}' : 'md'}', base: './src/content/pages' }),
  schema: z.object({ title: z.string(), link: z.enum(['/home/about', '/home/contact']).optional() }),
});
const covers = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/covers' }),
  schema: ({ image }) => z.object({ cover: image() }),
});
const authors = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/authors' }),
  schema: z.object({ name: z.string() }),
});

const people = defineCollection({
  loader: file('src/data/people.json'),
  schema: z.object({ name: z.string() }),
});

export const collections = { pages, covers, authors, people };
`);
writeFile('src/pages/index.astro', `---
import { getCollection, render } from 'astro:content';
const covers = await getCollection('covers');
const pages = await getCollection('pages');
const rendered = await Promise.all(pages.map((page) => render(page)));
---
<html><body>{covers.map((entry) => <img src={entry.data.cover.src} alt="" />)}{rendered.map(({ Content }) => <Content />)}</body></html>
`);
writeFile('src/content/pages/home.md', '---\ntitle: Home\n---\nHello\n');
writeFile('src/content/authors/ann.json', '{ "name": "Ann" }\n');
writeFile('src/data/people.json', JSON.stringify([{ id: 'Jane Doe', name: 'Jane' }, { id: 'Jane', name: 'Jay' }]));
writeFile('src/content/covers/first.md', '---\ncover: ./first.png\n---\n');
fs.writeFileSync(path.join(projectRoot, 'src/content/covers/first.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==', 'base64'));

execFileSync('git', ['init', '-q', '-b', 'main', projectRoot]);
git('config', 'user.name', 'Test');
git('config', 'user.email', 'test@example.com');
git('add', '-A');
git('commit', '-q', '-m', 'initial');

const { checkHeadWithAstro } = await import('../server/utils/astro-check.js');
const { checkRefusalBody } = await import('../server/api/publish.js');
const { describeRefusedEntries } = await import('../server/utils/build-failure.js');
const { getConfig } = await import('../server/config.js');

// The server log: what the app writes, kept for the positive controls.
const serverLog = [];
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    serverLog.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(' '));
    if (process.env.VERBOSE) original(...args);
  };
}
const report = (line) => process.stdout.write(`${line}\n`);

let passed = 0;
let skipped = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    report(`✅ ${name}`);
  } catch (error) {
    report(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

// What must never reach the body: the server's directories, and Astro's text.
const FORBIDDEN = [scratch, 'aa-refusal-reasons-', 'astroadmin-check-', os.tmpdir(), fs.realpathSync(os.tmpdir()),
  '/private/', '/var/folders/', repoRoot, 'node_modules', 'Stack trace', 'docs.astro.build', 'does not match collection schema',
  'Location', 'js-yaml', 'Expected double-quoted'];
function assertNoServerText(body) {
  const text = JSON.stringify(body);
  for (const sign of FORBIDDEN) assert.equal(text.includes(sign), false, `the 422 body carries "${sign}": ${text}`);
}

/**
 * Commit `files` on a branch from main, run the publish check, and return the
 * 422 body plus what was logged. Positive controls: the check refused, and
 * Astro's own output (naming the check's worktree) reached the server log.
 */
async function refuse(name, files, { logged = [] } = {}) {
  git('checkout', '-q', '-f', '-B', `case-${name}`, 'main');
  for (const [relativePath, content] of Object.entries(files)) writeFile(relativePath, content);
  git('add', '-A');
  git('commit', '-q', '-m', name);
  const mark = serverLog.length;
  const check = await checkHeadWithAstro(await getConfig());
  const log = serverLog.slice(mark).join('\n');
  assert.equal(check.success, false, `positive control: the build refused ${name}`);
  assert.ok(log.includes('astroadmin-check-'), `positive control: the raw output, naming the worktree, is in the server log:\n${log.slice(0, 3000)}`);
  for (const fragment of logged) assert.ok(log.includes(fragment), `positive control: the server log has "${fragment}"`);
  const body = await checkRefusalBody(check, { committed: true });
  assertNoServerText(body);
  return body;
}

/** The entries without their `validation` status, for deepEqual. */
const entriesOf = (body) => body.check.entries.map(({ validation, ...entry }) => entry);

try {
  report('\n🧪 publish refusals from real Astro builds: our sentences, our validation\n' + '='.repeat(40));

  await check("(i) a zod enum of route-like values: the entry, the field and the accepted values, from our validator", async () => {
    const body = await refuse('enum', { 'src/content/pages/about.md': '---\ntitle: About\nlink: /home/elsewhere\n---\n' },
      { logged: ['InvalidContentEntryDataError', '/home/about'] });
    assert.deepEqual(body.check.problems, [{ code: 'InvalidContentEntryDataError', message: "An entry's data does not match its collection's schema." }]);
    const [entry] = entriesOf(body);
    assert.deepEqual({ ...entry, issues: undefined }, { collection: 'pages', slug: 'about', locale: null, editable: true, issues: undefined });
    assert.equal(entry.issues.length, 1, JSON.stringify(entry.issues));
    assert.equal(entry.issues[0].path, 'link');
    assert.deepEqual(entry.issues[0].accepted, ['/home/about', '/home/contact'], 'the accepted values survive whole');
    assert.ok(body.check.output.includes('/home/about'), body.check.output);
    assert.ok(body.check.output.includes('pages/about'), body.check.output);
  });

  await check('(ii) a missing image() file: the sentence, the entry, and its field', async () => {
    const body = await refuse('image', { 'src/content/covers/second.md': '---\ncover: ./missing.png\n---\n' }, { logged: ['ImageNotFound'] });
    assert.deepEqual(body.check.problems, [{ code: 'ImageNotFound', message: 'An image an entry uses was not found in the site.' }]);
    assert.deepEqual(entriesOf(body), [{
      collection: 'covers', slug: 'second', locale: null, editable: true,
      issues: [{ path: 'cover', message: 'The image file ./missing.png was not found.' }],
    }]);
  });

  if (mdxInstalled) {
    await check('(iii) an MDX syntax error: the sentence (the build names no entry)', async () => {
      const body = await refuse('mdx', { 'src/content/pages/broken.mdx': '---\ntitle: Broken\n---\n<div>\n\n{unclosed\n' }, { logged: ['mdx'] });
      assert.deepEqual(body.check.problems.map((problem) => problem.code), ['MdxSyntaxError']);
      assert.match(body.check.problems[0].message, /MDX entry has a syntax error/);
    });
  } else {
    skipped++;
    report('⚠️  SKIPPED (iii) the real MDX build: @astrojs/mdx is not installed in this checkout. '
      + 'tests/build-failure.test.js reads a captured Astro 7 MDX failure instead.');
  }

  await check('(iv) invalid frontmatter YAML: the sentence, the entry, and our parser\'s line', async () => {
    const body = await refuse('yaml', { 'src/content/pages/bad.md': '---\ntitle: "unclosed\nlink: [x\n---\n' }, { logged: ['double quoted scalar'] });
    assert.deepEqual(body.check.problems, [{ code: 'YAMLException', message: "An entry's frontmatter is not valid YAML." }]);
    const entries = entriesOf(body);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].collection, 'pages');
    assert.equal(entries[0].slug, 'bad');
    assert.equal(entries[0].issues.length, 1);
    assert.match(entries[0].issues[0].message, /^The frontmatter is not valid YAML \(near line \d+ of the file\)\.$/);
  });

  await check('a locale file: Astro\'s id "homefr" is the editor\'s home (fr)', async () => {
    const body = await refuse('locale', { 'src/content/pages/home.fr.md': '---\nheading: Accueil\n---\n' });
    assert.deepEqual(entriesOf(body), [{
      collection: 'pages', slug: 'home', locale: 'fr', editable: true,
      issues: [{ path: 'title', message: entriesOf(body)[0].issues[0].message }],
    }]);
  });

  await check('a nested id: 2024/first-post', async () => {
    const body = await refuse('nested', { 'src/content/pages/2024/first-post.md': '---\nheading: x\n---\n' });
    assert.deepEqual(entriesOf(body).map(({ collection, slug }) => ({ collection, slug })), [{ collection: 'pages', slug: '2024/first-post' }]);
  });

  await check("a data entry's invalid JSON: the sentence, the entry, our line and column", async () => {
    const body = await refuse('json', { 'src/content/authors/bob.json': '{ "name": "Bob", }\n' }, { logged: ['DataCollectionEntryParseError'] });
    assert.deepEqual(body.check.problems.map((problem) => problem.code), ['DataCollectionEntryParseError']);
    const entries = entriesOf(body);
    assert.deepEqual(entries.map(({ collection, slug }) => ({ collection, slug })), [{ collection: 'authors', slug: 'bob' }]);
    assert.match(entries[0].issues[0].message, /^This entry's JSON is not valid/);
  });

  await check('the entry is read at the checked commit, not from the working tree', async () => {
    git('checkout', '-q', '-f', '-B', 'case-committed', 'main');
    writeFile('src/content/pages/about.md', '---\ntitle: About\nlink: /home/elsewhere\n---\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'bad link');
    // The fix exists only on disk: the commit is what was checked.
    writeFile('src/content/pages/about.md', '---\ntitle: About\nlink: /home/about\n---\n');
    const check = await checkHeadWithAstro(await getConfig());
    const body = await checkRefusalBody(check, { committed: true });
    assert.equal(check.success, false);
    const [entry] = entriesOf(body);
    assert.equal(entry.slug, 'about');
    assert.equal(entry.editable, true, 'the live tree has the entry, so it opens');
    assert.deepEqual(entry.issues.map((issue) => issue.path), ['link'], 'the committed value is reported, not the fixed one on disk');
  });

  // ---- Which entries are blamed: only ones that can be CONFIRMED ----

  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==', 'base64');
  const slugsOf = (body) => entriesOf(body).map(({ collection, slug, locale }) => `${collection}/${slug}${locale ? ` (${locale})` : ''}`);

  await check('a missing image is blamed on the entry whose OWN folder lacks it, not on one whose folder has it', async () => {
    fs.mkdirSync(path.join(projectRoot, 'src/content/covers/a'), { recursive: true });
    const body = await refuse('image-folders', {
      'src/content/covers/a/one.md': '---\ncover: ./pic.png\n---\n',
      'src/content/covers/a/pic.png': PNG,
      'src/content/covers/b/two.md': '---\ncover: ./pic.png\n---\n',
      // Prose that names the file, and the same syntax inside inline code.
      'src/content/pages/notes.md': '---\ntitle: Notes\n---\nThe file ./pic.png is the cover. `![x](./pic.png)`\n',
    }, { logged: ['ImageNotFound', '`./pic.png`'] });
    assert.deepEqual(body.check.problems.map((problem) => problem.code), ['ImageNotFound']);
    assert.deepEqual(slugsOf(body), ['covers/b/two'], 'negative controls: a/one (its pic.png is committed) and pages/notes (prose) are not blamed');
    assert.deepEqual(entriesOf(body)[0].issues, [{ path: 'cover', message: 'The image file ./pic.png was not found.' }]);
  });

  await check("a markdown body's own image, as the site's processor reads it, is blamed; a mention in code is not", async () => {
    const body = await refuse('image-body', {
      'src/content/pages/gallery.md': '---\ntitle: Gallery\n---\n![A view](./view.png)\n',
      'src/content/pages/howto.md': '---\ntitle: How to\n---\nWrite `![A view](./view.png)` to show it.\n\n```\n![A view](./view.png)\n```\n',
    }, { logged: ['ImageNotFound', '`./view.png`'] });
    assert.deepEqual(slugsOf(body), ['pages/gallery'], 'negative control: howto mentions it only in code');
    assert.deepEqual(entriesOf(body)[0].issues, [{ path: 'body', message: 'The body uses the image file ./view.png, which was not found.' }]);
  });

  await check('an entry whose slug is another file name: the entry Astro means, not the file named like the id', async () => {
    const body = await refuse('slug', {
      'src/content/pages/intro.md': '---\nslug: start\nlink: /nowhere\n---\n',
      'src/content/pages/start.md': '---\ntitle: Start\nslug: other\n---\n',
    }, { logged: ['pages → start'] });
    assert.deepEqual(slugsOf(body), ['pages/intro'], 'negative control: the healthy start.md is not listed');
    assert.deepEqual(entriesOf(body)[0].issues.map((issue) => issue.path).sort(), ['link', 'title']);
  });

  await check('the same, with no Location line: the id is resolved through the committed slugs', async () => {
    git('checkout', '-q', '-f', 'case-slug');
    const check = await checkHeadWithAstro(await getConfig());
    const [worktreeSite] = /\S*astroadmin-check-[^/\s]+\/worktree/.exec(check.rawOutput) || [];
    assert.ok(worktreeSite, 'positive control: the output names the worktree');
    const withoutLocation = check.rawOutput.replace(/^\s*Location:\s*\n.*\n/gm, '');
    assert.ok(!withoutLocation.includes('intro.md') && withoutLocation.includes('pages → start'), 'the stripped output names only the id');
    const entries = await describeRefusedEntries({
      output: withoutLocation, siteDirs: [worktreeSite], projectRoot, commit: git('rev-parse', 'HEAD'), fullConfig: await getConfig(),
    });
    assert.deepEqual(entries.map((entry) => `${entry.collection}/${entry.slug}`), ['pages/intro']);
    assert.equal(entries[0].validation, 'unchecked', 'no check worktree: the commit\'s schemas are not loaded, so nothing is validated');
    assert.deepEqual(entries[0].issues, []);
    // A check directory whose config cannot be loaded: the same, listed without issues.
    const unloadable = await describeRefusedEntries({
      output: withoutLocation, siteDirs: [worktreeSite], projectRoot, commit: git('rev-parse', 'HEAD'), fullConfig: await getConfig(),
      checkSiteDir: path.join(scratch, 'no-such-site'),
    });
    assert.deepEqual(unloadable.map((entry) => [entry.slug, entry.validation, entry.issues.length]), [['intro', 'unchecked', 0]]);
  });

  await check('an id that two committed entries (or two file() items) share confirms neither', async () => {
    const describe = async (files, output) => {
      git('checkout', '-q', '-f', '-B', 'case-shared-id', 'main');
      for (const [relativePath, content] of Object.entries(files)) writeFile(relativePath, content);
      git('add', '-A');
      git('commit', '-q', '-m', 'shared id');
      const entries = await describeRefusedEntries({ output, siteDirs: [], projectRoot, commit: git('rev-parse', 'HEAD'), fullConfig: await getConfig() });
      return entries.map((entry) => `${entry.collection}/${entry.slug}`);
    };
    const pageError = '[InvalidContentEntryDataError] pages → shared data does not match collection schema.\n';
    assert.deepEqual(await describe({ 'src/content/pages/one.md': '---\nslug: shared\n---\n' }, pageError), ['pages/one'], 'positive control: one entry has the id');
    assert.deepEqual(await describe({ 'src/content/pages/one.md': '---\nslug: shared\n---\n', 'src/content/pages/two.md': '---\nslug: shared\n---\n' }, pageError), []);
    const itemError = '[InvalidContentEntryDataError] people → Jay data does not match collection schema.\n';
    assert.deepEqual(await describe({ 'src/data/people.json': JSON.stringify([{ id: 'Jay', name: 1 }]) }, itemError), ['people/Jay'], 'positive control: one item has the id');
    assert.deepEqual(await describe({ 'src/data/people.json': JSON.stringify([{ id: 'Jay', name: 1 }, { slug: 'Jay', name: 'x' }]) }, itemError), []);
    // An id error whose Location is another collection's file names nothing.
    const located = (file) => `${pageError}  Location:\n    ${projectRoot}/${file}:0:0\n`;
    const entries = await describeRefusedEntries({
      output: located('src/content/covers/first.md'), siteDirs: [projectRoot], projectRoot, commit: git('rev-parse', 'HEAD'), fullConfig: await getConfig(),
    });
    assert.deepEqual(entries, []);
    const control = await describeRefusedEntries({
      output: located('src/content/pages/home.md'), siteDirs: [projectRoot], projectRoot, commit: git('rev-parse', 'HEAD'), fullConfig: await getConfig(),
    });
    assert.deepEqual(control.map((entry) => entry.slug), ['home'], "positive control: the collection's own file is named");
  });

  await check("a loader's own generateId: the error's Location names the entry, not the file named like the id", async () => {
    const config = fs.readFileSync(path.join(projectRoot, 'src/content.config.ts'), 'utf-8')
      .replace("base: './src/content/pages' })", "base: './src/content/pages', generateId: ({ entry }) => `x-${entry.replace(/\\.md$/, '')}` })");
    assert.ok(config.includes('generateId'), 'the fixture changed the loader');
    const body = await refuse('generate-id', {
      'src/content.config.ts': config,
      'src/content/pages/intro.md': '---\nlink: /nowhere\n---\n',
      'src/content/pages/x-intro.md': '---\ntitle: Healthy\n---\n',
    }, { logged: ['pages → x-intro'] });
    assert.deepEqual(slugsOf(body), ['pages/intro'], 'negative control: x-intro.md (default id x-intro) is not listed');
  });

  await check("a file() item whose id has a space: Astro's whole id, not the item named like its first word", async () => {
    const body = await refuse('item-space', {
      'src/data/people.json': JSON.stringify([{ id: 'Jane Doe', name: 5 }, { id: 'Jane', name: 'Jay' }]),
    }, { logged: ['people → Jane Doe'] });
    assert.deepEqual(entriesOf(body).map(({ collection, slug }) => `${collection}/${slug}`), ['people/Jane Doe'], 'negative control: "Jane" is not listed');
    assert.deepEqual(entriesOf(body)[0].issues.map((issue) => issue.path), ['name']);
  });

  await check("committed content is validated against the COMMIT's schema, not a different live one", async () => {
    const liveConfigPath = path.join(projectRoot, 'src/content.config.ts');
    const committedConfig = fs.readFileSync(liveConfigPath, 'utf-8');
    const { loadSchemas, clearSchemaCache } = await import('../server/utils/collections.js');
    try {
      git('checkout', '-q', '-f', '-B', 'case-live-schema', 'main');
      writeFile('src/content/pages/about.md', '---\ntitle: About\nlink: /home/elsewhere\n---\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'bad link');
      // The live config, uncommitted, relaxes the enum; the live cache holds it.
      fs.writeFileSync(liveConfigPath, committedConfig.replace("z.enum(['/home/about', '/home/contact'])", 'z.string()'));
      clearSchemaCache();
      const live = await loadSchemas();
      assert.equal((await live.pages._zodSchema.safeParseAsync({ title: 'x', link: '/home/elsewhere' })).success, true, 'positive control: the live schema accepts the value');
      const check = await checkHeadWithAstro(await getConfig());
      assert.equal(check.success, false, "positive control: Astro (the commit's config) refuses it");
      const body = await checkRefusalBody(check, { committed: true });
      const [entry] = body.check.entries;
      assert.equal(entry.validation, 'invalid', JSON.stringify(entry));
      assert.deepEqual(entry.issues.map((issue) => issue.path), ['link']);
      assert.deepEqual(entry.issues[0].accepted, ['/home/about', '/home/contact']);
      assert.equal(await loadSchemas(), live, "the live schema cache is untouched by the commit's schemas");
    } finally {
      fs.writeFileSync(liveConfigPath, committedConfig);
      clearSchemaCache();
    }
  });

  await check('a Location naming a file the build made, not the commit, lists no entry', async () => {
    const generator = `import fs from 'fs';
export default { integrations: [{ name: 'gen', hooks: { 'astro:config:setup': ({ config }) => {
  fs.writeFileSync(new URL('./src/content/pages/generated.md', config.root), '---\\nlink: /nowhere\\n---\\n');
} } }] };
`;
    const body = await refuse('generated', { 'astro.config.mjs': generator }, { logged: ['pages → generated', 'generated.md'] });
    assert.deepEqual(body.check.problems.map((problem) => problem.code), ['InvalidContentEntryDataError'], 'the sentence still says what is wrong');
    assert.deepEqual(entriesOf(body), [], 'negative control: the generated file is not a committed entry');
  });

  report('='.repeat(40));
  report(`\n📊 ${passed} checks passed${skipped ? `, ${skipped} SKIPPED (see above)` : ''}.\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
