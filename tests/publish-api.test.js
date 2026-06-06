/**
 * In-process API test for git-optional publishing (Chunk ④)
 *
 * Builds the real Express app in-process (no listener, no external server)
 * with git disabled via astroadmin.config.js, and asserts:
 *   - /api/git/* is not mounted
 *   - /api/publish works without git (no-op when no deploy adapter)
 *
 * Run with:
 *   ASTROADMIN_DB=/tmp/aa-pub.db \
 *     ASTROADMIN_PROJECT_ROOT=/tmp/aa-pub-root bun tests/publish-api.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const projectRoot = process.env.ASTROADMIN_PROJECT_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'aa-pub-root-'));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.ASTROADMIN_DB = process.env.ASTROADMIN_DB || path.join(projectRoot, 'content.db');
process.env.GIT_ENABLED = 'true';

fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
fs.writeFileSync(
  path.join(projectRoot, 'astroadmin.config.js'),
  'export default { git: { enabled: false } };\n'
);

const { createServer } = await import('../server/index.js');
const { getConfig } = await import('../server/config.js');
const { publishHandler } = await import('../server/api/publish.js');

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

function hasMountedPath(app, mountPath) {
  return app._router.stack.some((layer) => (
    String(layer.regexp).replaceAll('\\/', '/').includes(mountPath)
  ));
}

function createJsonResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const { app } = await createServer();

console.log('\n🧪 Publish API (git disabled)\n' + '='.repeat(40));

await check('config reports git disabled', async () => {
  const fullConfig = await getConfig();
  assert.equal(fullConfig.git.enabled, false, 'gitEnabled is false');
});

await check('/api/git/* is not mounted', () => {
  assert.equal(hasMountedPath(app, '/api/git'), false, 'git router is not mounted');
  assert.equal(hasMountedPath(app, '/api/publish'), true, 'publish router remains mounted');
});

await check('/api/publish works without git or adapter (no-op)', async () => {
  const res = createJsonResponse();
  await publishHandler({ body: { message: 'test' } }, res);

  const data = res.body;
  assert.equal(res.statusCode, 200, 'publish 200');
  assert.ok(data.success, 'publish success');
  assert.equal(data.committed, false, 'nothing committed (git disabled)');
  assert.equal(data.pushed, false, 'nothing pushed (git disabled)');
  assert.equal(data.build, null, 'no build (no adapter)');
  assert.equal(data.deploy, null, 'no deploy (no adapter)');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(0);
