/**
 * server/utils/build-failure.js: what an editor is told about a failed build
 * is built from structured parts only, never from the output's text.
 *
 * - findErrorCodes / buildProblems: the error codes Astro prints, each as a
 *   sentence we wrote; an unknown code by name; no code, a fixed sentence.
 *   The fixtures are Astro 7's real output (captured from real failing
 *   builds, colour codes kept), with the server paths swapped for /srv ones.
 * - parseFailureKeys: entry ids, files under the site's own directory only,
 *   and missing image paths, as keys to match, never shown.
 * - Every leak case from review rounds 2 to 6, run through buildProblems:
 *   nothing of the text survives, whatever shape the path takes.
 *
 *   bun tests/build-failure.test.js     (<1 s)
 */

import assert from 'assert';

const {
  astroIdForFile, buildProblems, globEntryId, describeCode, findErrorCodes, NO_CODE_MESSAGE, parseFailureKeys,
} = await import('../server/utils/build-failure.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.log(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const E = '\u001b';
const SITE = '/srv/sites/site-a/check/worktree';
const STACK = `  ${E}[1mStack trace:${E}[22m\n${E}[2m    at getEntryData (/srv/admin/node_modules/astro/dist/content/utils.js:126:9)${E}[22m`;

// Astro 7.3, a schema violation (zod enum of route-like values).
const SCHEMA = `${E}[2m08:59:26${E}[22m ${E}[34m[content]${E}[39m Syncing content
${E}[31m[InvalidContentEntryDataError]${E}[39m ${E}[1mpages → about${E}[22m data does not match collection schema.
  ${E}[1mlink${E}[22m: Invalid option: expected one of "/home/about"|"/home/contact"
  ${E}[1mHint:${E}[22m
${E}[33m    See ${E}[4mhttps://docs.astro.build/en/guides/content-collections/${E}[24m for more information on content schemas.${E}[39m
  ${E}[1mLocation:${E}[22m
    ${E}[4m${SITE}/src/content/pages/about.md:0:0${E}[24m
${STACK}`;

// Astro 7.3, a missing image() file.
const IMAGE = `${E}[31m${E}[1m08:59:28${E}[22m [ERROR] [vite]${E}[39m ${E}[31m✗${E}[39m Build failed in 39ms
${E}[31m[ImageNotFound]${E}[39m Could not find requested image \`./missing.png\`. Does it exist?
  ${E}[1mLocation:${E}[22m
    ${E}[4m/srv/admin/node_modules/astro/dist/content/vite-plugin-content-assets.js:42:19${E}[24m
${STACK}`;

// Astro 7.3, invalid frontmatter YAML: no code, js-yaml's frames.
const YAML = `${E}[2m08:59:29${E}[22m ${E}[34m[content]${E}[39m Syncing content
unexpected end of the stream within a double quoted scalar
  ${E}[1mLocation:${E}[22m
    ${E}[4m${SITE}/src/content/pages/bad.md:3:0${E}[24m
  ${E}[1mStack trace:${E}[22m
${E}[2m    at generateError (file:///srv/admin/node_modules/js-yaml/dist/js-yaml.mjs:1140:12)${E}[22m`;

// Astro 7.0 with @astrojs/mdx 7.0: an MDX syntax error. No code, no file.
const MDX = `${E}[31m${E}[1m09:00:15${E}[22m [ERROR] [vite]${E}[39m ${E}[31m✗${E}[39m Build failed in 80ms
4:1: Expected a closing tag for \`<div>\` (4:1) (mdx-jsx:unexpected-character)
  ${E}[1mStack trace:${E}[22m
${E}[2m    at TransformPluginContextImpl.handler (file:///srv/admin/node_modules/@astrojs/mdx/dist/vite-plugin-mdx.js:57:17)${E}[22m`;

// Astro 7.3, a data entry's invalid JSON.
const JSON_PARSE = `${E}[31m[DataCollectionEntryParseError]${E}[39m ${E}[1mauthors/bob.json${E}[22m failed to parse: Expected double-quoted property name in JSON at position 17 (line 1 column 18)
  ${E}[1mLocation:${E}[22m
    ${E}[4m${SITE}/src/content/authors/bob.json:0:0${E}[24m
${STACK}`;

try {
  console.log('\n🧪 build failures: codes and keys, never text\n' + '='.repeat(40));

  check('the codes in real Astro failures, through colour codes', () => {
    assert.deepEqual(findErrorCodes(SCHEMA), ['InvalidContentEntryDataError']);
    assert.deepEqual(findErrorCodes(IMAGE), ['ImageNotFound'], 'not the [ERROR] or [vite] logger tags');
    assert.deepEqual(findErrorCodes(YAML), ['YAMLException'], 'js-yaml prints no code; its frames say what it was');
    assert.deepEqual(findErrorCodes(MDX), ['MdxSyntaxError'], "the MDX compiler's rule id");
    assert.deepEqual(findErrorCodes(JSON_PARSE), ['DataCollectionEntryParseError']);
  });

  check('each code an editor can cause reads as a sentence of ours', () => {
    assert.deepEqual(buildProblems(SCHEMA), [{ code: 'InvalidContentEntryDataError', message: "An entry's data does not match its collection's schema." }]);
    assert.deepEqual(buildProblems(IMAGE), [{ code: 'ImageNotFound', message: 'An image an entry uses was not found in the site.' }]);
    assert.deepEqual(buildProblems(YAML), [{ code: 'YAMLException', message: "An entry's frontmatter is not valid YAML." }]);
    assert.match(buildProblems(MDX)[0].message, /^An MDX entry has a syntax error/);
  });

  check('an unknown code is named, with a pointer to the log; `Name: message` lines count too', () => {
    assert.deepEqual(buildProblems('[SomethingNewError] it broke at /srv/x'), [{ code: 'SomethingNewError', message: 'Astro refused the build (SomethingNewError); see the server log.' }]);
    assert.deepEqual(findErrorCodes('TypeError: cannot read /srv/site-b/x of undefined'), ['TypeError']);
    assert.equal(describeCode('toString'), 'Astro refused the build (toString); see the server log.', 'not an inherited property');
  });

  check('no code at all: a fixed sentence', () => {
    assert.deepEqual(buildProblems('Error: something failed in /srv/site,backup/x.md'), [{ code: null, message: NO_CODE_MESSAGE }]);
    assert.deepEqual(buildProblems(''), [{ code: null, message: NO_CODE_MESSAGE }]);
  });

  check('a bracketed path or value is not a code', () => {
    assert.deepEqual(findErrorCodes('[/srv/site-b/x.md] failed\n[ERROR] [vite] x\n[home/about] y\n[Error] z\n["/srv"]'), []);
  });

  check('entry keys: Astro ids, files under the site only, missing image paths', () => {
    assert.deepEqual(parseFailureKeys(SCHEMA, [SITE]), { ids: [{ collection: 'pages', id: 'about', file: 'src/content/pages/about.md' }], files: [], images: [] },
      "the error's own Location is kept with its id");
    assert.deepEqual(parseFailureKeys(IMAGE, [SITE]), { ids: [], files: [], images: ['./missing.png'] }, "astro's own Location is not under the site");
    assert.deepEqual(parseFailureKeys(YAML, [SITE]).files, ['src/content/pages/bad.md']);
    assert.deepEqual(parseFailureKeys(JSON_PARSE, [SITE]).files, ['src/content/authors/bob.json']);
  });

  check("a file() item id with spaces is Astro's whole id, up to its suffix", () => {
    // Astro 7.3's real lines for an item `{ "id": "Jane Doe", "name": 5 }`.
    const JANE = `${E}[31m[InvalidContentEntryDataError]${E}[39m ${E}[1mpeople → Jane Doe${E}[22m data does not match collection schema.
  name**: **name: Expected type "string", received "number"
  ${E}[1mLocation:${E}[22m
    ${E}[4m${SITE}/src/data/people.json:0:0${E}[24m
${STACK}`;
    assert.deepEqual(parseFailureKeys(JANE, [SITE]).ids, [{ collection: 'people', id: 'Jane Doe', file: 'src/data/people.json' }]);
  });

  check("a Location belongs to its own error: a later error's file is not paired with an earlier id", () => {
    const noLocation = '[InvalidContentEntryDataError] pages → start data does not match collection schema.\n  title: Required\n';
    const keys = parseFailureKeys(`${noLocation}${YAML}`, [SITE]);
    assert.deepEqual(keys.ids, [{ collection: 'pages', id: 'start', file: null }], "the YAML error's file is not the id's");
    assert.deepEqual(keys.files, ['src/content/pages/bad.md']);
  });

  check("Astro's glob id: a truthy data slug wins over the file name", () => {
    assert.equal(globEntryId('home.md', '---\nslug: start\n---\n'), 'start');
    assert.equal(globEntryId('home.md', '---\ntitle: Home\n---\n'), 'home');
    assert.equal(globEntryId('home.md', '---\nslug: ""\n---\n'), 'home', 'an empty slug is not one');
    assert.equal(globEntryId('a/b.json', '{ "slug": 42 }'), '42');
    assert.equal(globEntryId('home.md', '---\ntitle: "x\n---\n'), null, 'unreadable data: Astro assigns no id');
  });

  check('a Location in a sibling of the site directory is not the site', () => {
    const sibling = (where) => `[InvalidContentEntryDataError] pages → a data does not match\n  Location:\n    ${where}:0:0`;
    assert.deepEqual(parseFailureKeys(sibling(`${SITE},backup/src/content/pages/a.md`), [SITE]).files, []);
    assert.deepEqual(parseFailureKeys(sibling(`${SITE} backup/src/content/pages/a.md`), [SITE]).files, []);
    assert.deepEqual(parseFailureKeys(sibling(`${SITE}/../site-b/src/content/pages/a.md`), [SITE]).files, [], 'a climb out');
    assert.deepEqual(parseFailureKeys(sibling(`${SITE}/src/content/pages/a.md`), [SITE]).files, ['src/content/pages/a.md'], 'control');
  });

  check("Astro's glob id for a file", () => {
    assert.equal(astroIdForFile('home.fr.md'), 'homefr');
    assert.equal(astroIdForFile('Bad Page.md'), 'bad-page');
    assert.equal(astroIdForFile('2024/First Post.md'), '2024/first-post');
    assert.equal(astroIdForFile('guides/index.md'), 'guides');
  });

  // ---- Every leak case from review rounds 2-6: none of the text survives ----

  const LEAKS = [
    "fatal: could not create '/srv/git-store/repo.git/worktrees/check': Permission denied",
    "fatal: could not create '/srv/git store/repo.git/worktrees/check'",
    'error: unable to read "/srv/other place/site b/x.lock"',
    "open '/srv/site backup/private/a.md' failed",
    'open /srv/site+backup/private/a.md failed',
    'open "/srv/client\'s site/private/a.md" failed',
    `ENOENT: no such file or directory, open '/srv/client's "site"/private/a.md'`,
    'cannot open `/srv/other/x.md`',
    'file:///srv/site%20backup/private/a.md: not found',
    'see file:///webroots/client%20site/a.md',
    'see https://example.com/preview?path=/srv/site/a.md',
    'see http://example.com:4321/srv/site/x.md',
    '../site-b/src/content.config.ts:3:1: ERROR: Expected "}"',
    '../../../../srv/elsewhere/x.ts:1:1: ERROR',
    'cannot read ~/Code/private-client/x.md',
    "ENOENT: no such file or directory, open '/srv/site,backup/private/a.md'",
    "ENOENT: no such file or directory, open 'C:\\builds\\site-a\\private\\a.md'",
    'error reading D:/builds/site-a/a.md',
    "ENOENT: no such file or directory, open '/app/site-a/private/a.md'",
    "ENOENT: no such file or directory, open '/data/site-a/private/a.md'",
    'created directory /srv/www/client-b-site\nsent 120 bytes',
    'Command failed: /srv/scripts/build-site-a.sh --out /srv/www/site-a',
  ];
  const SIGNS = ['/srv', 'srv/', 'git-store', 'git store', 'repo.git', 'site b', 'backup', 'client', 'webroots', 'site-a', 'site-b',
    'elsewhere', '~/', 'C:', 'D:', '/app', '/data', 'www', 'scripts', 'private', '%20', '..'];

  check('every leak case: the problems carry no path, only a fixed sentence', () => {
    for (const text of LEAKS) {
      const problems = buildProblems(text);
      const body = JSON.stringify(problems);
      for (const sign of SIGNS) assert.equal(body.includes(sign), false, `"${text}" -> ${body} carries "${sign}"`);
    }
  });

  check('every leak case beside a real Astro error: the code survives, the path does not', () => {
    for (const text of LEAKS) {
      const problems = buildProblems(`${SCHEMA}\n${text}`);
      assert.equal(problems[0].code, 'InvalidContentEntryDataError');
      const body = JSON.stringify(problems);
      for (const sign of SIGNS) assert.equal(body.includes(sign), false, `"${text}" -> ${body} carries "${sign}"`);
    }
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  // nothing on disk
}
process.exit(process.exitCode || 0);
