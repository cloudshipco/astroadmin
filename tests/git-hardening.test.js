/**
 * The admin's git runs none of the code a site repository can plant in its
 * own git config or hooks (#67). The site's code runs on the host (the
 * preview, the publish check's build, the content config), so it can write
 * `.git/hooks/*` and `.git/config`; the next git command from the admin would
 * then run that code with the deploy key.
 *
 * A fixture site has, each writing a marker file when it runs:
 *   - hooks: pre-commit, post-commit, post-checkout, post-merge, post-rewrite,
 *     pre-push, reference-transaction;
 *   - core.fsmonitor, a smudge/clean filter driver (on *.md), a textconv
 *     driver (on *.md), diff.external, commit.gpgSign with a gpg.program;
 *   - a merge driver (on *.md, from .git/info/attributes), the remote's
 *     uploadpack and receivepack programs (git keeps the first value, so
 *     these are overridden on the fetch and push command lines), and
 *     core.sshCommand, credential.helper, core.askPass and core.gitProxy,
 *     each reached by a push or fetch to an ssh://, http:// (a server that
 *     asks for credentials) or git:// URL;
 *   - log.showSignature with that gpg.program (a plain `git log` of a signed
 *     commit runs it to verify), and an `objects/info/alternates` file with a
 *     core.alternateRefsCommand (run by a fetch);
 *   - (last phase) protocol.ext.allow=always and an ext:: push URL.
 *
 * CONTROL first: the same plants in a copy of the fixture fire under plain
 * git (commit, checkout, worktree add, status, diff, pull, push, log), so a
 * clean result below is not a dead plant. Then through the real
 * createServer() app: save, status, diff, show, revert, publish (whose check
 * runs `git worktree add`), the commit route, and the history routes (log,
 * file-history, show) of a signed commit, with markers asserted absent after
 * each.
 * No --no-verify anywhere: hooks must be off because git is told so.
 *
 *   bun tests/git-hardening.test.js
 */

import assert from 'assert';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-git-hardening-')));
const remoteDir = path.join(tempRoot, 'remote.git');
const projectRoot = path.join(tempRoot, 'site');
const developerClone = path.join(tempRoot, 'developer');
const markers = path.join(tempRoot, 'markers');
const plants = path.join(tempRoot, 'plants');
fs.mkdirSync(markers);

// The test's own git: no hooks of its own, and never the planted config's
// effects where it sets things up (the developer clone has no plants).
const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
};
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8', env: cleanEnv() }).trim();
function writeFile(root, relativePath, content, mode) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  if (mode) fs.chmodSync(fullPath, mode);
}
const page = (title) => `---\ntitle: ${title}\n---\nText.\n`;

// --- The plants -------------------------------------------------------------

const HOOKS = ['pre-commit', 'post-commit', 'post-checkout', 'post-merge', 'post-rewrite', 'pre-push', 'reference-transaction'];
const plant = (name, body) => writeFile(plants, name, `#!/bin/sh\ntouch "${markers}/\${PLANT_TAG}${name}"\n${body}\n`, 0o755);
for (const hook of HOOKS) plant(`hook-${hook}`, 'cat > /dev/null 2>&1 || true\nexit 0');
plant('fsmonitor', 'exit 1');
plant('smudge', 'cat');
plant('clean', 'cat');
plant('textconv', 'cat "$1"');
plant('external-diff', 'exit 0');
// A signature git accepts: the status line on the status fd (2), armour on stdout.
plant('gpg', `cat > /dev/null
printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 X\\n' >&2
printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nx\\n-----END PGP SIGNATURE-----\\n'`);
plant('ext-transport', 'exit 1');
// Called as `<driver> %A %O %B`: a working three-way merge, so the control's rebase goes on.
plant('merge-driver', '/usr/bin/git merge-file "$1" "$2" "$3"');
// Called through a shell as `<program> '<repository path>'`: the real thing.
plant('upload-pack', 'exec /usr/bin/git upload-pack "$@"');
plant('receive-pack', 'exec /usr/bin/git receive-pack "$@"');
plant('ssh-command', 'exit 1');
plant('credential-helper', 'cat > /dev/null; exit 0');
plant('askpass', 'echo planted');
plant('git-proxy', 'exit 1');
// Run through a shell with the alternate's path; lists no refs.
plant('alternate-refs', 'exit 0');
// The other object store the site's alternates file names (empty).
const alternateStore = path.join(tempRoot, 'alternate.git');
execFileSync('/usr/bin/git', ['init', '-q', '--bare', alternateStore], { env: cleanEnv() });

/** Plant everything in a site checkout (its .git/hooks and .git/config). */
function plantInto(checkout, tag = '') {
  const hooksDir = git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const hook of HOOKS) {
    // Each hook calls its plant with the tag, so control markers are distinct.
    writeFile(hooksDir, hook, `#!/bin/sh\nPLANT_TAG='${tag}' exec "${plants}/hook-${hook}" "$@"\n`, 0o755);
  }
  // A plain path per plant (gpg.program is run without a shell).
  const wrap = (name) => {
    const wrapper = path.join(plants, `${tag}wrap-${name}`);
    writeFile(plants, `${tag}wrap-${name}`, `#!/bin/sh\nPLANT_TAG='${tag}' exec "${plants}/${name}" "$@"\n`, 0o755);
    return wrapper;
  };
  git(checkout, 'config', 'core.fsmonitor', wrap('fsmonitor'));
  git(checkout, 'config', 'filter.planted.smudge', wrap('smudge'));
  git(checkout, 'config', 'filter.planted.clean', wrap('clean'));
  git(checkout, 'config', 'diff.planted.textconv', wrap('textconv'));
  git(checkout, 'config', 'diff.external', wrap('external-diff'));
  git(checkout, 'config', 'commit.gpgSign', 'true');
  git(checkout, 'config', 'gpg.program', wrap('gpg'));
  // The filter and a merge driver, named by attributes kept out of the tree
  // (so the filter's can be dropped before the publish steps).
  writeFile(git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'info'), 'attributes', '*.md merge=planted filter=planted\n');
  git(checkout, 'config', 'merge.planted.driver', `${wrap('merge-driver')} %A %O %B`);
  // The programs run for a fetch and a push over a local path (or ssh).
  git(checkout, 'config', 'remote.origin.uploadpack', wrap('upload-pack'));
  git(checkout, 'config', 'remote.origin.receivepack', wrap('receive-pack'));
  // ssh, HTTP credentials and the git:// proxy.
  git(checkout, 'config', 'core.sshCommand', wrap('ssh-command'));
  git(checkout, 'config', 'credential.helper', wrap('credential-helper'));
  git(checkout, 'config', 'core.askPass', wrap('askpass'));
  git(checkout, 'config', 'core.gitProxy', wrap('git-proxy'));
  // Verifying a signature on `git log` runs gpg.program (the history routes).
  git(checkout, 'config', 'log.showSignature', 'true');
  // A fetch lists an alternate object store's refs with this command.
  writeFile(git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'objects/info'), 'alternates', `${path.join(alternateStore, 'objects')}\n`);
  git(checkout, 'config', 'core.alternateRefsCommand', wrap('alternate-refs'));
}

// An HTTPS remote that asks for credentials (and never accepts any). Its own
// process: the control runs git synchronously, which would block a server here.
const authServer = Bun.spawn(['bun', '-e', `
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="planted"' } }) });
  console.log(server.port);
`], { stdout: 'pipe' });
const authPort = await (async () => {
  const reader = authServer.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the HTTP server did not start');
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return Number(text.trim());
})();
const authUrl = `http://127.0.0.1:${authPort}/site.git`;
const fired = (tag = '') => fs.readdirSync(markers).filter((name) => (tag ? name.startsWith(tag) : !name.startsWith('control-'))).map((name) => name.slice(tag.length)).sort();
const clearMarkers = () => {
  for (const name of fs.readdirSync(markers)) fs.rmSync(path.join(markers, name));
};

// --- The site, its remote and a developer's clone ----------------------------

git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remoteDir);
fs.mkdirSync(projectRoot);
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeFile(projectRoot, '.gitignore', 'node_modules\n');
writeFile(projectRoot, '.gitattributes', '*.md diff=planted\n');
writeFile(projectRoot, 'package.json', JSON.stringify({ type: 'module' }));
writeFile(projectRoot, 'astro.config.mjs', 'export default {};\n');
writeFile(projectRoot, 'astroadmin.config.js',
  "export default { git: { enabled: true, paths: ['src/content/'], allowLocalRemote: true }, build: { check: 'true' } };\n");
writeFile(projectRoot, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeFile(projectRoot, 'src/content/pages/home.md', page('Home'));
writeFile(projectRoot, 'src/content/pages/about.md', page('About'));
// Long enough that a title edit and a last-line edit merge cleanly.
const MERGE_BODY = 'One.\n\nTwo.\n\nThree.\n\nFour.\n';
const mergePage = (title, body = MERGE_BODY) => `---\ntitle: ${title}\n---\n${body}`;
writeFile(projectRoot, 'src/content/pages/merge.md', mergePage('Merge'));
git(projectRoot, 'init', '-q', '-b', 'main');
git(projectRoot, 'config', 'user.name', 'Editor');
git(projectRoot, 'config', 'user.email', 'editor@example.com');
git(projectRoot, 'add', '-A');
git(projectRoot, 'commit', '-q', '-m', 'initial');
git(projectRoot, 'remote', 'add', 'origin', remoteDir);
git(projectRoot, 'push', '-q', '-u', 'origin', 'main');
git(tempRoot, 'clone', '-q', remoteDir, developerClone);
git(developerClone, 'config', 'user.name', 'Developer');
git(developerClone, 'config', 'user.email', 'developer@example.com');
function developerPushes(relativePath, content) {
  git(developerClone, 'pull', '-q', '--rebase');
  writeFile(developerClone, relativePath, content);
  git(developerClone, 'add', relativePath);
  git(developerClone, 'commit', '-qm', `developer: ${relativePath}`);
  git(developerClone, 'push', '-q');
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
  }
}

// --- Control: the plants are live under plain git ----------------------------

{
  const controlSite = path.join(tempRoot, 'control-site');
  git(tempRoot, 'clone', '-q', remoteDir, controlSite);
  git(controlSite, 'config', 'user.name', 'Control');
  git(controlSite, 'config', 'user.email', 'control@example.com');
  plantInto(controlSite, 'control-');
  // The plants' own git runs see none of the test's env either.
  const plain = (...args) => execFileSync('/usr/bin/git', args, { cwd: controlSite, encoding: 'utf-8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  writeFile(controlSite, 'src/content/pages/home.md', page('Home (control)'));
  plain('status', '--porcelain');
  plain('diff', 'HEAD');
  // diff.external wins over textconv; without it, textconv runs.
  plain('diff', '--no-ext-diff', 'HEAD');
  plain('add', '-A');
  plain('commit', '-q', '-m', 'control');
  plain('worktree', 'add', '-q', '--detach', path.join(tempRoot, 'control-worktree'), 'HEAD');
  developerPushes('src/content/pages/about.md', page('About (for control)'));
  // Both sides change merge.md, so the rebase merges it (the merge driver).
  writeFile(controlSite, 'src/content/pages/merge.md', mergePage('Merge (control)'));
  plain('commit', '-qam', 'control merge');
  developerPushes('src/content/pages/merge.md', mergePage('Merge', MERGE_BODY.replace('Four.', 'Four (developer).')));
  plain('pull', '-q', '--rebase');
  assert.match(fs.readFileSync(path.join(controlSite, 'src/content/pages/merge.md'), 'utf-8'), /Merge \(control\)[^]*Four \(developer\)/,
    'control: the planted merge driver merged both sides');
  // Transports that run a command of the repository's choosing.
  const failing = (...args) => {
    try {
      plain(...args);
    } catch {
      // each fails after its plant has run
    }
  };
  failing('push', '-q', 'ssh://127.0.0.1:1/site.git', 'HEAD:refs/heads/control');
  failing('fetch', '-q', 'git://127.0.0.1:1/site.git');
  // Async: the HTTP server is a child process, but a prompt must not block this one.
  await new Promise((resolve) => execFile('/usr/bin/git', ['push', '-q', authUrl, 'HEAD:refs/heads/control'],
    { cwd: controlSite, env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: '0' } }, () => resolve()));
  plain('push', '-q', 'origin', 'HEAD:refs/heads/control');
  developerPushes('src/content/pages/about.md', page('About (for control, 2)'));
  plain('fetch', '-q');
  plain('merge', '-q', '--no-edit', 'origin/main');
  plain('config', 'protocol.ext.allow', 'always');
  plain('remote', 'set-url', '--push', 'origin', `ext::sh -c ${path.join(plants, 'ext-transport').replaceAll(' ', '% ')}`);
  try {
    execFileSync('/usr/bin/git', ['push', '-q', 'origin', 'HEAD:refs/heads/control'], { cwd: controlSite, env: { ...cleanEnv(), PLANT_TAG: 'control-' }, stdio: 'ignore' });
  } catch {
    // the ext transport fails after it has run
  }
  await check('control: every plant fires under plain git', async () => {
    const expected = [
      ...HOOKS.map((hook) => `hook-${hook}`), 'fsmonitor', 'smudge', 'clean', 'textconv', 'external-diff', 'gpg', 'ext-transport',
      'merge-driver', 'upload-pack', 'receive-pack', 'ssh-command', 'credential-helper', 'askpass', 'git-proxy', 'alternate-refs',
    ].sort();
    assert.deepEqual(fired("control-"), expected, `fired: ${fired("control-").join(", ")}`);
  });
  clearMarkers();
  // The control's commits are signed (commit.gpgSign), so a plain log
  // verifies them: gpg.program runs for reading history, not only signing.
  plain('log', '-2');
  await check('control: a plain git log runs gpg.program to verify a signed commit', async () => {
    assert.deepEqual(fired('control-'), ['gpg'], `fired: ${fired('control-').join(', ')}`);
  });
  clearMarkers();
  git(remoteDir, 'update-ref', '-d', 'refs/heads/control');
}

// --- Through the app ---------------------------------------------------------

plantInto(projectRoot);
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'true';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin', Origin: base };

try {
  console.log('\n🧪 Planted git code does not run\n' + '='.repeat(40));
  const loginResponse = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sameOrigin },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(loginResponse.status, 200, 'login');
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const request = async (method, route, payload) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', ...sameOrigin },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  const save = (slug, title) => request('POST', `/api/content/pages/${slug}`, { data: { title }, body: 'Text.\n', type: 'content' });
  /** Run a step, assert it did what it should (positive control), and that nothing fired. */
  const step = (name, run, positive) => check(`${name}: nothing planted runs`, async () => {
    clearMarkers();
    const result = await run();
    await positive(result);
    assert.deepEqual(fired(), [], `planted code ran during ${name}: ${fired().join(", ")}`);
  });

  await step('save, then status', async () => {
    assert.equal((await save('home', 'Home (edited)')).status, 200);
    // Make the index stale for the file, so status must re-read it (the
    // clean filter and fsmonitor are consulted).
    const file = path.join(projectRoot, 'src/content/pages/home.md');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    return request('GET', '/api/git/status');
  }, ({ status, body }) => {
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.status.modified.includes('src/content/pages/home.md'), JSON.stringify(body.status));
  });

  await step('diff', () => request('GET', '/api/git/diff?file=src/content/pages/home.md'), ({ status, body }) => {
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(body.diff, /\+title: Home \(edited\)/);
  });

  // diff.external wins over textconv, so textconv is checked without it.
  await step('diff with only a textconv driver', () => {
    git(projectRoot, 'config', '--unset', 'diff.external');
    return request('GET', '/api/git/diff?file=src/content/pages/home.md');
  }, ({ status, body }) => {
    git(projectRoot, 'config', 'diff.external', path.join(plants, 'wrap-external-diff'));
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(body.diff, /\+title: Home \(edited\)/);
  });

  await step('show',() => request('GET', '/api/git/show?file=src/content/pages/about.md'), ({ status, body }) => {
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(body.content, /title: About/);
  });

  await step('revert a file', async () => {
    assert.equal((await save('about', 'About (to revert)')).status, 200);
    return request('POST', '/api/git/revert-file', { file: 'src/content/pages/about.md' });
  }, ({ status, body }) => {
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(fs.readFileSync(path.join(projectRoot, 'src/content/pages/about.md'), 'utf-8'), /title: About\n/);
  });

  // A site whose files go through a filter is not published at all (its
  // bytes are not what git would store with the driver switched off):
  // tests/publish-filters.test.js. The rest publish with the filter attribute
  // gone and its driver still configured.
  await step('publish while a filter driver is in use (refused)', () => request('POST', '/api/publish', { message: 'Refused' }), ({ status, body }) => {
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.committed, false, JSON.stringify(body));
    writeFile(git(projectRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'info'), 'attributes', '*.md merge=planted\n');
  });

  await step('publish (commit, pull --rebase onto a moved remote, check worktree, push)', async () => {
    developerPushes('src/content/pages/about.md', page('About (developer)'));
    return request('POST', '/api/publish', { message: 'Content update' });
  }, ({ status, body }) => {
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(git(remoteDir, 'rev-parse', 'main'), git(projectRoot, 'rev-parse', 'HEAD'), 'pushed');
    assert.match(git(remoteDir, 'show', 'main:src/content/pages/home.md'), /Home \(edited\)/);
    assert.match(git(remoteDir, 'show', 'main:src/content/pages/about.md'), /About \(developer\)/, 'rebased onto the developer');
  });

  await step('publish with a three-way merge in the rebase (merge driver)', async () => {
    const mergeFile = 'src/content/pages/merge.md';
    git(developerClone, 'pull', '-q', '--rebase');
    developerPushes(mergeFile, fs.readFileSync(path.join(developerClone, mergeFile), 'utf-8').replace('One.', 'One (developer).'));
    // The editor keeps the body it has and changes the title.
    const body = fs.readFileSync(path.join(projectRoot, mergeFile), 'utf-8').split('---\n').slice(2).join('---\n');
    const saved = await request('POST', '/api/content/pages/merge', { data: { title: 'Merge (editor)' }, body, type: 'content' });
    assert.equal(saved.status, 200);
    return request('POST', '/api/publish', { message: 'Merge update' });
  }, ({ status, body }) => {
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(git(remoteDir, 'show', 'main:src/content/pages/merge.md'), /Merge \(editor\)[^]*One \(developer\)/,
      'both sides merged, by git itself');
  });

  /** Publish with the remote at `url` (push only, or fetch and push), then put it back. */
  const publishVia = async (url, { fetchToo = false } = {}) => {
    const key = fetchToo ? 'remote.origin.url' : 'remote.origin.pushurl';
    git(projectRoot, 'config', key, url);
    try {
      assert.equal((await save('home', `Home (${url})`)).status, 200);
      return await request('POST', '/api/publish', { message: `Push to ${url}` });
    } finally {
      if (fetchToo) git(projectRoot, 'config', key, remoteDir);
      else git(projectRoot, 'config', '--unset', key);
    }
  };
  const notPublished = ({ status, body }) => assert.equal(status, 502, JSON.stringify(body));

  await step('a push over ssh (core.sshCommand)', () => publishVia('ssh://127.0.0.1:1/site.git'), notPublished);
  await step('a push over HTTP asking for credentials (credential.helper, core.askPass)', () => publishVia(authUrl), notPublished);
  await step('a fetch and push over git:// (core.gitProxy)', () => publishVia('git://127.0.0.1:1/site.git', { fetchToo: true }), notPublished);

  await step('the commit route (commit, rebase onto a moved remote, push)', async () => {
    developerPushes('src/content/pages/about.md', page('About (developer 2)'));
    assert.equal((await save('home', 'Home (committed)')).status, 200);
    return request('POST', '/api/git/commit', { message: 'Content commit' });
  }, ({ status, body }) => {
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(git(remoteDir, 'show', 'main:src/content/pages/home.md'), /Home \(committed\)/);
    assert.match(git(remoteDir, 'show', 'main:src/content/pages/about.md'), /About \(developer 2\)/, 'rebased onto the developer');
  });

  await step('a push to an ext:: URL the site config allows', async () => {
    git(projectRoot, 'config', 'protocol.ext.allow', 'always');
    git(projectRoot, 'remote', 'set-url', '--push', 'origin', `ext::sh -c ${path.join(plants, 'ext-transport').replaceAll(' ', '% ')}`);
    assert.equal((await save('home', 'Home (ext)')).status, 200);
    return request('POST', '/api/publish', { message: 'Ext push' });
  }, ({ status, body }) => {
    // The push is refused, so the editor is told it is not live.
    assert.equal(status, 502, JSON.stringify(body));
  });

  // A signed commit in the history (signed by plain git, with the planted
  // gpg.program: its markers are cleared when the step starts).
  writeFile(projectRoot, 'src/content/pages/about.md', page('About (signed)'));
  git(projectRoot, 'commit', '-q', '-S', '-m', 'signed', '--', 'src/content/pages/about.md');
  const signedCommit = git(projectRoot, 'rev-parse', 'HEAD');
  assert.match(git(projectRoot, 'cat-file', 'commit', signedCommit), /^gpgsig /m, 'the commit is signed');

  await step('history of a signed commit (log, file-history, show)', async () => ({
    log: await request('GET', '/api/git/log'),
    fileHistory: await request('GET', '/api/git/file-history?file=src/content/pages/about.md'),
    show: await request('GET', `/api/git/show?commit=${signedCommit}&file=src/content/pages/about.md`),
  }), ({ log, fileHistory, show }) => {
    assert.equal(log.status, 200, JSON.stringify(log.body));
    assert.equal(log.body.commits[0]?.hash, signedCommit, `the log lists the signed commit: ${JSON.stringify(log.body.commits[0])} (fired: ${fired().join(', ')})`);
    assert.equal(fileHistory.status, 200, JSON.stringify(fileHistory.body));
    assert.equal(fileHistory.body.commits[0].hash, signedCommit, 'the file history lists the signed commit');
    assert.equal(show.status, 200, JSON.stringify(show.body));
    assert.match(show.body.content, /About \(signed\)/);
  });

  console.log(`\n📊 ${passed} passed, ${failed} failed.`);
} catch (error) {
  console.error(error);
  failed++;
} finally {
  server.close();
  authServer.kill();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.exitCode = failed > 0 ? 1 : 0;
