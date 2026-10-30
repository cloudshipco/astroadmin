/**
 * The refusal bodies Publish and the commit route send say "committed" only
 * when this request committed something. A publish with nothing new to
 * commit can still be refused (its rebase of earlier local commits
 * conflicts, or its push fails), and then the editor's changes were not
 * committed by it. <1 s.
 *
 *   bun tests/publish-bodies.test.js
 */

import assert from 'assert';

const { conflictBody, localChangesBody, pushFailureBody } = await import('../server/api/publish.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
  }
}

const commitResult = { commit: 'abc1234', summary: { changes: 1, insertions: 1, deletions: 0 } };
for (const [name, body] of [['conflictBody', conflictBody], ['localChangesBody', localChangesBody], ['pushFailureBody', pushFailureBody]]) {
  check(`${name}: committed says so`, () => {
    const sent = body({ committed: true, commitResult });
    assert.equal(sent.committed, true);
    assert.match(sent.message, /^Your changes are saved and committed, but /);
    assert.deepEqual(sent.commit, { hash: 'abc1234', summary: commitResult.summary });
  });
  check(`${name}: not committed does not claim a commit`, () => {
    const sent = body({ committed: false });
    assert.equal(sent.committed, false);
    assert.equal(sent.commit, null);
    assert.match(sent.message, /^Your changes are saved, but /);
    assert.doesNotMatch(sent.message, /committed/);
  });
}

console.log(`\n📊 ${passed} passed, ${failed} failed.`);
process.exitCode = failed > 0 ? 1 : 0;
