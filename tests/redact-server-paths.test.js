/**
 * cleanCheckOutput (server/utils/redact-server-paths.js): build output an
 * editor may read. It removes the KNOWN directories (the ones the caller
 * names, and their resolved paths) where a path starts, and nothing else; if
 * a server path is left anywhere, the whole output becomes a fixed message
 * and the original goes to the server log.
 *
 * Every leak a review found in the old scrubber is a case here, asserting
 * that no server directory name appears in what the editor gets and that the
 * original reached the log (the positive control: the path really was in
 * the input). Every over-redaction is a case asserting the text survives.
 *
 *   bun tests/redact-server-paths.test.js     (<1 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-redact-')));
const projectRoot = path.join(scratch, 'my site');
const siblingSite = path.join(scratch, 'site-b');
const quotedDir = path.join(scratch, `client's "site"`, 'private');
for (const directory of [projectRoot, siblingSite, quotedDir]) fs.mkdirSync(directory, { recursive: true });
const linkedRoot = path.join(scratch, 'linked-site');
fs.symlinkSync(projectRoot, linkedRoot, 'dir');

const { cleanCheckOutput, HIDDEN_OUTPUT_MESSAGE } = await import('../server/utils/redact-server-paths.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.log(`❌ ${name}\n   ${error.message}`);
    process.exitCode = 1;
  }
}

/** Run cleanCheckOutput and capture what it logged. */
function clean(text, roots) {
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    return { output: cleanCheckOutput(text, roots), log: logged.join('\n') };
  } finally {
    console.error = realError;
  }
}

const SIGNS = [scratch, 'aa-redact-', 'my site', 'site-b', 'linked-site', 'client', '/srv', 'git store', 'git-store', 'repo.git', 'backup', 'other place', '/private/', '/var/'];
function assertNoServerPath(text) {
  for (const sign of SIGNS) assert.equal(text.includes(sign), false, `names a server path (${sign}): ${text}`);
}

/** A leak: the editor gets the fixed message, and the server log has the original. */
function assertHidden(input, roots, label) {
  const { output, log } = clean(input, roots);
  assert.equal(output, HIDDEN_OUTPUT_MESSAGE, `${label}: expected the fixed message, got: ${output}`);
  assertNoServerPath(output);
  assert.ok(log.includes(input), `${label}: positive control: the original is in the server log (${log})`);
}

/** Kept: the editor gets exactly `expected`, and nothing was logged. */
function assertKept(input, roots, expected = input) {
  const { output, log } = clean(input, roots);
  assert.equal(output, expected);
  assert.equal(log, '', `nothing logged for kept output: ${log}`);
}

try {
  console.log('\n🧪 cleanCheckOutput\n' + '='.repeat(40));

  // ---- Known roots are removed where a path starts ----

  check('the project root is removed, the site-relative tail kept (a root with a space)', () => {
    assertKept(`unlink '${projectRoot}/public/images/my photo.png' and ${projectRoot}/src/a.md:3:1`, [projectRoot],
      "unlink 'public/images/my photo.png' and src/a.md:3:1");
  });

  check('a symlinked root: the resolved path is removed too', () => {
    assertKept(`[InvalidContentEntryDataError] pages → home: ${projectRoot}/src/content/pages/home.md`, [linkedRoot],
      '[InvalidContentEntryDataError] pages → home: src/content/pages/home.md');
  });

  check('the bare root becomes "." where its path ends', () => {
    assertKept(`${projectRoot}: not writable`, [projectRoot], '.: not writable');
  });

  check('a file:// URL under a root is removed (encoded or not)', () => {
    const encoded = `file://${projectRoot.split('/').map(encodeURIComponent).join('/')}/src/a.md`;
    assertKept(`see ${encoded} and file://${projectRoot}/src/b.md`, [projectRoot], 'see src/a.md and src/b.md');
  });

  check('ANSI colour codes and stack frames are stripped', () => {
    assertKept(`\u001b[31merror\u001b[39m bad\n    at x (${projectRoot}/y.js:1:1)\nStack trace:\n  at z`, [projectRoot], 'error bad');
  });

  // ---- Over-redaction cases from the review rounds: the text survives ----

  check('a zod enum listing quoted page paths survives whole (review 5)', () => {
    const message = `[InvalidContentEntryDataError] pages → home data does not match collection schema.\n  link: Invalid enum value. Expected '/about' | '/blog/[slug]', received '/contact'`;
    assertKept(message, [projectRoot]);
    assertKept(`Invalid option: expected one of "/about"|"/blog/[slug]"`, [projectRoot]);
  });

  check('URLs survive, including a path in the query (review 5)', () => {
    assertKept('see https://example.com/preview?path=/blog/a.md and http://example.com:4321/blog/x', [projectRoot]);
    assertKept("fatal: unable to access 'https://git.example.com/site-a/site.git/': Could not resolve host", [projectRoot]);
  });

  check("a content-relative value survives (`../assets/x.png`)", () => {
    assertKept('Could not find image ../assets/images/hero.png referenced in src/content/pages/home.md', [projectRoot]);
  });

  check('quoted text that is not a path is untouched', () => {
    assertKept(`"title" is required; Expected type "string", received "number"; can't find 'hero'`, [projectRoot]);
  });

  // ---- Leak cases from the review rounds: no server directory is named ----

  check('an external git directory (review 2)', () => {
    assertHidden("fatal: could not create '/srv/git-store/repo.git/worktrees/check': Permission denied", [projectRoot], 'external git dir');
  });

  check('a quoted external path with spaces, single and double quotes (review 3)', () => {
    assertHidden("fatal: could not create '/srv/git store/repo.git/worktrees/check'", [projectRoot], 'spaces');
    assertHidden('error: unable to read "/srv/other place/site b/x.lock"', [projectRoot], 'double quotes');
  });

  check('a sibling directory named like the root plus a space or a plus sign (review 4)', () => {
    assertHidden("open '/srv/site backup/private/a.md' failed", ['/srv/site'], 'space after root');
    assertHidden('open /srv/site+backup/private/a.md failed', ['/srv/site'], 'plus after root');
    assertHidden(`open '${projectRoot} backup/private/a.md' failed`, [projectRoot], 'space after a real root');
  });

  check("a double-quoted path with an apostrophe (review 4)", () => {
    assertHidden('open "/srv/client\'s site/private/a.md" failed', ['/srv/site'], 'apostrophe');
  });

  check('a URL holding a root path (review 4): hidden rather than corrupted', () => {
    assertHidden('see http://example.com:4321/srv/site/x.md', ['/srv/site'], 'root in a URL path');
  });

  check('file:// with %20 that decodes to a sibling of the root (review 5)', () => {
    assertHidden('file:///srv/site%20backup/private/a.md: not found', ['/srv/site'], 'file URL %20');
    // Under no known root and no common top-level name: only the URL scheme
    // says it is a server file.
    assertHidden('see file:///webroots/client%20site/a.md', ['/srv/site'], 'file URL elsewhere');
  });

  check('a backtick-delimited external path (review 5)', () => {
    assertHidden('cannot open `/srv/other/x.md`', ['/srv/site'], 'backticks');
  });

  check(`a real ENOENT for a path with both quote characters in it (review 5)`, () => {
    let message = '';
    try {
      fs.readFileSync(path.join(quotedDir, 'a.md'));
    } catch (error) {
      message = error.message;
    }
    assert.ok(message.includes(`client's "site"`), `control: the real error names the directory: ${message}`);
    assertHidden(message, [projectRoot], 'both quotes');
  });

  check('a URL with a root in its query (review 5)', () => {
    assertHidden('see https://example.com/preview?path=/srv/site/a.md', ['/srv/site'], 'query');
    assertHidden(`see https://example.com/preview?path=${projectRoot}/a.md`, [projectRoot], 'query, real root');
  });

  check('a ../ climb into a sibling checkout, or into the root itself, from beside it (review 3)', () => {
    // esbuild names the file relative to the admin's working directory, which
    // sits beside the sites on a server that checks them out side by side.
    const originalCwd = process.cwd();
    const adminDir = path.join(scratch, 'admin-cwd');
    fs.mkdirSync(adminDir);
    process.chdir(adminDir);
    try {
      assertHidden('../site-b/src/content.config.ts:3:1: ERROR: Expected "}"', [projectRoot], 'sibling climb');
      assertHidden("open '../my site/src/a b.md'", [projectRoot], 'climb into the root');
      assertKept('Could not find image ../assets/images/hero.png', [projectRoot]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  check('a ../ climb to the filesystem root', () => {
    const depth = process.cwd().split('/').filter(Boolean).length;
    assertHidden(`${'../'.repeat(depth)}srv/elsewhere/x.ts:1:1: ERROR`, [projectRoot], 'climb to /');
  });

  check('a path under the home directory written with ~', () => {
    assertHidden('cannot read ~/Code/private-client/x.md', [projectRoot], 'tilde');
  });

  check('an unknown absolute path under this machine\'s own top-level directories', () => {
    assertHidden(`ENOENT: no such file or directory, open '${scratch}/elsewhere/a.md'`, [], 'no roots');
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
