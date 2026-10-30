/**
 * Other repositories the admin's git can reach run none of their own code.
 * The `-c` overrides in git-exec.js reach the admin's git process and its
 * children, but not every repository git opens on the way:
 *
 * 1. A remote that is a local path (or a file:// URL): git runs that
 *    repository's receive-pack on this host, and the local transport clears
 *    GIT_CONFIG_PARAMETERS, so its hooks (pre-receive, ...) run. The admin
 *    refuses a local remote unless the site's config says `git:
 *    { allowLocalRemote: true }` (then the remote's hooks are the
 *    operator's choice, and they run: asserted, so the opt-in is not
 *    mistaken for protection).
 * 2. A submodule's repository: the publish fetch recursed into it "on
 *    demand" (whenever fetched commits move a gitlink it knows, even one no
 *    longer in HEAD) and ran ITS remote's uploadpack; `git status` and a
 *    working-tree `git diff` ran ITS clean filter on a stat-dirty file, even
 *    with diff.ignoreSubmodules=all (a submodule.<name>.ignore in the
 *    repository's config outranks that). So every fetch passes
 *    --no-recurse-submodules, status and diffs --ignore-submodules=all, and
 *    commit and publish refuse a checkout whose index holds a gitlink
 *    before any other git work (`git add -A` runs a submodule's filter too).
 *
 * Each plant writes a marker; a CONTROL per plant shows it fires under plain
 * git. The pushes and fetch run through pushIfAstroAccepts/commitInCheckout
 * with explicit configs; the submodule site runs through the real
 * createServer() app (status, diff, commit, publish).
 *
 *   bun tests/git-nested-repos.test.js     (~5 s)
 */

import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-git-nested-')));
const markers = path.join(tempRoot, 'markers');
fs.mkdirSync(markers);

const cleanEnv = () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL') delete env[key];
  return env;
};
// The test's own git may use local transports (setting up remotes and submodules).
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf-8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => spawnSync('/usr/bin/git', ['-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf-8', env: cleanEnv() });
function writeFile(root, relativePath, content, mode) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  if (mode) fs.chmodSync(fullPath, mode);
}
const marker = (name) => path.join(markers, name);
/** Whether `name`'s plant ran since the last call (and forget it). */
const ran = (name) => {
  const fired = fs.existsSync(marker(name));
  fs.rmSync(marker(name), { force: true });
  return fired;
};
const identity = (dir, name) => {
  git(dir, 'config', 'user.name', name);
  git(dir, 'config', 'user.email', `${name.toLowerCase()}@example.com`);
};
function newRepo(name) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  identity(dir, name);
  return dir;
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

// The app (section 2b) serves the submodule site; config.js reads this on import.
process.env.ASTROADMIN_PROJECT_ROOT = path.join(tempRoot, 'sub-site');
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'true';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;
const { commitConfiguredPaths, commitInCheckout, createGitClient, pushIfAstroAccepts } = await import('../server/api/publish.js');

/** A config for the functions, as getConfig() would give it. */
const configFor = (projectRoot, git = {}) => ({
  paths: { projectRoot },
  build: { check: 'true' },
  doctor: { enabled: false },
  git: { enabled: true, paths: ['src/'], ...git },
});
/** Commit a new file in the site and push it as Publish does. */
async function publish(site, fullConfig, name) {
  writeFile(site, `src/${name}.md`, `${name}\n`);
  const client = createGitClient(fullConfig);
  return pushIfAstroAccepts(fullConfig, client, {
    commit: async () => {
      await client.add(['--', `src/${name}.md`]);
      return client.commit(name, [`src/${name}.md`]);
    },
  });
}

try {
  console.log('\n🧪 Repositories beside the site run none of their code\n' + '='.repeat(40));

  // --- 1. A local remote ---------------------------------------------------
  const remote = path.join(tempRoot, 'remote.git');
  git(tempRoot, 'init', '-q', '--bare', '-b', 'main', remote);
  writeFile(remote, 'hooks/pre-receive', `#!/bin/sh\ncat > /dev/null\ntouch "${marker('pre-receive')}"\nexit 0\n`, 0o755);
  const site = newRepo('site');
  writeFile(site, 'src/home.md', 'home\n');
  git(site, 'add', '-A');
  git(site, 'commit', '-qm', 'initial');
  git(site, 'remote', 'add', 'origin', remote);
  git(site, 'push', '-q', '-u', 'origin', 'main');

  await check('control: a plain push to a local remote runs its pre-receive hook', async () => {
    assert.ok(ran('pre-receive'), 'the hook ran for the setup push');
  });

  await check('a local-path remote is refused without git.allowLocalRemote (nothing of its runs)', async () => {
    const before = git(remote, 'rev-parse', 'main');
    const outcome = await publish(site, configFor(site), 'refused');
    assert.equal(outcome.pushed, false, JSON.stringify(outcome));
    assert.ok(outcome.pushError, 'reported as a failed push');
    assert.equal(outcome.check?.success, true, 'the check itself passed (positive control: it got as far as the push)');
    assert.equal(git(remote, 'rev-parse', 'main'), before, 'nothing reached the remote');
    assert.equal(ran('pre-receive'), false, "the remote's hook did not run");
  });

  await check('a file:// remote is refused the same way', async () => {
    git(site, 'remote', 'set-url', 'origin', `file://${remote}`);
    try {
      const before = git(remote, 'rev-parse', 'main');
      const outcome = await publish(site, configFor(site), 'refused-url');
      assert.equal(outcome.pushed, false, JSON.stringify(outcome));
      assert.equal(git(remote, 'rev-parse', 'main'), before, 'nothing reached the remote');
      assert.equal(ran('pre-receive'), false, "the remote's hook did not run");
    } finally {
      git(site, 'remote', 'set-url', 'origin', remote);
    }
  });

  await check("with git.allowLocalRemote the push goes through (and the remote's own hooks run)", async () => {
    const outcome = await publish(site, configFor(site, { allowLocalRemote: true }), 'allowed');
    assert.equal(outcome.pushed, true, JSON.stringify(outcome));
    assert.equal(git(remote, 'rev-parse', 'main'), git(site, 'rev-parse', 'HEAD'), 'pushed');
    assert.ok(ran('pre-receive'), "the opt-in lets the remote's hooks run: it is the operator's choice");
  });

  await check("the repository's own protocol.file.allow=always does not opt in", async () => {
    git(site, 'config', 'protocol.file.allow', 'always');
    git(site, 'config', 'protocol.allow', 'always');
    try {
      const outcome = await publish(site, configFor(site), 'repo-opt-in');
      assert.equal(outcome.pushed, false, JSON.stringify(outcome));
      assert.equal(ran('pre-receive'), false, "the remote's hook did not run");
    } finally {
      git(site, 'config', '--unset', 'protocol.file.allow');
      git(site, 'config', '--unset', 'protocol.allow');
    }
  });

  // --- 2a. The fetch recursing into a submodule ------------------------------
  // The checkout once had a submodule (its repository is still in
  // .git/modules) and has since removed it; a developer moves the gitlink
  // upstream. Fetching that commit recursed "on demand" into the kept
  // submodule repository and ran its remote's uploadpack.
  const lib = newRepo('lib');
  writeFile(lib, 'f.txt', 'f\n');
  git(lib, 'add', '-A');
  git(lib, 'commit', '-qm', 'lib');
  const subRemote = path.join(tempRoot, 'sub-remote.git');
  git(tempRoot, 'init', '-q', '--bare', '-b', 'main', subRemote);
  writeFile(tempRoot, 'upload-pack', `#!/bin/sh\ntouch "${marker('submodule-upload-pack')}"\nexec git-upload-pack "$@"\n`, 0o755);
  const makeFetchSite = (name) => {
    const dir = newRepo(name);
    writeFile(dir, 'src/a.md', 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'initial');
    git(dir, 'submodule', 'add', '-q', lib, 'lib');
    git(dir, 'commit', '-qm', 'submodule');
    return dir;
  };
  const fetchSite = makeFetchSite('fetch-site');
  git(fetchSite, 'remote', 'add', 'origin', subRemote);
  git(fetchSite, 'push', '-q', '-u', 'origin', 'main');
  const developer = path.join(tempRoot, 'developer');
  git(tempRoot, 'clone', '-q', '--recurse-submodules', subRemote, developer);
  identity(developer, 'Developer');
  writeFile(lib, 'f.txt', 'f2\n');
  git(lib, 'commit', '-qam', 'lib 2');
  git(path.join(developer, 'lib'), 'pull', '-q', 'origin', 'main');
  git(developer, 'commit', '-qam', 'bump the submodule');
  git(developer, 'push', '-q');
  git(fetchSite, 'rm', '-q', 'lib');
  git(fetchSite, 'commit', '-qm', 'drop the submodule');
  // (Its core.worktree is gone, so the file is written directly.)
  const keptModuleConfig = path.join(fetchSite, '.git/modules/lib/config');
  git(tempRoot, 'config', '--file', keptModuleConfig, 'remote.origin.uploadpack', path.join(tempRoot, 'upload-pack'));
  git(tempRoot, 'config', '--file', keptModuleConfig, 'protocol.file.allow', 'always');
  // The control: a copy of the checkout, fetched with plain git.
  const controlFetch = path.join(tempRoot, 'control-fetch-site');
  fs.cpSync(fetchSite, controlFetch, { recursive: true });
  await check("control: a plain fetch recurses into the kept submodule and runs its remote's uploadpack", async () => {
    git(controlFetch, 'fetch', '-q', 'origin', 'main');
    assert.ok(ran('submodule-upload-pack'));
  });
  await check("the publish fetch does not recurse into a submodule's repository", async () => {
    const remoteHead = git(subRemote, 'rev-parse', 'main');
    await commitInCheckout(createGitClient(configFor(fetchSite, { allowLocalRemote: true })), null, { rebase: () => true });
    assert.equal(git(fetchSite, 'rev-parse', 'FETCH_HEAD'), remoteHead, 'positive control: the fetch ran');
    assert.equal(ran('submodule-upload-pack'), false, "the submodule's uploadpack ran");
  });

  // --- 2b. A site with a submodule, through the app --------------------------
  const subSite = newRepo('sub-site');
  writeFile(subSite, '.gitignore', 'node_modules\n');
  writeFile(subSite, 'package.json', JSON.stringify({ type: 'module' }));
  writeFile(subSite, 'astro.config.mjs', 'export default {};\n');
  writeFile(subSite, 'astroadmin.config.js',
    "export default { git: { enabled: true, paths: ['src/content/'], allowLocalRemote: true }, build: { check: 'true' }, doctor: { enabled: false } };\n");
  writeFile(subSite, 'src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
  fs.symlinkSync(path.resolve(import.meta.dir, '..', 'node_modules'), path.join(subSite, 'node_modules'), 'dir');
  writeFile(subSite, 'src/content/pages/home.md', '---\ntitle: Home\n---\nText.\n');
  git(subSite, 'add', '-A');
  git(subSite, 'commit', '-qm', 'initial');
  // A submodule inside the git paths, with a clean filter on its files.
  const filtered = newRepo('filtered-lib');
  writeFile(filtered, 'f.txt', 'f\n');
  writeFile(filtered, '.gitattributes', '*.txt filter=planted\n');
  git(filtered, 'add', '-A');
  git(filtered, 'commit', '-qm', 'lib');
  git(subSite, 'submodule', 'add', '-q', filtered, 'src/content/lib');
  git(subSite, 'commit', '-qm', 'submodule');
  // Its own config; and the site's says the submodule is never ignored, which
  // outranks diff.ignoreSubmodules.
  git(path.join(subSite, 'src/content/lib'), 'config', 'filter.planted.clean', `touch "${marker('submodule-clean')}"; cat`);
  git(subSite, 'config', 'submodule.src/content/lib.ignore', 'none');
  const subRemoteForSite = path.join(tempRoot, 'sub-site-remote.git');
  git(tempRoot, 'init', '-q', '--bare', '-b', 'main', subRemoteForSite);
  git(subSite, 'remote', 'add', 'origin', subRemoteForSite);
  git(subSite, 'push', '-q', '-u', 'origin', 'main');
  // Stat-dirty, same size, so git must read the file (through the filter).
  let flip = 0;
  const dirtySubmoduleFile = () => {
    const file = path.join(subSite, 'src/content/lib/f.txt');
    fs.writeFileSync(file, flip++ % 2 ? 'g\n' : 'h\n');
    const later = new Date(Date.now() + 10000 * flip);
    fs.utimesSync(file, later, later);
  };
  await check("control: plain git status and diff run a submodule's clean filter", async () => {
    dirtySubmoduleFile();
    git(subSite, 'status', '--porcelain');
    assert.ok(ran('submodule-clean'), 'status');
    dirtySubmoduleFile();
    git(subSite, 'diff', 'HEAD', '--', 'src/content/');
    assert.ok(ran('submodule-clean'), 'diff');
  });

  const { createServer } = await import('../server/index.js');
  const { app } = await createServer();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sameOrigin = { 'Sec-Fetch-Site': 'same-origin', Origin: base };
  try {
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
    const save = (title) => request('POST', '/api/content/pages/home', { data: { title }, body: 'Text.\n', type: 'content' });

    await check("git status does not run a submodule's clean filter", async () => {
      assert.equal((await save('Home (edited)')).status, 200);
      dirtySubmoduleFile();
      const { status, body } = await request('GET', '/api/git/status');
      assert.equal(status, 200, JSON.stringify(body));
      assert.ok(body.status.modified.includes('src/content/pages/home.md'), JSON.stringify(body.status));
      assert.equal(ran('submodule-clean'), false, "the submodule's clean filter ran");
    });

    await check("the diff of the git paths does not run a submodule's clean filter", async () => {
      dirtySubmoduleFile();
      const { status, body } = await request('GET', '/api/git/diff');
      assert.equal(status, 200, JSON.stringify(body));
      assert.match(body.diff, /\+title: Home \(edited\)/);
      assert.equal(ran('submodule-clean'), false, "the submodule's clean filter ran");
    });

    await check('publishing a site with a submodule is refused before anything is staged', async () => {
      dirtySubmoduleFile();
      const head = git(subSite, 'rev-parse', 'HEAD');
      const { status, body } = await request('POST', '/api/publish', { message: 'Refused' });
      assert.equal(status, 409, JSON.stringify(body));
      assert.equal(body.committed, false);
      assert.match(body.message, /submodule/);
      assert.equal(git(subSite, 'rev-parse', 'HEAD'), head, 'nothing committed');
      assert.equal(git(subSite, 'diff', '--cached', '--name-only'), '', 'nothing staged');
      assert.equal(ran('submodule-clean'), false, "the submodule's clean filter ran");
    });

    await check('the commit route refuses it too', async () => {
      dirtySubmoduleFile();
      const head = git(subSite, 'rev-parse', 'HEAD');
      assert.equal((await save('Home (to commit)')).status, 200);
      const { status, body } = await request('POST', '/api/git/commit', { message: 'Refused' });
      assert.equal(status, 409, JSON.stringify(body));
      assert.equal(git(subSite, 'rev-parse', 'HEAD'), head, 'nothing committed');
      assert.equal(ran('submodule-clean'), false, "the submodule's clean filter ran");
    });
  } finally {
    server.close();
  }

  // --- 3. An untracked repository inside the git paths ----------------------
  // `git add -A -- src/content/` turns it into a gitlink; committed, every
  // later publish is refused for a submodule. Staging is checked and the
  // commit refused, with the gitlink unstaged.
  const nestedSite = newRepo('nested-site');
  writeFile(nestedSite, 'src/content/a.md', 'a\n');
  git(nestedSite, 'add', '-A');
  git(nestedSite, 'commit', '-qm', 'initial');
  const nestedRemote = path.join(tempRoot, 'nested-site-remote.git');
  git(tempRoot, 'init', '-q', '--bare', '-b', 'main', nestedRemote);
  git(nestedSite, 'remote', 'add', 'origin', nestedRemote);
  git(nestedSite, 'push', '-q', '-u', 'origin', 'main');
  const inner = path.join(nestedSite, 'src/content/nested');
  fs.mkdirSync(inner, { recursive: true });
  git(inner, 'init', '-q', '-b', 'main');
  identity(inner, 'Inner');
  writeFile(inner, 'f.txt', 'f\n');
  git(inner, 'add', '-A');
  git(inner, 'commit', '-qm', 'inner');
  const nestedConfig = configFor(nestedSite, { paths: ['src/content/'], allowLocalRemote: true });
  const gitlinksStaged = () => git(nestedSite, 'ls-files', '--stage').split('\n').filter((line) => line.startsWith('160000'));
  const commitPaths = (client) => async () => (await commitConfiguredPaths(nestedConfig, client, 'Nested')).result;

  for (const route of ['publish', 'the commit route']) {
    await check(`${route}: a repository nested in the git paths is not committed as a submodule`, async () => {
      writeFile(nestedSite, 'src/content/a.md', `a (${route})\n`);
      const head = git(nestedSite, 'rev-parse', 'HEAD');
      const client = createGitClient(nestedConfig);
      const outcome = route === 'publish'
        ? await pushIfAstroAccepts(nestedConfig, client, { commit: commitPaths(client) })
        : await commitInCheckout(client, commitPaths(client));
      assert.equal(outcome.blocked, true, JSON.stringify(outcome));
      assert.equal(outcome.blockedReason, 'submodules');
      assert.equal(outcome.commitResult, null);
      assert.equal(git(nestedSite, 'rev-parse', 'HEAD'), head, 'nothing committed');
      assert.deepEqual(gitlinksStaged(), [], 'the gitlink is unstaged');
      assert.equal(git(nestedRemote, 'rev-parse', 'main'), head, 'nothing pushed');
    });
  }

  await check('with the nested repository gone, the next publish goes through (the site is not stuck)', async () => {
    fs.rmSync(inner, { recursive: true, force: true });
    const client = createGitClient(nestedConfig);
    const outcome = await pushIfAstroAccepts(nestedConfig, client, { commit: commitPaths(client) });
    assert.equal(outcome.pushed, true, JSON.stringify(outcome));
    assert.equal(git(nestedRemote, 'show', 'main:src/content/a.md'), 'a (the commit route)');
    assert.equal(git(nestedSite, 'ls-tree', '-r', 'HEAD').includes('160000'), false);
  });

  console.log(`\n📊 ${passed} passed, ${failed} failed.`);
} catch (error) {
  console.error(error);
  failed++;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.exitCode = failed > 0 ? 1 : 0;
