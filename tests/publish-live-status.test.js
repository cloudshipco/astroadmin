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
 * Returns the toast's final text, colour and link, and how many polls ran.
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
    background: toast.style.background,
    link: link ? link.getAttribute('href') : null,
    polls,
  };
}

const SUCCESS_GREEN = /#22c55e|rgb\(34, 197, 94\)/i;

await check('positive control: a live page that changes is reported live, in green', async () => {
  const result = await runPoll(poll => (poll < 3 ? 'before' : 'after'));
  assert.equal(result.polls, 3, `polling stops when the change appears (${result.polls} polls)`);
  assert.match(result.text, /Your changes are now live!/, result.text);
  assert.match(result.background, SUCCESS_GREEN, result.background);
  assert.equal(result.link, 'https://example.com/about');
});

await check('a live page that never changes is NOT reported as a success', async () => {
  const result = await runPoll(() => 'before');
  assert.ok(result.polls > 10, `positive control: polling ran until it gave up (${result.polls} polls)`);
  assert.doesNotMatch(result.text, /✅/, `no success tick: ${result.text}`);
  assert.doesNotMatch(result.text, /live shortly|now live/i, `no claim that it is live: ${result.text}`);
  assert.doesNotMatch(result.background, SUCCESS_GREEN, `not the success colour: ${result.background}`);
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
  assert.doesNotMatch(result.background, SUCCESS_GREEN, result.background);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
