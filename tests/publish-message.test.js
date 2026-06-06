import assert from 'assert';
import { buildPublishMessage } from '../server/api/publish.js';

const cases = [
  {
    name: 'commit and push',
    input: { gitEnabled: true, committed: true, pushed: true, deployResult: null },
    expected: 'Published: committed and pushed',
  },
  {
    name: 'commit without push',
    input: { gitEnabled: true, committed: true, pushed: false, deployResult: null },
    expected: 'Published: committed',
  },
  {
    name: 'push without commit',
    input: { gitEnabled: true, committed: false, pushed: true, deployResult: null },
    expected: 'Published: pushed',
  },
  {
    name: 'git enabled no work',
    input: { gitEnabled: true, committed: false, pushed: false, deployResult: null },
    expected: 'Nothing to publish (no git changes, no deploy adapter configured)',
  },
  {
    name: 'git disabled no deploy',
    input: { gitEnabled: false, committed: false, pushed: false, deployResult: null },
    expected: 'Nothing to publish (git disabled, no deploy adapter configured)',
  },
];

console.log('\n🧪 Publish message\n' + '='.repeat(40));

let passed = 0;
for (const testCase of cases) {
  assert.equal(buildPublishMessage(testCase.input), testCase.expected, testCase.name);
  passed++;
  console.log(`✅ ${testCase.name}`);
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
