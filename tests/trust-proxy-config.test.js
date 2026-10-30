/**
 * `trustProxy` in astroadmin.config.js goes through the same normalisation
 * as the TRUST_PROXY environment variable (server/config.js,
 * trustProxySetting). It used to reach express as written: the string '1'
 * became the address 0.0.0.1 (so the loopback proxy was no longer trusted),
 * and 'true', 'false' or a list with an empty entry ('loopback,,') threw at
 * startup.
 *
 * Each value runs in its own process (the user config is loaded once per
 * process): a throwaway site with that astroadmin.config.js, the real
 * createServer() in production mode, and express's own `trust proxy fn`
 * asked which peers it trusts.
 *
 *   bun tests/trust-proxy-config.test.js
 */

import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const selfPath = path.join(import.meta.dir, 'trust-proxy-config.test.js');

if (process.argv[2] === '--child') {
  const { configValue, envValue } = JSON.parse(process.argv[3]);
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-trust-proxy-')));
  const write = (relativePath, content) => {
    const fullPath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  };
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
  write('package.json', JSON.stringify({ type: 'module' }));
  write('astroadmin.config.js', `export default { trustProxy: ${JSON.stringify(configValue)} };\n`);
  write('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = { pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }) };
`);
  Object.assign(process.env, {
    NODE_ENV: 'production',
    ASTROADMIN_PROJECT_ROOT: projectRoot,
    SESSION_DB_PATH: path.join(projectRoot, 'data/sessions.db'),
    SESSION_SECRET: 'trust-proxy-config-secret-0123456789abcdef',
    GIT_ENABLED: 'false',
  });
  delete process.env.ASTROADMIN_CONTENT_STORE;
  if (envValue === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = envValue;
  let result;
  try {
    const { createServer } = await import('../server/index.js');
    const { app } = await createServer();
    const trusts = app.get('trust proxy fn');
    result = {
      started: true,
      setting: app.get('trust proxy'),
      loopback: trusts('127.0.0.1', 0),
      other: trusts('198.51.100.9', 0),
      named: trusts('198.51.100.5', 0),
    };
  } catch (error) {
    result = { started: false, error: error.message };
  }
  fs.rmSync(projectRoot, { recursive: true, force: true });
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  process.exit(0);
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

/** Start a server with this config (and TRUST_PROXY) in its own process. */
function serverWith(configValue, envValue) {
  const run = spawnSync(process.execPath, [selfPath, '--child', JSON.stringify({ configValue, envValue })], { encoding: 'utf8', timeout: 120_000 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  assert.ok(line, `the child reported (positive control):\n${run.stdout}${run.stderr}`);
  return JSON.parse(line.slice('RESULT '.length));
}

console.log('\n🧪 trustProxy in astroadmin.config.js\n' + '='.repeat(40));

await check("'1' is one hop, not the address 0.0.0.1", () => {
  const result = serverWith('1');
  assert.equal(result.started, true, result.error);
  assert.equal(result.setting, 1);
  assert.equal(result.loopback, true);
});

for (const [value, expected] of [['true', true], ['false', false], [' true ', true]]) {
  await check(`${JSON.stringify(value)} starts the server as the boolean ${expected}`, () => {
    const result = serverWith(value);
    assert.equal(result.started, true, result.error);
    assert.equal(result.loopback, expected);
    assert.equal(result.other, expected);
  });
}

await check("a list with empty entries ('loopback,,') starts, trusting what it names", () => {
  const result = serverWith('loopback,, 198.51.100.5,');
  assert.equal(result.started, true, result.error);
  assert.equal(result.loopback, true);
  assert.equal(result.named, true);
  assert.equal(result.other, false);
});

await check('an array with a blank entry starts, trusting what it names', () => {
  const result = serverWith(['loopback', ' ', '198.51.100.5']);
  assert.equal(result.started, true, result.error);
  assert.equal(result.loopback, true);
  assert.equal(result.named, true);
  assert.equal(result.other, false);
});

await check('blank or empty is the production default, loopback', () => {
  for (const value of ['', ' , ', []]) {
    const result = serverWith(value);
    assert.equal(result.started, true, `${JSON.stringify(value)}: ${result.error}`);
    assert.equal(result.loopback, true, JSON.stringify(value));
    assert.equal(result.other, false, JSON.stringify(value));
  }
});

await check('a number and a boolean are taken as they are (control)', () => {
  assert.equal(serverWith(2).setting, 2);
  assert.equal(serverWith(false).loopback, false);
});

await check('TRUST_PROXY in the environment wins over the config (control)', () => {
  const result = serverWith('1', '198.51.100.5');
  assert.equal(result.named, true);
  assert.equal(result.loopback, false);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(process.exitCode || 0);
