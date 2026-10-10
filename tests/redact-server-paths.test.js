/**
 * The shared redactor's rules (server/utils/redact-server-paths.js), case by
 * case, with the useful text that must survive each one.
 *
 * - The server's directories are stripped with NO argument: the project root
 *   (ASTROADMIN_PROJECT_ROOT), the working directory, addServerPaths, and
 *   their resolved paths. Routes passed nothing and leaked.
 * - A quoted path ('...' or "...") is one path, spaces and all.
 * - A `../` climb: inside a server directory -> relative to it; into a
 *   directory that exists beside the one it climbed to, or to the root ->
 *   last segment; anything else is the site's own value and is kept.
 * - The home directory (and above) is never a prefix: it would leave the
 *   folders below it named.
 *
 *   bun tests/redact-server-paths.test.js     (<1 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-redact-')));
const projectRoot = path.join(scratch, 'my site');
const adminDir = path.join(scratch, 'admin-cwd');
const siblingSite = path.join(scratch, 'site-b');
const registeredDir = path.join(scratch, 'registered-elsewhere');
for (const directory of [projectRoot, adminDir, siblingSite, registeredDir]) fs.mkdirSync(directory);
const linkedRoot = path.join(scratch, 'linked-site');
fs.symlinkSync(projectRoot, linkedRoot, 'dir');

process.env.ASTROADMIN_PROJECT_ROOT = linkedRoot;
const originalCwd = process.cwd();
process.chdir(adminDir);

const { redactServerPaths, clientErrorMessage, cleanCheckOutput, addServerPaths } = await import('../server/utils/redact-server-paths.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.message}`);
    process.exitCode = 1;
  }
}

const SIGNS = [scratch, 'aa-redact-', 'my site', 'admin-cwd', 'site-b', 'linked-site', 'registered-elsewhere', '/srv', 'git store'];
function assertNoServerPath(text) {
  for (const sign of SIGNS) assert.equal(text.includes(sign), false, `names a server path (${sign}): ${text}`);
}

try {
  console.log('\n🧪 redactServerPaths\n' + '='.repeat(40));

  check('no argument: the project root (and its resolved path) is stripped by default', () => {
    const text = clientErrorMessage(new Error(`ENOENT: no such file, open '${linkedRoot}/src/a.md' and ${projectRoot}/src/b.md`));
    assert.equal(text, "ENOENT: no such file, open 'src/a.md' and src/b.md");
  });

  check('no argument: the working directory is stripped by default', () => {
    const text = redactServerPaths(`cannot read ${adminDir}/logs/x.log`);
    assert.equal(text, 'cannot read logs/x.log');
  });

  check('addServerPaths: a registered directory is stripped by every later call', () => {
    assert.equal(redactServerPaths(`at ${registeredDir}/src/c.md`), 'at c.md', 'control: before registering, the generic rule applies');
    addServerPaths(registeredDir);
    assert.equal(redactServerPaths(`at ${registeredDir}/src/c.md`), 'at src/c.md');
  });

  check('a quoted absolute path with spaces is one path (single and double quotes)', () => {
    const text = redactServerPaths(`fatal: could not create '/srv/git store/repo.git/worktrees/check': denied; read "/srv/a b/c d/x y.lock" failed`);
    assert.equal(text, `fatal: could not create 'check': denied; read "x y.lock" failed`);
  });

  check('a quoted path under the project root (whose name has a space) keeps its site-relative tail', () => {
    const text = redactServerPaths(`unlink '${projectRoot}/public/images/my photo.png'`);
    assert.equal(text, "unlink 'public/images/my photo.png'");
  });

  check('quoted text that is not a path is untouched (Astro and zod messages)', () => {
    const message = `"title" is required; Expected type "string", received "number"; can't find 'hero'`;
    assert.equal(redactServerPaths(message), message);
  });

  check('a quoted single-segment value such as a page path is kept, as unquoted', () => {
    assert.equal(redactServerPaths(`no page at "/about" or /contact`), `no page at "/about" or /contact`);
  });

  check('a climb into the project root is made relative to it', () => {
    const text = redactServerPaths('../my site/src/content.config.ts:10:22: ERROR: Unexpected ";"');
    assert.equal(text, 'src/content.config.ts:10:22: ERROR: Unexpected ";"');
  });

  check('a climb into a sibling checkout is reduced to its last segment', () => {
    const text = redactServerPaths('../site-b/src/content.config.ts:3:1: ERROR: Expected "}"');
    assert.equal(text, 'content.config.ts:3:1: ERROR: Expected "}"');
  });

  check('a quoted climb with spaces is one path', () => {
    assert.equal(redactServerPaths(`open '../my site/src/a b.md'`), "open 'src/a b.md'");
    assertNoServerPath(redactServerPaths(`open '../site-b/x y/z.md'`));
    assert.equal(redactServerPaths(`open '../site-b/x y/z.md'`), "open 'z.md'");
  });

  check('a climb to the filesystem root is reduced to its last segment', () => {
    const depth = adminDir.split('/').filter(Boolean).length;
    const climb = `${'../'.repeat(depth)}srv/elsewhere/x.ts`;
    assert.equal(redactServerPaths(`${climb}:1:1: ERROR`), 'x.ts:1:1: ERROR');
  });

  check('a content-relative value that names nothing on the server is kept', () => {
    const message = 'Could not find image ../assets/images/hero.png in ../../shared/logo.svg';
    assert.equal(redactServerPaths(message), message);
  });

  check('URLs are kept', () => {
    const message = "fatal: unable to access 'https://git.example.com/site-a/site.git/': Could not resolve host";
    assert.equal(redactServerPaths(message), message);
  });

  check('the home directory is never a prefix: a path under it is reduced to its last segment', () => {
    const home = os.homedir();
    const text = redactServerPaths(`read ${home}/Code/private-client/x.md`, [home]);
    assert.equal(text, 'read x.md');
  });

  check('cleanCheckOutput strips the default directories too', () => {
    assert.equal(cleanCheckOutput(`built ${projectRoot}/dist/index.html`), 'built dist/index.html');
  });

  check('a server dir is stripped only at a path boundary, not inside a longer sibling name', () => {
    const out = redactServerPaths('see /srv/site-b/x.md and /srv/site/y.md and /srv/site', ['/srv/site']);
    assert.ok(!out.includes('.-b'), `a sibling name was mangled: ${out}`);
    assert.ok(out.includes('y.md'), `positive control: the file under the server dir stays named: ${out}`);
    assert.ok(!out.includes('/srv/site/'), `positive control: the server dir is stripped: ${out}`);
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
