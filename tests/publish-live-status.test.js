/**
 * What an editor is told after a publish to a build-on-push host (#54).
 *
 * The dashboard polls the public page and compares a hash of its HTML with
 * the one taken before publishing. When the page changes, the change is live.
 * When polling gives up without seeing a change (a failed build on the host,
 * a slow deploy, an edit that does not change this page), the editor used to
 * get the same green "✅ Published" success as a confirmed one. The changes
 * were pushed, but nothing showed they were live.
 *
 * The same holds when there is nothing to poll (no publicUrl, or no page for
 * this entry): a push is sent but unverified, a warning, never "✅ Published!
 * ... in a minute or two" (showPublishOutcome / friendlyPublishMessage).
 * A deploy adapter's result is live only when it uploaded: a dry run is
 * "nothing was uploaded" (info), and a skipped deploy (no adapter) leaves the
 * push to be judged on its own.
 *
 * A build or deploy that fails AFTER the git step is a response with
 * `success: false` and the git step's `committed`/`pushed`. Those bodies are
 * captured from the REAL server (createServer, git disabled, a shell build
 * script, a real local rsync to a destination it cannot create) and run
 * through the dashboard's real showPublishResult. They used to reach the
 * generic "Failed to publish: Built, but deployment failed", even when the
 * commit had reached the repository, and vanished after 3 s. The pushed
 * variants are the same bodies with `committed`/`pushed` set as the git step
 * sets them (the git step is not run here; publish-check and publish-sync
 * cover it). A pushed variant does not say "not live": the build or deploy
 * that failed is this server's, and a build-on-push host may still publish.
 *
 * The git step's own refusals (409 blocked, conflict, local changes; 422;
 * 502), built by the server's body functions: each that says `committed`
 * refreshes the Changes badge, and a message with its own lead-in ("Nothing
 * was published: ...") is shown as written, not as "Failed to publish:
 * Nothing was published: ...".
 *
 * The real functions are extracted from ui/dashboard.js (it boots on import)
 * and run in a happy-dom document with fetch stubbed and a fake clock.
 *
 *   bun tests/publish-live-status.test.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { readJson } from '../ui/api-response.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${error.message}`);
  }
}

function extractFunction(name) {
  const match = source.match(new RegExp(`\\n((?:async )?function ${name}\\([\\s\\S]*?\\n\\})\\n`));
  assert.ok(match, `${name} was not found in ui/dashboard.js`);
  return match[1];
}

const functionsSource = ['showPublishStatus', 'fetchLiveHash', 'pollUntilLive'].map(extractFunction).join('\n\n');

/**
 * Run pollUntilLive to completion against live-status answers given by
 * `liveHashAt(pollNumber)` (a hash, or null for an unreachable site).
 * Returns the toast's final text, type (its notification-* class) and link,
 * and how many polls ran.
 */
async function runPoll(liveHashAt, preHash = 'before') {
  const window = new Window();
  const document = window.document;

  let now = 1_000_000;
  const timers = [];
  const fakeSetTimeout = (callback, ms) => { timers.push({ callback, at: now + ms }); return timers.length; };
  const fakeDate = { now: () => now };

  let polls = 0;
  const fetchStub = async (url) => {
    assert.ok(String(url).startsWith('/api/publish/live-status?path='), `unexpected request ${url}`);
    polls++;
    const hash = liveHashAt(polls);
    const body = hash === null
      ? { success: true, configured: true, reachable: false, error: 'The live site could not be reached' }
      : { success: true, configured: true, reachable: true, status: 200, hash };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const stubs = { document, fetch: fetchStub, readJson, setTimeout: fakeSetTimeout, Date: fakeDate };
  const api = new Function(...Object.keys(stubs), `${functionsSource}\nreturn { showPublishStatus, pollUntilLive };`)(...Object.values(stubs));

  const status = api.showPublishStatus('✅ Published! Waiting for your changes to go live…');
  let settled = false;
  const done = api.pollUntilLive('/about', preHash, status, 'https://example.com/about').then(() => { settled = true; });

  // Pump the fake clock: run the earliest timer, let its promise chain settle, repeat.
  for (let steps = 0; !settled; steps++) {
    assert.ok(steps < 1000, 'polling never finished');
    await new Promise(resolve => setImmediate(resolve));
    if (settled) break;
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    assert.ok(next, 'polling is waiting on nothing');
    now = next.at;
    next.callback();
  }
  await done;

  const toast = document.querySelector('.notification');
  assert.ok(toast, 'the status toast is on the page');
  const link = toast.querySelector('a');
  return {
    text: toast.textContent,
    type: [...toast.classList].find((name) => name.startsWith('notification-')),
    link: link ? link.getAttribute('href') : null,
    polls,
  };
}

const SUCCESS = 'notification-success';

await check('positive control: a live page that changes is reported live, in green', async () => {
  const result = await runPoll(poll => (poll < 3 ? 'before' : 'after'));
  assert.equal(result.polls, 3, `polling stops when the change appears (${result.polls} polls)`);
  assert.match(result.text, /Your changes are now live!/, result.text);
  assert.equal(result.type, SUCCESS, result.type);
  assert.equal(result.link, 'https://example.com/about');
});

await check('a live page that never changes is NOT reported as a success', async () => {
  const result = await runPoll(() => 'before');
  assert.ok(result.polls > 10, `positive control: polling ran until it gave up (${result.polls} polls)`);
  assert.doesNotMatch(result.text, /✅/, `no success tick: ${result.text}`);
  assert.doesNotMatch(result.text, /live shortly|now live/i, `no claim that it is live: ${result.text}`);
  assert.notEqual(result.type, SUCCESS, `not the success style: ${result.type}`);
  assert.equal(result.type, 'notification-warning', result.type);
});

await check('the give-up message says the changes were sent, that we could not confirm them, and what to do', async () => {
  const result = await runPoll(() => 'before');
  assert.match(result.text, /sent/i, result.text);
  assert.match(result.text, /couldn.t confirm|could not confirm/i, result.text);
  assert.match(result.text, /few minutes/i, result.text);
  assert.match(result.text, /hosting/i, result.text);
  assert.equal(result.link, 'https://example.com/about', 'the editor can still open the live page');
});

await check('a live site that stays unreachable is not reported as a success either', async () => {
  const result = await runPoll(() => null);
  assert.ok(result.polls > 10, `polling ran until it gave up (${result.polls} polls)`);
  assert.doesNotMatch(result.text, /✅|live shortly|now live/i, result.text);
  assert.notEqual(result.type, SUCCESS, result.type);
});

/**
 * Run the dashboard's showPublishOutcome for a successful publish response,
 * with nothing to poll unless `preHash` is given. Returns the toast's text,
 * type and link (the last toast on the page).
 */
async function runOutcome(result, { preHash = null, liveUrl = null } = {}) {
  const window = new Window();
  const document = window.document;
  const timers = [];
  const stubs = {
    document,
    fetch: async () => { throw new Error('no request expected'); },
    readJson,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    Date,
  };
  const outcomeSource = ['showNotification', 'showPublishStatus', 'fetchLiveHash', 'pollUntilLive',
    'ranDeploy', 'friendlyPublishMessage', 'showPublishOutcome'].map(extractFunction).join('\n\n');
  const api = new Function(...Object.keys(stubs), `${outcomeSource}\nreturn { showPublishOutcome };`)(...Object.values(stubs));
  api.showPublishOutcome(result, { pagePath: preHash ? '/about' : null, preHash, liveUrl });
  const toasts = document.querySelectorAll('.notification');
  assert.ok(toasts.length > 0, 'a toast is on the page');
  const toast = toasts[toasts.length - 1];
  const link = toast.querySelector('a');
  return {
    text: toast.textContent,
    type: [...toast.classList].find((name) => name.startsWith('notification-')),
    link: link ? link.getAttribute('href') : null,
    dismissAfterMs: timers.length ? Math.max(...timers.map((timer) => timer.ms)) : null,
  };
}

await check('positive control: a deploy adapter publish is reported live, in green', async () => {
  const result = await runOutcome({ success: true, committed: true, pushed: false, deploy: { success: true } });
  assert.match(result.text, /now live/, result.text);
  assert.equal(result.type, SUCCESS, result.type);
});

await check('positive control: a push with a page to poll starts polling (the info toast)', async () => {
  const result = await runOutcome({ success: true, committed: true, pushed: true, deploy: null },
    { preHash: 'before', liveUrl: 'https://example.com/about' });
  assert.match(result.text, /Waiting for your changes to go live/, result.text);
});

for (const [label, liveUrl] of [['no publicUrl', null], ['a publicUrl but no page for this entry', 'https://example.com/']]) {
  await check(`a push with nothing to poll (${label}) is sent but unverified, not a success`, async () => {
    const result = await runOutcome({ success: true, committed: true, pushed: true, deploy: null }, { liveUrl });
    assert.doesNotMatch(result.text, /✅/, `no success tick: ${result.text}`);
    assert.doesNotMatch(result.text, /will appear|now live|live shortly/i, `no claim that it goes live: ${result.text}`);
    assert.match(result.text, /sent/i, result.text);
    assert.match(result.text, /can.t confirm|cannot confirm|couldn.t confirm|could not confirm/i, result.text);
    assert.match(result.text, /hosting/i, result.text);
    assert.equal(result.type, 'notification-warning', result.type);
    assert.equal(result.link, liveUrl, 'the editor can open the live site when there is one');
    assert.ok(result.dismissAfterMs >= 15000, `long enough to read (${result.dismissAfterMs} ms)`);
  });
}

await check('a dry-run deploy says nothing was uploaded, never live', async () => {
  for (const pushed of [false, true]) {
    const result = await runOutcome({ success: true, committed: true, pushed, deploy: { success: true, adapter: 'rsync', dryRun: true } });
    assert.doesNotMatch(result.text, /✅|now live/i, `pushed=${pushed}: ${result.text}`);
    assert.match(result.text, /dry run/i, result.text);
    assert.match(result.text, /nothing was uploaded/i, result.text);
    assert.equal(result.type, 'notification-info', result.type);
  }
});

await check('a skipped deploy (no adapter) is not a deploy: a push is still unverified', async () => {
  const result = await runOutcome({ success: true, committed: true, pushed: true, deploy: { success: true, skipped: true } });
  assert.doesNotMatch(result.text, /✅|now live/i, result.text);
  assert.equal(result.type, 'notification-warning', result.type);
});

await check('a commit with nowhere to push is not shown as a success', async () => {
  const result = await runOutcome({ success: true, committed: true, pushed: false, deploy: null });
  assert.match(result.text, /no remote/i, result.text);
  assert.notEqual(result.type, SUCCESS, result.type);
});

// --- Build and deploy failures after the git step: the server's real bodies ---

/**
 * POST /api/publish against the real app, once with a build that passes and
 * an rsync deploy that fails, then with a build that fails the way Astro
 * does. Returns both response bodies.
 */
async function capturePublishFailures() {
  const os = await import('os');
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-live-status-')));
  const projectRoot = path.join(scratch, 'site');
  fs.mkdirSync(projectRoot);
  const failFlag = path.join(scratch, 'fail-the-build');
  const buildScript = path.join(scratch, 'build.sh');
  fs.writeFileSync(buildScript, `#!/bin/sh
if [ -e '${failFlag}' ]; then
  echo "[ImageNotFound] Could not find requested image." >&2
  exit 1
fi
mkdir -p dist && echo '<h1>hi</h1>' > dist/index.html
`);
  fs.chmodSync(buildScript, 0o755);
  // rsync cannot create a directory under a regular file.
  fs.writeFileSync(path.join(scratch, 'blocker'), '');
  fs.writeFileSync(path.join(projectRoot, 'astroadmin.config.js'), `export default ${JSON.stringify({
    git: { enabled: false },
    build: { production: `'${buildScript}'` },
    deploy: { adapter: 'rsync', rsync: { path: `${path.join(scratch, 'blocker', 'www')}/` } },
  })};\n`);
  process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
  process.env.GIT_ENABLED = 'false';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin';
  delete process.env.NODE_ENV; // development: no session store under /data
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ASTROADMIN_CONTENT_STORE;

  const realConsole = {};
  for (const level of ['log', 'warn', 'error']) { realConsole[level] = console[level]; console[level] = () => {}; }
  // rsync's output is streamed to the server's own stdout and stderr.
  const realStdoutWrite = process.stdout.write;
  const realStderrWrite = process.stderr.write;
  const swallow = (chunk, ...rest) => (typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true);
  process.stdout.write = swallow;
  process.stderr.write = swallow;
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
    const publish = async () => {
      const response = await fetch(`${base}/api/publish`, {
        method: 'POST', headers: { cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x' }),
      });
      return response.json();
    };
    const deployFailure = await publish();
    fs.writeFileSync(failFlag, '');
    const buildFailure = await publish();
    return { deployFailure, buildFailure };
  } finally {
    server.close();
    Object.assign(console, realConsole);
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Run the dashboard's showPublishResult for a publish response body; the toast it shows. */
function runPublishResult(result) {
  return runPublishResultIn(result, { toast: true });
}

/** The same for a body answered with the problems panel (stubbed), not a toast. */
function runPublishResultNoToast(result) {
  return runPublishResultIn(result, { toast: false });
}

function runPublishResultIn(result, { toast: expectToast }) {
  const window = new Window();
  const document = window.document;
  const timers = [];
  const calls = { problems: 0, badge: 0 };
  const stubs = {
    document,
    fetch: async () => { throw new Error('no request expected'); },
    readJson,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    Date,
    updateChangesBadge: () => { calls.badge++; },
    showPublishProblems: () => { calls.problems++; },
  };
  const resultSource = ['showNotification', 'showPublishStatus', 'fetchLiveHash', 'pollUntilLive',
    'ranDeploy', 'friendlyPublishMessage', 'showPublishOutcome', 'showPublishResult'].map(extractFunction).join('\n\n');
  const api = new Function(...Object.keys(stubs), `${resultSource}\nreturn { showPublishResult };`)(...Object.values(stubs));
  api.showPublishResult(result, { pagePath: null, preHash: null, liveUrl: null });
  const toasts = document.querySelectorAll('.notification');
  if (!expectToast) {
    assert.equal(toasts.length, 0, 'no toast beside the problems panel');
    return { calls };
  }
  assert.ok(toasts.length > 0, 'a toast is on the page');
  const toast = toasts[toasts.length - 1];
  return {
    text: toast.textContent,
    type: [...toast.classList].find((name) => name.startsWith('notification-')),
    dismissAfterMs: timers.length ? Math.max(...timers.map((timer) => timer.ms)) : null,
    calls,
  };
}

const { deployFailure, buildFailure } = await capturePublishFailures();

await check('positive control: the real server answered a failed deploy and a failed build as expected', () => {
  assert.equal(deployFailure.success, false, JSON.stringify(deployFailure));
  assert.equal(deployFailure.build?.success, true, JSON.stringify(deployFailure));
  assert.equal(deployFailure.deploy?.success, false, JSON.stringify(deployFailure));
  assert.equal(buildFailure.success, false, JSON.stringify(buildFailure));
  assert.equal(buildFailure.build?.success, false, JSON.stringify(buildFailure));
  assert.equal(buildFailure.deploy, null, JSON.stringify(buildFailure));
});

const pushedVariant = (body) => ({ ...body, committed: true, pushed: true });

await check('a failed deploy (real body) says the deploy failed and nothing is live, as an error that stays up', () => {
  const shown = runPublishResult(deployFailure);
  assert.doesNotMatch(shown.text, /Failed to publish|✅|now live/i, shown.text);
  assert.match(shown.text, /deploy/i, shown.text);
  assert.match(shown.text, /not live/i, shown.text);
  assert.equal(shown.type, 'notification-error', shown.type);
  assert.ok(shown.dismissAfterMs >= 30000, `as long as a warning (${shown.dismissAfterMs} ms)`);
  assert.equal(shown.calls.problems, 0, 'not the publish-check refusal panel');
});

await check('a failed deploy after a push says the changes reached the repository, not that publishing failed', () => {
  const shown = runPublishResult(pushedVariant(deployFailure));
  assert.doesNotMatch(shown.text, /Failed to publish|✅|now live/i, shown.text);
  assert.match(shown.text, /sent to the repository/i, shown.text);
  assert.match(shown.text, /deploy/i, shown.text);
  // DELIBERATE (review round 3): once pushed, a build-on-push host may still
  // publish the commit, so "not live" is not something we know.
  assert.doesNotMatch(shown.text, /not live/i, shown.text);
  assert.match(shown.text, /may still go live/i, shown.text);
  assert.equal(shown.type, 'notification-error', shown.type);
  assert.equal(shown.calls.badge, 1, 'the Changes badge is refreshed: the changes were committed');
});

await check('a failed build (real body) says the build failed, with the problem it names, and nothing is live', () => {
  const shown = runPublishResult(buildFailure);
  assert.doesNotMatch(shown.text, /Failed to publish|Published to git|✅/i, shown.text);
  assert.match(shown.text, /build failed/i, shown.text);
  assert.match(shown.text, /not live/i, shown.text);
  assert.match(shown.text, /An image an entry uses was not found/, `the code's sentence: ${shown.text}`);
  assert.equal(shown.type, 'notification-error', shown.type);
  assert.ok(shown.dismissAfterMs >= 30000, `as long as a warning (${shown.dismissAfterMs} ms)`);
});

await check('a failed build after a push says the changes reached the repository', () => {
  const shown = runPublishResult(pushedVariant(buildFailure));
  assert.match(shown.text, /sent to the repository/i, shown.text);
  assert.match(shown.text, /build failed/i, shown.text);
  // The commit was sent: the build that failed is this server's, and a host
  // that builds on push may still publish it.
  assert.doesNotMatch(shown.text, /not live/i, shown.text);
  assert.match(shown.text, /may still go live/i, shown.text);
  assert.match(shown.text, /An image an entry uses was not found/, `the code's sentence: ${shown.text}`);
  assert.equal(shown.type, 'notification-error', shown.type);
  assert.equal(shown.calls.badge, 1, 'the Changes badge is refreshed: the changes were committed');
});

await check('a failed build or deploy that was only committed (no push) still says nothing is live', () => {
  for (const body of [buildFailure, deployFailure]) {
    const shown = runPublishResult({ ...body, committed: true, pushed: false });
    assert.match(shown.text, /^Your changes are committed, but/, shown.text);
    assert.match(shown.text, /not live/i, shown.text);
    assert.doesNotMatch(shown.text, /may still/i, shown.text);
  }
});

// The refusals the git step sends (409, 422, 502), built by the server's own
// body functions, so a change of wording there is seen here.
const { blockedBody, conflictBody, localChangesBody, pushFailureBody, checkRefusalBody, publishFailureMessage } = await import('../server/api/publish.js');
const committedResult = { hash: 'abc1234def', message: 'Content update' };

await check('a refusal after a commit refreshes the Changes badge (409 conflict and local changes, 422, 502)', async () => {
  const refusal = await checkRefusalBody({ commit: 'abc1234', problems: [], entries: [] }, { committed: true, commitResult: committedResult });
  for (const [name, body] of [
    ['conflict', conflictBody({ committed: true, commitResult: committedResult })],
    ['local changes', localChangesBody({ committed: true, commitResult: committedResult })],
    ['422 refusal', refusal],
    ['push failure', pushFailureBody({ committed: true, commitResult: committedResult })],
  ]) {
    assert.equal(body.committed, true, `${name}: positive control, the body says committed`);
    const shown = name === '422 refusal' ? runPublishResultNoToast(body) : runPublishResult(body);
    assert.equal(shown.calls.badge, 1, `${name}: the badge is refreshed`);
  }
  const shown = runPublishResult(localChangesBody({ committed: false }));
  assert.equal(shown.calls.badge, 0, 'nothing committed: the badge is left alone (control)');
  assert.equal(runPublishResultNoToast(refusal).calls.problems, 1, 'the 422 still opens the problems panel');
});

await check('a refusal whose message has its own lead-in is shown as the server wrote it, without "Failed to publish:"', () => {
  for (const body of [
    blockedBody(), blockedBody('submodules'), blockedBody('filter'),
    conflictBody({ committed: true }), localChangesBody({ committed: true }), localChangesBody({ committed: false }),
    pushFailureBody({ committed: true }),
    { success: false, error: 'Failed to publish', message: publishFailureMessage(new Error('boom')) },
  ]) {
    const shown = runPublishResult(body);
    assert.equal(shown.text, body.message, shown.text);
    assert.equal(shown.type, 'notification-error', shown.type);
  }
});

await check('any other failure is still "Failed to publish" with the server\'s message (control)', () => {
  const shown = runPublishResult({ success: false, error: 'Invalid deploy configuration' });
  assert.match(shown.text, /^Failed to publish: Invalid deploy configuration/, shown.text);
  assert.equal(shown.type, 'notification-error', shown.type);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
