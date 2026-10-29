/**
 * Build and deploy responses carry status, never output or command lines.
 *
 * Review round 6: the build routes returned the configured command line
 * verbatim (`build.production` naming a script by its server path), and a
 * successful deploy returned the adapter's whole result, whose rsync output
 * names the destination ("created directory /srv/..."). Now:
 *
 * - there are no /api/build routes (#3: nothing in the editor called them,
 *   and they were a second production build runner beside Publish's);
 * - POST /api/publish with a deploy adapter returns chosen deploy status
 *   fields (success, adapter, dryRun), the adapter's output going to the log;
 * - a failed build in Publish carries the problems its output names as error
 *   codes (build-failure.js), never the output.
 *
 * Real server (createServer), real shell build script, real local rsync.
 * Each check has a positive control: the path really was in the command or
 * the output (it is in the server log).
 *
 *   bun tests/build-deploy-responses.test.js     (~2 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-build-deploy-')));
const projectRoot = path.join(scratch, 'site-a');
const scriptDir = path.join(scratch, "build scripts, client's");
const buildScript = path.join(scriptDir, 'build-site-a.sh');
const failFlag = path.join(scratch, 'fail-the-build');
const destination = path.join(scratch, 'client site,backup', 'www');
// rsync creates the last directory itself (and says so: the leak).
for (const directory of [projectRoot, scriptDir, path.dirname(destination)]) fs.mkdirSync(directory, { recursive: true });

// The build writes dist/ (for the deploy), prints where it ran, and fails the
// way Astro does when the flag file exists.
fs.writeFileSync(buildScript, `#!/bin/sh
echo "building in $PWD with ${buildScript}"
if [ -e '${failFlag}' ]; then
  echo "[ImageNotFound] Could not find requested image \\\`/srv/client-b/x.png\\\`." >&2
  exit 1
fi
mkdir -p dist && echo '<h1>hi</h1>' > dist/index.html
`);
fs.chmodSync(buildScript, 0o755);
const configuredCommand = `'${buildScript.replace(/'/g, `'\\''`)}'`;
fs.writeFileSync(path.join(projectRoot, 'astroadmin.config.js'), `export default ${JSON.stringify({
  git: { enabled: false },
  build: { production: configuredCommand },
  deploy: { adapter: 'rsync', rsync: { path: `${destination}/` } },
})};\n`);

process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.NODE_ENV; // development: no session store under /data
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

// The server log: everything the app writes, kept for the positive controls.
const serverLog = [];
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    serverLog.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(' '));
  };
}
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const report = (line) => realStdoutWrite(`${line}\n`);
// rsync's output is also streamed to stdout; keep it out of the report.
process.stdout.write = (chunk, ...rest) => {
  serverLog.push(String(chunk));
  return typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true;
};

const SIGNS = [scratch, 'aa-build-deploy-', 'site-a', 'build scripts', 'client', 'backup', 'www', '.sh', '/srv', os.tmpdir(), fs.realpathSync(os.tmpdir()), '/private/', '/var/folders/'];
function assertNoServerPath(label, body) {
  for (const sign of SIGNS) assert.equal(body.includes(sign), false, `${label} names "${sign}": ${body}`);
}
function assertLogged(mark, ...fragments) {
  const logged = serverLog.slice(mark).join('\n');
  for (const fragment of fragments) assert.ok(logged.includes(fragment), `positive control: the server log has ${fragment}; it has:\n${logged.slice(0, 2000)}`);
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

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(login.status, 200, 'login');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (urlPath, options = {}) => {
    const response = await fetch(base + urlPath, { ...options, headers: { cookie, Origin: base, 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const body = await response.text();
    return { status: response.status, body, json: JSON.parse(body) };
  };

  report('\n🧪 build and deploy responses: status, not output\n' + '='.repeat(40));

  await check('there are no /api/build routes: each answers as an unknown route does, and builds nothing', async () => {
    const unknownGet = await fetch(`${base}/api/no-such-route`, { headers: { cookie } });
    const unknownPost = await fetch(`${base}/api/no-such-route`, { method: 'POST', headers: { cookie, Origin: base } });
    assert.equal(unknownGet.status, 404, 'control: an unknown route is a 404');
    assert.equal(unknownPost.status, 404, 'control: an unknown route is a 404');
    const mark = serverLog.length;
    for (const [method, urlPath] of [['GET', '/api/build/status'], ['POST', '/api/build/production'], ['POST', '/api/build/staging']]) {
      const response = await fetch(base + urlPath, { method, headers: { cookie, Origin: base, 'Content-Type': 'application/json' } });
      await response.arrayBuffer();
      assert.equal(response.status, 404, `${method} ${urlPath}`);
    }
    assert.ok(!serverLog.slice(mark).join('\n').includes('building in'), 'a build ran');
  });

  await check('POST /api/publish with an rsync deploy: chosen status fields, the destination only in the log', async () => {
    const mark = serverLog.length;
    const response = await request('/api/publish', { method: 'POST', body: JSON.stringify({ message: 'x' }) });
    assert.equal(response.json.success, true, response.body);
    // Positive controls: the deploy really ran, and rsync named the destination.
    assert.ok(fs.existsSync(path.join(destination, 'index.html')), 'rsync copied the site');
    assertLogged(mark, 'created directory', destination);
    assertNoServerPath('the publish response', response.body);
    assert.deepEqual(response.json.deploy, { success: true, adapter: 'rsync', dryRun: false });
    assert.deepEqual(response.json.build, { success: true, duration: response.json.build.duration });
  });

  await check('POST /api/publish whose build fails: the code sentence, no output', async () => {
    fs.writeFileSync(failFlag, '');
    try {
      const response = await request('/api/publish', { method: 'POST', body: JSON.stringify({ message: 'x' }) });
      assert.equal(response.json.success, false, response.body);
      assert.deepEqual(response.json.build.problems, [{ code: 'ImageNotFound', message: 'An image an entry uses was not found in the site.' }]);
      assert.equal(response.json.build.output, undefined);
      assertNoServerPath('the publish response', response.body);
    } finally {
      fs.rmSync(failFlag);
    }
  });

  report('='.repeat(40));
  report(`\n📊 ${passed} checks passed.\n`);
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
