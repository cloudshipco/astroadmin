/**
 * The publish check's 422 refusal names no server path, whatever the build
 * or git prints. It carries no text of theirs at all (build-failure.js):
 * error codes as sentences we wrote, entries resolved against the commit,
 * and our own validation of each.
 *
 * Runs the real publishHandler with git enabled (no remote: the pull and the
 * push are skipped, the commit and the check are not):
 *
 * - git itself fails: the site's git directory lives elsewhere
 *   (`git init --separate-git-dir`) and its worktrees/ folder is read-only,
 *   so adding the check's worktree fails naming that directory;
 * - the "build" prints every leak shape the review rounds found (2 to 6:
 *   spaces, apostrophes, both quotes, backticks, file:// with %20, ../
 *   climbs, an external git directory, a symlinked root, query strings, a
 *   sibling `<root>,backup`, Windows paths, /app and /data mount points, an
 *   rsync destination, a command line), beside real Astro error lines whose
 *   ids, Location and image path are server paths too.
 *
 * Each asserts that no server directory or name appears ANYWHERE in the
 * body, with a positive control that the text really reached the server log.
 *
 *   bun tests/publish-refusal-paths.test.js     (~3 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = path.resolve(import.meta.dir, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-publish-refusal-paths-')));
const projectRoot = path.join(scratch, 'site');
const externalGitDir = path.join(scratch, 'git-store', 'site.git');
const linkedRoot = path.join(scratch, 'linked-site');
const leaksFile = path.join(scratch, 'leaks.txt');
fs.mkdirSync(projectRoot);
fs.mkdirSync(path.dirname(externalGitDir));
fs.symlinkSync(projectRoot, linkedRoot, 'dir');

for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
delete process.env.ASTROADMIN_CONTENT_STORE;

const gitIn = (...args) => execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf-8' });
const writeSiteFile = (relativePath, content) => {
  fs.mkdirSync(path.dirname(path.join(projectRoot, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, relativePath), content);
};
execFileSync('git', ['init', '-q', '--separate-git-dir', externalGitDir, projectRoot]);
gitIn('config', 'user.name', 'Test');
gitIn('config', 'user.email', 'test@example.com');
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeSiteFile('.gitignore', 'node_modules\n');
writeSiteFile('package.json', JSON.stringify({ type: 'module' }));
// The "build" prints the leak file and fails.
writeSiteFile('astroadmin.config.js', `export default { git: { enabled: true, paths: ['src/content/'] }, build: { check: ${JSON.stringify(`cat '${leaksFile}'; exit 1`)} } };\n`);
writeSiteFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: z.object({ title: z.string(), link: z.enum(['/home/about', '/home/contact']).optional() }),
  }),
};
`);
writeSiteFile('src/content/pages/home.md', '---\ntitle: Home\n---\n');
gitIn('add', '-A');
gitIn('commit', '-q', '-m', 'first');

const worktreesDir = path.join(externalGitDir, 'worktrees');
fs.mkdirSync(worktreesDir);
fs.chmodSync(worktreesDir, 0o555);

const { publishHandler, publishFailureMessage, checkRefusalBody } = await import('../server/api/publish.js');
const { checkHeadWithAstro } = await import('../server/utils/astro-check.js');
const { getConfig } = await import('../server/config.js');

// The server log: what the app writes, kept for the positive controls.
const serverLog = [];
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    serverLog.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(' '));
  };
}
const report = (line) => process.stdout.write(`${line}\n`);
function assertLogged(mark, ...fragments) {
  const logged = serverLog.slice(mark).join('\n');
  for (const fragment of fragments) {
    assert.ok(logged.includes(fragment), `positive control: the server log has the original (${fragment}); it has:\n${logged.slice(0, 2000)}`);
  }
}

let passed = 0;
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

function jsonResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function publish(message) {
  const res = jsonResponse();
  await publishHandler({ body: { message } }, res);
  return res;
}

const SERVER_PATH_SIGNS = [scratch, 'aa-publish-refusal-paths-', 'git-store', 'site.git', 'repo.git', 'git store', 'other place',
  'site b', 'linked-site', 'astroadmin-check-', os.tmpdir(), fs.realpathSync(os.tmpdir()), '/private/', '/var/folders/', '/srv',
  'srv/', 'backup', 'client', 'webroots', 'site-a', 'site-b', 'elsewhere', '~/', 'C:', 'D:', '/app', '/data', 'www', 'scripts',
  '%20', '..', 'secret', 'Stack trace', 'docs.astro.build'];
function assertNoServerPath(label, text) {
  for (const sign of SERVER_PATH_SIGNS) {
    assert.equal(text.includes(sign), false, `${label} names a server path (${sign}): ${text}`);
  }
}

// Every leak shape from review rounds 2-6, and Astro error lines whose parts
// are server paths: an id, a Location outside the site, an image path.
const LEAKS = [
  "fatal: could not create '/srv/git-store/repo.git/worktrees/check': Permission denied",
  "fatal: could not create '/srv/git store/repo.git/worktrees/check'",
  'error: unable to read "/srv/other place/site b/x.lock"',
  "open '/srv/site backup/private/a.md' failed",
  'open /srv/site+backup/private/a.md failed',
  `ENOENT: no such file or directory, open '/srv/client's "site"/private/a.md'`,
  'cannot open `/srv/other/x.md`',
  'file:///srv/site%20backup/private/a.md: not found',
  `see file://${projectRoot.split('/').map(encodeURIComponent).join('/')}%20backup/a.md`,
  'see https://example.com/preview?path=/srv/site/a.md',
  `see https://example.com/preview?path=${projectRoot}/a.md`,
  '../site-b/src/content.config.ts:3:1: ERROR: Expected "}"',
  "open '../my site/src/a b.md'",
  '../../../../srv/elsewhere/x.ts:1:1: ERROR',
  'cannot read ~/Code/private-client/x.md',
  `unlink '${linkedRoot}/public/images/my photo.png' and ${fs.realpathSync(projectRoot)}/src/a.md:3:1`,
  `open '${projectRoot},backup/private/a.md'`,
  "ENOENT: no such file or directory, open '/srv/site,backup/private/a.md'",
  "ENOENT: no such file or directory, open 'C:\\builds\\site-a\\private\\a.md'",
  'error reading D:/builds/site-a/a.md',
  "ENOENT: no such file or directory, open '/app/site-a/private/a.md'",
  "ENOENT: no such file or directory, open '/data/site-a/private/a.md'",
  'created directory /srv/www/client-b-site',
  'Command failed: /srv/scripts/build-site-a.sh --out /srv/www/site-a',
  '[InvalidContentEntryDataError] pages → home data does not match collection schema.',
  "  link: Invalid option: expected one of '/srv/site-b/a'",
  '  Location:',
  `    ${projectRoot},backup/src/content/pages/home.md:0:0`,
  '[InvalidContentEntryDataError] /srv/site-b → /srv/site-b/secret data does not match collection schema.',
  '[ImageNotFound] Could not find requested image `/srv/client-b/secret.png`. Does it exist?',
  `    at load (${scratch}/node_modules/astro/dist/x.js:1:2)`,
];

try {
  report('\n🧪 publish refusals name no server path\n' + '='.repeat(40));

  await check('git fails to add the worktree in an external git directory: a fixed sentence', async () => {
    writeSiteFile('src/content/pages/home.md', '---\ntitle: Home again\n---\n');
    const mark = serverLog.length;
    const res = await publish('Edit home');
    // Positive controls: the check really ran and refused, for this reason,
    // and the server log has git's own words naming the external directory.
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
    assert.equal(res.body.committed, true, 'the commit happened first');
    assert.equal(res.body.pushed, false);
    assertLogged(mark, externalGitDir);
    assert.match(serverLog.slice(mark).join('\n'), /could not create|Permission denied/i, 'the git failure is in the log');
    assert.deepEqual(res.body.check.problems, [{ code: null, message: 'The publish check could not run, so nothing was pushed; see the server log.' }]);
    assert.deepEqual(res.body.check.entries, []);
    assertNoServerPath('the 422 body', JSON.stringify(res.body));
  });

  await check('a build printing every leak shape: codes and our sentences only, no path anywhere', async () => {
    if (fs.existsSync(worktreesDir)) fs.chmodSync(worktreesDir, 0o755); // pruned once empty
    fs.writeFileSync(leaksFile, `${LEAKS.join('\n')}\n`);
    writeSiteFile('src/content/pages/home.md', '---\ntitle: Home\nlink: /home/elsewhere\n---\n');
    const mark = serverLog.length;
    const res = await publish('Edit home again');
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
    // Positive control: the whole leak text reached the server log.
    assertLogged(mark, ...LEAKS);
    assertNoServerPath('the 422 body', JSON.stringify(res.body));
    assert.deepEqual(res.body.check.problems.map((problem) => problem.code), ['InvalidContentEntryDataError', 'ImageNotFound']);
    // The id that is an entry of the commit is listed, with our validation;
    // the path-shaped id and the image path name nothing in the commit.
    assert.deepEqual(res.body.check.entries.map(({ collection, slug }) => ({ collection, slug })), [{ collection: 'pages', slug: 'home' }]);
    assert.deepEqual(res.body.check.entries[0].issues.map((issue) => issue.accepted), [['/home/about', '/home/contact']]);
  });

  // One at a time too: a single leak beside a real error line, so a cleaner
  // that hides the whole output when ANY line looks like a path cannot pass
  // by hiding the other lines' paths along with this one.
  await check('each leak shape on its own, beside a real Astro error line: no path in the body', async () => {
    const fullConfig = await getConfig();
    const leaked = [];
    const unlogged = [];
    for (const leak of LEAKS.slice(0, LEAKS.findIndex((line) => line.startsWith('[')))) {
      fs.writeFileSync(leaksFile, `[InvalidContentEntryDataError] pages → home data does not match collection schema.\n${leak}\n`);
      const mark = serverLog.length;
      const result = await checkHeadWithAstro(fullConfig);
      if (!serverLog.slice(mark).join('\n').includes(leak)) unlogged.push(leak);
      const body = JSON.stringify(await checkRefusalBody(result, { committed: true }));
      const sign = SERVER_PATH_SIGNS.find((candidate) => body.includes(candidate));
      if (sign) leaked.push(`${leak}\n      -> names "${sign}": ${body.slice(0, 400)}`);
    }
    assert.equal(leaked.length, 0, `${leaked.length} leaked:\n    ${leaked.join('\n    ')}`);
    // Positive control: each leak really was in the output (it is in the log).
    assert.deepEqual(unlogged, [], 'every leak reached the server log');
  });

  await check('publishFailureMessage: anything but a missing identity is a fixed message', async () => {
    const message = publishFailureMessage(new Error("fatal: Unable to create '/srv/git store/repo.git/index.lock': File exists."));
    assert.equal(message, 'Publishing failed; see the server log.');
  });

  report('='.repeat(40));
  report(`\n📊 ${passed} checks passed.\n`);
} finally {
  // `git worktree prune` removes the (empty) folder itself.
  if (fs.existsSync(worktreesDir)) fs.chmodSync(worktreesDir, 0o755);
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
