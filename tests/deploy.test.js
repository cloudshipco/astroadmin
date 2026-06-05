/**
 * Deploy adapter registry tests (Chunk ③)
 *
 *   bun tests/deploy.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deploy, validateDeployConfig } from '../server/utils/deploy.js';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exit(1);
  }
}

console.log('\n🧪 Deploy adapter registry\n' + '='.repeat(40));

await check('validate: no adapter is valid', () => {
  assert.deepEqual(validateDeployConfig({ adapter: null }), { valid: true, errors: [] });
  assert.deepEqual(validateDeployConfig({}), { valid: true, errors: [] });
});

await check('validate: rsync requires path', () => {
  const result = validateDeployConfig({ adapter: 'rsync', rsync: {} });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('path')), 'mentions path');
});

await check('validate: rsync remote requires user', () => {
  const result = validateDeployConfig({ adapter: 'rsync', rsync: { path: '/srv', host: 'h' } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('user')), 'mentions user');
});

await check('validate: valid local rsync', () => {
  assert.deepEqual(
    validateDeployConfig({ adapter: 'rsync', rsync: { path: '/srv/www' } }),
    { valid: true, errors: [] }
  );
});

await check('validate: unknown adapter is rejected', () => {
  const result = validateDeployConfig({ adapter: 'bogus' });
  assert.equal(result.valid, false);
  assert.ok(result.errors[0].includes('Unknown deploy adapter'), 'names the problem');
});

await check('deploy: no adapter is a no-op skip', async () => {
  const result = await deploy({ adapter: null }, '/tmp');
  assert.equal(result.success, true);
  assert.equal(result.skipped, true);
});

await check('deploy: local rsync dry-run', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-deploy-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-dest-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'dist', 'index.html'), '<h1>hi</h1>');

    const result = await deploy(
      { adapter: 'rsync', rsync: { path: dest, dryRun: true } },
      projectRoot,
      { log: () => {} }
    );

    assert.equal(result.success, true, 'dry-run succeeds');
    assert.equal(result.dryRun, true, 'dry-run flagged');
    assert.equal(result.local, true, 'local deploy');
    assert.equal(result.adapter, 'rsync', 'adapter name attached');
    // dry-run must not actually copy anything
    assert.equal(fs.existsSync(path.join(dest, 'index.html')), false, 'nothing copied');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(0);
