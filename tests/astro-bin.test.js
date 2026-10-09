/**
 * The default build commands run the site's OWN installed astro, never one a
 * package runner fetches.
 *
 * `bunx --bun astro ...` (even with --no-install) runs an astro from the
 * registry or Bun's global cache when the site has none installed, and the
 * publish check runs on every publish, on the host, as the site's user. A fake
 * `bunx` (and `npx`) first on PATH records any call, so a fetch path that is
 * taken shows up as a log line rather than as network traffic.
 *
 * Asserts:
 *   - with no astro installed, the publish check and the production build
 *     refuse with a clear message and run no package runner;
 *   - with astro installed but no node_modules/.bin, the check builds with it
 *     (positive control: the build really ran and wrote HTML);
 *   - a configured command is left alone;
 *   - the default command quotes paths and keeps `--outDir dist` readable.
 *
 *   bun tests/astro-bin.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-astro-bin-'));
const fakeBinDir = path.join(tempRoot, 'fake-bin');
const runnerLog = path.join(tempRoot, 'runner.log');

// Must be set before config loads, hence the dynamic imports below.
process.env.ASTROADMIN_PROJECT_ROOT = path.join(tempRoot, 'unused');
fs.mkdirSync(process.env.ASTROADMIN_PROJECT_ROOT);

fs.mkdirSync(fakeBinDir);
for (const runner of ['bunx', 'npx']) {
  const script = path.join(fakeBinDir, runner);
  fs.writeFileSync(script, `#!/bin/sh\necho "${runner} $*" >> '${runnerLog}'\nexit 97\n`);
  fs.chmodSync(script, 0o755);
}
process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH}`;
const runnerCalls = () => (fs.existsSync(runnerLog) ? fs.readFileSync(runnerLog, 'utf-8').trim() : '');

const { getConfig } = await import('../server/config.js');
const { checkHeadWithAstro } = await import('../server/utils/astro-check.js');
const { defaultAstroCommand, findAstroExecutable, shellQuote, ASTRO_NOT_INSTALLED_MESSAGE } = await import('../server/utils/astro-bin.js');

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function makeSite(name) {
  const site = path.join(tempRoot, name);
  fs.mkdirSync(site);
  git(site, 'init', '-q', '-b', 'main');
  git(site, 'config', 'user.email', 'test@example.com');
  git(site, 'config', 'user.name', 'Test');
  writeFile(site, 'package.json', JSON.stringify({ type: 'module' }));
  writeFile(site, 'astro.config.mjs', 'export default {};\n');
  writeFile(site, '.gitignore', 'node_modules\n.astro\ndist\n');
  writeFile(site, 'src/pages/index.astro', '<html><body><h1>built-by-the-site-astro</h1></body></html>\n');
  git(site, 'add', '-A');
  git(site, 'commit', '-q', '-m', 'site');
  return site;
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failures++;
    console.error(`❌ ${name}\n   ${error.message}`);
  }
}

// The positive control for the fake runners: they are on PATH and log.
await check('the fake package runner is first on PATH and records calls', async () => {
  execFileSync('/bin/sh', ['-c', 'bunx --bun astro --version || true'], { env: { ...process.env } });
  assert.match(runnerCalls(), /^bunx --bun astro --version$/m);
  fs.rmSync(runnerLog);
});

const bare = makeSite('bare');

await check('the publish check refuses when the site has no astro, and runs no package runner', async () => {
  const fullConfig = await getConfig();
  const result = await checkHeadWithAstro({ ...fullConfig, paths: { ...fullConfig.paths, projectRoot: bare } });
  assert.equal(runnerCalls(), '', `a package runner was spawned: ${runnerCalls()}`);
  assert.equal(result.success, false);
  assert.ok(result.output.includes(ASTRO_NOT_INSTALLED_MESSAGE), `refusal names the cause: ${result.output}`);
  assert.ok(!result.output.includes(tempRoot), 'no server path in the refusal');
});

await check('the production build refuses when the site has no astro, and runs no package runner', async () => {
  const { runProductionBuildIn } = await import('../server/utils/build.js');
  const fullConfig = await getConfig();
  const result = await runProductionBuildIn(fullConfig, bare);
  assert.equal(runnerCalls(), '', `a package runner was spawned: ${runnerCalls()}`);
  assert.equal(result.success, false);
  assert.ok(`${result.error}`.includes(ASTRO_NOT_INSTALLED_MESSAGE), `refusal names the cause: ${result.error}`);
});

await check('the default config names no command, so only a configured one counts as custom', async () => {
  const fullConfig = await getConfig();
  assert.equal(fullConfig.build.production, null);
  assert.equal(fullConfig.build.staging, null);
});

// astro installed as a package, but no node_modules/.bin: the case where
// bunx fetched even though the site had astro.
const installed = makeSite('installed');
fs.mkdirSync(path.join(installed, 'node_modules'));
fs.symlinkSync(path.join(repoRoot, 'node_modules', 'astro'), path.join(installed, 'node_modules', 'astro'), 'dir');

await check('the publish check builds with the installed astro when node_modules/.bin is missing', async () => {
  const fullConfig = await getConfig();
  let builtHtml = null;
  const result = await checkHeadWithAstro(
    { ...fullConfig, paths: { ...fullConfig.paths, projectRoot: installed } },
    {
      onBuilt: async ({ siteDir, command }) => {
        assert.ok(command.includes(fs.realpathSync(path.join(repoRoot, 'node_modules', 'astro'))), `runs the installed astro: ${command}`);
        assert.ok(command.includes('--no-install'), command);
        builtHtml = fs.readFileSync(path.join(siteDir, 'dist', 'index.html'), 'utf-8');
      },
    },
  );
  assert.equal(runnerCalls(), '', `a package runner was spawned: ${runnerCalls()}`);
  assert.equal(result.success, true, result.output);
  assert.ok(builtHtml && builtHtml.includes('built-by-the-site-astro'), 'the build ran and wrote the page');
});

await check('a configured check command is left alone', async () => {
  const fullConfig = await getConfig();
  const result = await checkHeadWithAstro({ ...fullConfig, paths: { ...fullConfig.paths, projectRoot: bare }, build: { check: 'echo custom-check' } });
  assert.equal(result.success, true, result.output);
  assert.equal(result.output, 'custom-check');
});

await check('the default command quotes paths and keeps its fixed arguments plain', async () => {
  const awkward = path.join(tempRoot, "it's a site");
  fs.mkdirSync(path.join(awkward, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'node_modules', 'astro'), path.join(awkward, 'node_modules', 'astro'), 'dir');
  const astroBin = await findAstroExecutable(awkward);
  assert.ok(astroBin);
  const command = await defaultAstroCommand(awkward, ['build', '--outDir', 'dist']);
  assert.ok(command.endsWith(` --no-install --bun ${shellQuote(astroBin)} build --outDir dist`), command);
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`);
  assert.equal(shellQuote('/plain/path-1.2/astro.mjs'), '/plain/path-1.2/astro.mjs');
  assert.equal(await defaultAstroCommand(bare, ['build']), null);
  const quoted = await defaultAstroCommand(awkward, ['build', '--outDir', "out dir's"]);
  assert.ok(quoted.endsWith(` --outDir 'out dir'\\''s'`), quoted);
});

fs.rmSync(tempRoot, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll astro-bin tests passed');
