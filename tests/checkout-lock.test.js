/**
 * server/utils/checkout-lock.js: writes share the checkout, publish's
 * commit-and-rebase has it to itself, and neither starves the other.
 *
 *   bun tests/checkout-lock.test.js
 */

import assert from 'assert';
import { withCheckoutWrite, withCheckoutExclusive } from '../server/utils/checkout-lock.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

let passed = 0;
// A lock bug usually shows as a deadlock: fail it by deadline, not by hanging.
async function check(name, fn) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${name}: still waiting after 3 s (deadlock)`)), 3000);
  });
  try {
    await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(timer);
  }
  passed++;
  console.log(`✅ ${name}`);
}

await check('writes run at the same time', async () => {
  const events = [];
  const first = gate();
  const a = withCheckoutWrite(async () => { events.push('a start'); await first.opened; events.push('a end'); });
  const b = withCheckoutWrite(async () => { events.push('b'); });
  await b;
  assert.deepEqual(events, ['a start', 'b'], 'b did not wait for a');
  first.open();
  await a;
});

await check('the exclusive hold waits for running writes, and later writes wait for it', async () => {
  const events = [];
  const write = gate();
  const exclusiveGate = gate();
  const running = withCheckoutWrite(async () => { events.push('write 1 start'); await write.opened; events.push('write 1 end'); });
  const exclusive = withCheckoutExclusive(async () => { events.push('exclusive start'); await exclusiveGate.opened; events.push('exclusive end'); });
  const later = withCheckoutWrite(async () => { events.push('write 2'); });
  await tick();
  assert.deepEqual(events, ['write 1 start'], 'exclusive waits for write 1; write 2 waits for the exclusive');
  write.open();
  await tick();
  assert.deepEqual(events, ['write 1 start', 'write 1 end', 'exclusive start']);
  exclusiveGate.open();
  await Promise.all([running, exclusive, later]);
  assert.deepEqual(events, ['write 1 start', 'write 1 end', 'exclusive start', 'exclusive end', 'write 2']);
});

await check('exclusive holds run one at a time, and a failure releases the lock', async () => {
  const events = [];
  const failing = withCheckoutExclusive(async () => { events.push('x1'); throw new Error('boom'); });
  const next = withCheckoutExclusive(async () => { events.push('x2'); });
  await assert.rejects(failing, /boom/);
  await next;
  await withCheckoutWrite(async () => { events.push('write'); });
  assert.deepEqual(events, ['x1', 'x2', 'write']);
});

await check('a failing write releases its hold', async () => {
  await assert.rejects(withCheckoutWrite(async () => { throw new Error('write failed'); }), /write failed/);
  let ran = false;
  await withCheckoutExclusive(async () => { ran = true; });
  assert.equal(ran, true);
});

await check('a write nested inside a write runs, even with an exclusive hold waiting', async () => {
  const events = [];
  const outer = gate();
  const running = withCheckoutWrite(async () => {
    events.push('outer start');
    await outer.opened;
    await withCheckoutWrite(async () => { events.push('nested'); });
    events.push('outer end');
  });
  await tick();
  const exclusive = withCheckoutExclusive(async () => { events.push('exclusive'); });
  await tick();
  outer.open();
  await Promise.all([running, exclusive]);
  assert.deepEqual(events, ['outer start', 'nested', 'outer end', 'exclusive']);
});

await check('asking for the exclusive hold from inside a write is refused, not a deadlock', async () => {
  await withCheckoutWrite(async () => {
    await assert.rejects(withCheckoutExclusive(async () => {}), /would deadlock/);
  });
});

await check('a continuation scheduled inside a write, running after it, takes a hold of its own', async () => {
  const startLate = gate();
  let pendingWrite;
  await withCheckoutWrite(async () => {
    // Scheduled here, so it carries this hold's async context after it ends.
    pendingWrite = startLate.opened.then(() => withCheckoutWrite(async () => 'own hold'));
  });
  const exclusiveGate = gate();
  const exclusive = withCheckoutExclusive(() => exclusiveGate.opened);
  await tick();
  startLate.open();
  let settled = false;
  pendingWrite.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'the late write waits for the exclusive hold');
  exclusiveGate.open();
  assert.equal(await pendingWrite, 'own hold');
  await exclusive;
});

console.log(`\n📊 ${passed} checks passed.`);
