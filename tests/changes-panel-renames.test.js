/**
 * A rename inside the site shows in the Changes panel and counts as a change.
 *
 * `git status` reports a rename only when it is staged (someone `git mv`ed a
 * file in the checkout), and /api/git/status sends it as `renamed: [{from,
 * to}]`. The panel used to read only modified/created/deleted, so a checkout
 * whose only change was a rename showed "No uncommitted changes", the Commit
 * button stayed disabled and the header's count was 0.
 *
 * A renamed row offers no diff or revert: measured against the real server, a
 * revert of the new name is refused (it is not in HEAD), a revert of the old
 * name restores it beside the staged new file (a copy, not an undo), and a
 * diff of the new name shows the whole file as added.
 *
 * The real ui/changes-panel.js in happy-dom, fetch stubbed.
 *
 *   bun tests/changes-panel-renames.test.js
 */

import assert from 'node:assert';
import { Window } from 'happy-dom';

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.confirm = () => false;
globalThis.alert = () => {};

const emptyStatus = { modified: [], created: [], deleted: [], renamed: [] };
let currentStatusBody = emptyStatus;
const commitRequests = [];
globalThis.fetch = async (url, options = {}) => {
  const route = String(url).split('?')[0];
  if (route === '/api/git/status') return jsonResponse({ success: true, status: currentStatusBody });
  if (route === '/api/git/log') return jsonResponse({ success: true, commits: [] });
  if (route === '/api/git/commit') {
    commitRequests.push(JSON.parse(options.body));
    return jsonResponse({ success: true, message: 'ok' });
  }
  throw new Error(`unstubbed fetch ${url}`);
};

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
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const { toggleChangesPanel, getChangesCount } = await import('../ui/changes-panel.js');

async function showStatus(status) {
  currentStatusBody = { ...emptyStatus, ...status };
  const panel = document.getElementById('changesPanel');
  if (!panel) {
    await toggleChangesPanel();
  } else {
    panel.querySelector('[data-refresh-changes]').click();
    await settle();
  }
  return document.getElementById('changesPanel');
}

console.log('\n🧪 renames in the Changes panel\n' + '='.repeat(40));

const RENAME = { from: 'src/content/pages/about.md', to: 'src/content/pages/about-us.md' };

await check('control: with no changes the list is empty and Commit is disabled', async () => {
  const panel = await showStatus({});
  assert.equal(panel.querySelectorAll('.change-item').length, 0);
  assert.equal(panel.querySelector('[data-commit-changes]').disabled, true);
  assert.equal(await getChangesCount(), 0);
});

await check('a rename alone is one row, old name to new, and enables Commit', async () => {
  const panel = await showStatus({ renamed: [RENAME] });
  const rows = panel.querySelectorAll('.change-item');
  assert.equal(rows.length, 1, panel.querySelector('[data-changes-list]').innerHTML);
  const row = rows[0];
  assert.equal(row.querySelector('.change-type').textContent, 'R');
  assert.ok(row.querySelector('.change-type').classList.contains('change-type-renamed'));
  assert.equal(row.querySelector('.change-file').textContent, '.../pages/about.md → .../pages/about-us.md');
  assert.equal(row.querySelector('.change-file').getAttribute('title'), `${RENAME.from} → ${RENAME.to}`);
  assert.equal(panel.querySelector('[data-commit-changes]').disabled, false, 'Commit stays disabled');
});

await check('a renamed row offers no diff or revert (the server refuses or half-does both)', async () => {
  const panel = await showStatus({ renamed: [RENAME], modified: ['src/content/pages/home.md'] });
  const rows = [...panel.querySelectorAll('.change-item')];
  assert.equal(rows.length, 2);
  const renamedRow = rows.find((row) => row.querySelector('.change-type-renamed'));
  const modifiedRow = rows.find((row) => row.querySelector('.change-type-modified'));
  assert.equal(renamedRow.querySelectorAll('[data-view-diff], [data-revert-file]').length, 0);
  // Positive control: an ordinary row keeps both actions.
  assert.equal(modifiedRow.querySelector('[data-view-diff]').dataset.viewDiff, 'src/content/pages/home.md');
  assert.equal(modifiedRow.querySelector('[data-revert-file]').dataset.revertFile, 'src/content/pages/home.md');
});

await check('getChangesCount counts renames', async () => {
  currentStatusBody = { ...emptyStatus, renamed: [RENAME] };
  assert.equal(await getChangesCount(), 1);
  currentStatusBody = { ...emptyStatus, renamed: [RENAME], modified: ['a.md'], created: ['b.md'], deleted: ['c.md'] };
  assert.equal(await getChangesCount(), 4);
});

await check('a status without `renamed` still renders (older server shape)', async () => {
  currentStatusBody = { modified: ['src/content/pages/home.md'], created: [], deleted: [] };
  const panel = document.getElementById('changesPanel');
  panel.querySelector('[data-refresh-changes]').click();
  await settle();
  assert.equal(panel.querySelectorAll('.change-item').length, 1);
  assert.equal(await getChangesCount(), 1);
});

await check('the default commit message names the rename', async () => {
  const panel = await showStatus({ renamed: [RENAME] });
  panel.querySelector('[data-commit-changes]').click();
  await settle();
  document.querySelector('#commitModal [data-confirm-commit]').click();
  await settle();
  assert.equal(commitRequests.length, 1, 'commit request sent');
  assert.equal(commitRequests[0].message, 'Renamed 1 file');
});

await check('confirming the commit dialog before its textarea is focused throws nothing', async () => {
  const uncaught = [];
  const record = (error) => uncaught.push(error?.error ?? error);
  window.addEventListener('error', record);
  process.on('uncaughtException', record);
  try {
    const panel = await showStatus({ renamed: [RENAME] });
    panel.querySelector('[data-commit-changes]').click();
    await settle();
    // Confirm within the dialog's 100 ms focus delay, as a quick Enter does.
    document.querySelector('#commitModal [data-confirm-commit]').click();
    assert.equal(document.querySelector('#commitModal'), null, 'control: the dialog closed');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(uncaught.map(String), []);
  } finally {
    window.removeEventListener('error', record);
    process.off('uncaughtException', record);
  }
});

await check('hostile names in a rename are text, in the row and its title', async () => {
  const hostileRename = {
    from: 'src/content/pages/a"><img src=x onerror=alert(1)>.md',
    to: 'src/content/pages/<b>bold&amp;.md',
  };
  const panel = await showStatus({ renamed: [hostileRename] });
  const row = panel.querySelector('.change-item');
  assert.equal(panel.querySelectorAll('img, b, [onerror]').length, 0, row.innerHTML);
  assert.equal(row.querySelector('.change-file').getAttribute('title'), `${hostileRename.from} → ${hostileRename.to}`);
  assert.equal(row.querySelector('.change-file').textContent,
    '.../pages/a"><img src=x onerror=alert(1)>.md → .../pages/<b>bold&amp;.md');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
