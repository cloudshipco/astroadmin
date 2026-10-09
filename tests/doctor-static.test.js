/**
 * astroadmin doctor: the static checks (site setup and publish-check blockers).
 *
 * Each check runs against a throwaway git repo whose astro.config has the shape
 * a hosted site uses (the integration among others, vite.server.allowedHosts
 * and hmr: false), then against a mutated copy that must turn it red.
 *
 *   bun tests/doctor-static.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDoctor, DOCTOR_CHECKS } from '../server/doctor/index.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-static-'));

const HOSTED_CONFIG = `import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import astroadmin from 'astroadmin/integration';

export default defineConfig({
  site: 'https://www.example.com',
  output: 'static',
  integrations: [astroadmin(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts: ['.admin.example.com', 'localhost'],
      hmr: false,
    },
  },
});
`;

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

let siteCounter = 0;
/** A committed site; `mutate(siteDir)` runs before the commit. */
function makeSite(mutate = () => {}) {
  const siteDir = path.join(tempRoot, `site-${++siteCounter}`);
  fs.mkdirSync(siteDir);
  writeFile(siteDir, 'package.json', JSON.stringify({ name: 'example-site', type: 'module' }));
  writeFile(siteDir, 'astro.config.mjs', HOSTED_CONFIG);
  writeFile(siteDir, 'bun.lock', '{ "lockfileVersion": 1 }\n');
  writeFile(siteDir, '.gitignore', 'node_modules\ndist\n');
  writeFile(siteDir, 'src/pages/index.astro', '<h1>Home</h1>\n');
  git(siteDir, 'init', '-q', '-b', 'main');
  git(siteDir, 'config', 'user.name', 'Test');
  git(siteDir, 'config', 'user.email', 'test@example.com');
  mutate(siteDir);
  git(siteDir, 'add', '-A');
  git(siteDir, 'commit', '-q', '-m', 'initial');
  return siteDir;
}

async function staticResults(siteDir) {
  const report = await runDoctor({ projectRoot: siteDir, build: false, phases: ['static'] });
  return Object.fromEntries(report.results.map((result) => [result.id, result]));
}

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

try {
  console.log('\n🧪 doctor: static checks\n' + '='.repeat(40));

  await check('every check carries an id, a version, a title, a phase and a docs link', () => {
    assert.ok(DOCTOR_CHECKS.length >= 10);
    const ids = new Set();
    for (const definition of DOCTOR_CHECKS) {
      assert.match(definition.id, /^[a-z0-9-]+$/);
      assert.ok(!ids.has(definition.id), `duplicate id ${definition.id}`);
      ids.add(definition.id);
      assert.match(definition.since, /^\d+\.\d+\.\d+$/, definition.id);
      assert.ok(definition.title, definition.id);
      assert.ok(['static', 'build', 'built'].includes(definition.phase), definition.id);
      assert.match(definition.docs, /^https:\/\/github\.com\/cloudshipco\/astroadmin\/blob\/main\/docs\/doctor\.md#/, definition.id);
      assert.equal(typeof definition.run, 'function', definition.id);
    }
  });

  const healthy = await staticResults(makeSite());

  await check('a hosted-shape site passes every static check', () => {
    for (const id of ['astro-integration', 'hosted-preview-config', 'committed-lockfile', 'no-submodules', 'no-workspace-links']) {
      assert.equal(healthy[id]?.severity, 'pass', `${id}: ${JSON.stringify(healthy[id])}`);
    }
    assert.equal(healthy['sharp-loads'].severity, 'skip', 'no astro:assets, so sharp is not needed');
  });

  await check('a result carries the definition\'s version and docs link', () => {
    assert.equal(healthy['no-submodules'].since, '1.4.8');
    assert.ok(healthy['no-submodules'].docs.endsWith('#no-submodules'));
  });

  await check('integration MUTATION: removing astroadmin() from integrations fails', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, 'astro.config.mjs', HOSTED_CONFIG.replace('integrations: [astroadmin(), sitemap()]', 'integrations: [sitemap()]')));
    const results = await staticResults(siteDir);
    assert.equal(results['astro-integration'].severity, 'fail', JSON.stringify(results['astro-integration']));
  });

  await check('integration MUTATION: no astro.config at all fails', async () => {
    const siteDir = makeSite((dir) => fs.rmSync(path.join(dir, 'astro.config.mjs')));
    assert.equal((await staticResults(siteDir))['astro-integration'].severity, 'fail');
  });

  await check('integration: a TypeScript config with the integration renamed on import passes', async () => {
    const siteDir = makeSite((dir) => {
      fs.rmSync(path.join(dir, 'astro.config.mjs'));
      writeFile(dir, 'astro.config.ts', HOSTED_CONFIG.replace("import astroadmin from 'astroadmin/integration';", "import editor from 'astroadmin/integration';\nconst flag: boolean = true;")
        .replace('astroadmin()', 'editor()'));
    });
    const results = await staticResults(siteDir);
    assert.equal(results['astro-integration'].severity, 'pass', JSON.stringify(results['astro-integration']));
    assert.equal(results['hosted-preview-config'].severity, 'pass');
  });

  await check('preview config MUTATION: no allowedHosts warns', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, 'astro.config.mjs', HOSTED_CONFIG.replace("allowedHosts: ['.admin.example.com', 'localhost'],", '')));
    const result = (await staticResults(siteDir))['hosted-preview-config'];
    assert.equal(result.severity, 'warn');
    assert.match(result.message, /allowedHosts/);
  });

  await check('preview config MUTATION: hmr left on warns', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, 'astro.config.mjs', HOSTED_CONFIG.replace('hmr: false', 'hmr: true')));
    const result = (await staticResults(siteDir))['hosted-preview-config'];
    assert.equal(result.severity, 'warn');
    assert.match(result.message, /hmr/);
  });

  await check('lockfile MUTATION: an uncommitted bun.lock warns', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, '.gitignore', 'node_modules\ndist\nbun.lock\n'));
    assert.ok(fs.existsSync(path.join(siteDir, 'bun.lock')), 'the file is on disk, just not committed');
    assert.equal((await staticResults(siteDir))['committed-lockfile'].severity, 'warn');
  });

  await check('submodule MUTATION: a gitlink (mode 160000) fails', async () => {
    const siteDir = makeSite();
    // After the first commit: `git add -A` would stage the missing path's removal.
    git(siteDir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/theme`);
    git(siteDir, 'commit', '-q', '-m', 'add a submodule');
    const result = (await staticResults(siteDir))['no-submodules'];
    assert.equal(result.severity, 'fail', JSON.stringify(result));
    assert.match(result.message, /vendor\/theme/);
  });

  await check('workspace MUTATION: a package linked back into the repo fails', async () => {
    const siteDir = makeSite((dir) => {
      writeFile(dir, 'packages/ui/package.json', JSON.stringify({ name: '@example/ui' }));
      fs.mkdirSync(path.join(dir, 'node_modules', '@example'), { recursive: true });
      fs.symlinkSync(path.join(dir, 'packages', 'ui'), path.join(dir, 'node_modules', '@example', 'ui'), 'dir');
    });
    const result = (await staticResults(siteDir))['no-workspace-links'];
    assert.equal(result.severity, 'fail', JSON.stringify(result));
    assert.match(result.message, /@example\/ui/);
  });

  const assetsPage = "---\nimport { Image } from 'astro:assets';\n---\n<h1>Home</h1>\n";

  await check('sharp: a site using astro:assets with a working sharp passes', async () => {
    const siteDir = makeSite((dir) => {
      writeFile(dir, 'src/pages/index.astro', assetsPage);
      fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    });
    const result = (await staticResults(siteDir))['sharp-loads'];
    assert.equal(result.severity, 'pass', JSON.stringify(result));
  });

  await check('sharp MUTATION: a sharp that cannot load its native module fails', async () => {
    const siteDir = makeSite((dir) => {
      writeFile(dir, 'src/pages/index.astro', assetsPage);
      writeFile(dir, 'node_modules/sharp/package.json', JSON.stringify({ name: 'sharp', main: 'index.js' }));
      writeFile(dir, 'node_modules/sharp/index.js', "throw new Error('libstdc++.so.6: cannot open shared object file');\n");
    });
    const result = (await staticResults(siteDir))['sharp-loads'];
    assert.equal(result.severity, 'fail', JSON.stringify(result));
    assert.match(result.message, /libstdc\+\+/);
  });

  await check('sharp MUTATION: astro:assets with no sharp installed fails', async () => {
    const siteDir = makeSite((dir) => writeFile(dir, 'src/pages/index.astro', assetsPage));
    assert.equal((await staticResults(siteDir))['sharp-loads'].severity, 'fail');
  });

  await check('a site that is not a git repo warns rather than crashing', async () => {
    const siteDir = path.join(tempRoot, 'not-a-repo');
    fs.mkdirSync(siteDir);
    writeFile(siteDir, 'astro.config.mjs', HOSTED_CONFIG);
    const results = await staticResults(siteDir);
    assert.equal(results['committed-lockfile'].severity, 'warn');
    assert.equal(results['astro-integration'].severity, 'pass');
  });

  const configWith = (body) => `import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import astroadmin from 'astroadmin/integration';
${body}
`;
  const VITE = "vite: { server: { allowedHosts: ['localhost'], hmr: false } }";
  const integrationFor = async (body) => (await staticResults(makeSite((dir) => writeFile(dir, 'astro.config.mjs', configWith(body)))))['astro-integration'];

  await check('integration MUTATION: a call outside the exported integrations (`const unused = astroadmin()`) fails', async () => {
    const result = await integrationFor(`const unused = astroadmin();\nexport default defineConfig({ integrations: [], ${VITE} });`);
    assert.equal(result.severity, 'fail', JSON.stringify(result));
  });

  await check('integration: the exported list is traced through an identifier, a spread and a bound call', async () => {
    for (const body of [
      `const integrations = [astroadmin(), sitemap()];\nexport default defineConfig({ integrations, ${VITE} });`,
      `const base = [astroadmin()];\nexport default defineConfig({ integrations: [...base, sitemap()], ${VITE} });`,
      `const admin = astroadmin();\nexport default defineConfig({ integrations: [sitemap(), admin], ${VITE} });`,
      `const config = { integrations: [astroadmin()], ${VITE} };\nexport default defineConfig(config);`,
    ]) {
      const result = await integrationFor(body);
      assert.equal(result.severity, 'pass', `${body}\n${JSON.stringify(result)}`);
    }
  });

  await check('integration: an integrations value that cannot be read statically warns "could not verify"', async () => {
    for (const body of [
      `function list() { return [astroadmin()]; }\nexport default defineConfig({ integrations: list(), ${VITE} });`,
      `export default defineConfig({ integrations: process.env.CI ? [] : [astroadmin()], ${VITE} });`,
      `const extra = { integrations: [] };\nexport default defineConfig({ integrations: [astroadmin()], ...extra, ${VITE} });`,
    ]) {
      const result = await integrationFor(body);
      assert.equal(result.severity, 'warn', `${body}\n${JSON.stringify(result)}`);
      assert.match(result.message, /could not verify/i);
    }
  });

  const configFor = async (source) => staticResults(makeSite((dir) => writeFile(dir, 'astro.config.mjs', source)));

  await check('config MUTATION: a wrapper call that is not astro\'s defineConfig is "could not verify", not read as the config', async () => {
    const assign = `import astroadmin from 'astroadmin/integration';
export default Object.assign({ integrations: [astroadmin()], ${VITE} }, { integrations: [], vite: { server: { hmr: true } } });
`;
    const localDefine = `import astroadmin from 'astroadmin/integration';
const defineConfig = (config) => ({ ...config, integrations: [] });
export default defineConfig({ integrations: [astroadmin()], ${VITE} });
`;
    const otherModule = `import { defineConfig } from './my-config-helpers.mjs';
import astroadmin from 'astroadmin/integration';
export default defineConfig({ integrations: [astroadmin()], ${VITE} });
`;
    for (const source of [assign, localDefine, otherModule]) {
      const results = await configFor(source);
      assert.equal(results['astro-integration'].severity, 'warn', `${source}\n${JSON.stringify(results['astro-integration'])}`);
      assert.match(results['astro-integration'].message, /could not verify/i);
      assert.equal(results['hosted-preview-config'].severity, 'warn', `${source}\n${JSON.stringify(results['hosted-preview-config'])}`);
      assert.match(results['hosted-preview-config'].message, /could not verify/i);
    }
  });

  await check('config: defineConfig imported from astro/config (also renamed, or through a const) is read', async () => {
    for (const source of [
      configWith(`export default defineConfig({ integrations: [astroadmin()], ${VITE} });`),
      `import { defineConfig as define } from 'astro/config';\nimport astroadmin from 'astroadmin/integration';\nexport default define({ integrations: [astroadmin()], ${VITE} });\n`,
      configWith(`const config = defineConfig({ integrations: [astroadmin()], ${VITE} });\nexport default config;`),
      `import astroadmin from 'astroadmin/integration';\nexport default { integrations: [astroadmin()], ${VITE} };\n`,
    ]) {
      const results = await configFor(source);
      assert.equal(results['astro-integration'].severity, 'pass', `${source}\n${JSON.stringify(results['astro-integration'])}`);
      assert.equal(results['hosted-preview-config'].severity, 'pass', `${source}\n${JSON.stringify(results['hosted-preview-config'])}`);
    }
  });

  const previewFor = async (serverBody) => (await staticResults(makeSite((dir) => writeFile(dir, 'astro.config.mjs', configWith(`const overrides = {};\nexport default defineConfig({ integrations: [astroadmin()], vite: { server: ${serverBody} } });`)))))['hosted-preview-config'];

  await check('preview config: a later spread or computed key makes the values unknown, an earlier one does not', async () => {
    const later = await previewFor("{ allowedHosts: ['localhost'], hmr: false, ...overrides }");
    assert.equal(later.severity, 'warn', JSON.stringify(later));
    assert.match(later.message, /could not verify/i);
    const computed = await previewFor("{ allowedHosts: ['localhost'], hmr: false, ['hm' + 'r']: true }");
    assert.equal(computed.severity, 'warn', JSON.stringify(computed));
    const earlier = await previewFor("{ ...overrides, allowedHosts: ['localhost'], hmr: false }");
    assert.equal(earlier.severity, 'pass', JSON.stringify(earlier));
  });

  await check('preview config MUTATION: a duplicate key is read as the LAST one (hmr: false, then hmr: true)', async () => {
    const result = await previewFor("{ allowedHosts: ['localhost'], hmr: false, hmr: true }");
    assert.equal(result.severity, 'warn', JSON.stringify(result));
    assert.match(result.message, /hmr/);
  });

  await check('lockfile MUTATION: a staged but never committed bun.lock warns (HEAD, not the index)', async () => {
    const siteDir = makeSite((dir) => fs.rmSync(path.join(dir, 'bun.lock')));
    writeFile(siteDir, 'bun.lock', '{ "lockfileVersion": 1 }\n');
    git(siteDir, 'add', 'bun.lock');
    const result = (await staticResults(siteDir))['committed-lockfile'];
    assert.equal(result.severity, 'warn', JSON.stringify(result));
  });

  await check('lockfile: a repository with no commits yet warns rather than crashing', async () => {
    const siteDir = path.join(tempRoot, 'no-commits');
    fs.mkdirSync(siteDir);
    writeFile(siteDir, 'astro.config.mjs', HOSTED_CONFIG);
    writeFile(siteDir, 'bun.lock', '{}\n');
    git(siteDir, 'init', '-q', '-b', 'main');
    git(siteDir, 'add', '-A');
    const result = (await staticResults(siteDir))['committed-lockfile'];
    assert.equal(result.severity, 'warn', JSON.stringify(result));
  });

  await check('lockfile: a site in a subdirectory with its lockfile committed at the repo root passes', async () => {
    const repoDir = makeSite((dir) => {
      fs.mkdirSync(path.join(dir, 'apps', 'site'), { recursive: true });
      fs.renameSync(path.join(dir, 'astro.config.mjs'), path.join(dir, 'apps', 'site', 'astro.config.mjs'));
    });
    const result = (await staticResults(path.join(repoDir, 'apps', 'site')))['committed-lockfile'];
    assert.equal(result.severity, 'pass', JSON.stringify(result));
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
