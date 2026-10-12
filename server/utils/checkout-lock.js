/**
 * Who may write to the site's checkout, and when.
 *
 * Saves, deletes, reverts and image writes (an upload is installed only once
 * complete; multer streams it into a temporary folder outside the site) are
 * SHARED holds: any number run at once (each file keeps its own write
 * queue). Publish's commit-and-rebase is the EXCLUSIVE hold: it waits for the running writes to finish, and writes
 * that arrive meanwhile wait for it. Without this, a save landing mid-rebase
 * was wiped by `rebase --abort` (a hard reset) after it had been acknowledged,
 * and a save landing between the commit and the pull made git refuse the pull.
 *
 * Shared holds are reentrant: a task already inside one runs nested writes
 * directly (a write that calls a helper which takes its own hold).
 * Re-acquiring would deadlock behind an exclusive hold waiting for the outer
 * one. Asking for the exclusive hold from inside a shared one throws, for the
 * same reason.
 *
 * In-process only: one admin server per checkout.
 */

import { AsyncLocalStorage } from 'async_hooks';

/** @type {AsyncLocalStorage<{active: boolean}>} */
const sharedHold = new AsyncLocalStorage();
const insideSharedHold = () => sharedHold.getStore()?.active === true;

let activeWrites = 0;
let exclusiveHeld = false;
/** @type {Array<() => void>} resolved when the lock state may now admit them */
let waiters = [];

function wakeWaiters() {
  const waiting = waiters;
  waiters = [];
  for (const wake of waiting) wake();
}

const nextChange = () => new Promise((resolve) => waiters.push(resolve));

// Exclusive holds queue among themselves, so a stream of saves cannot starve
// a publish: once one is queued, new writes wait for it.
let exclusiveQueue = Promise.resolve();
let exclusiveWaiting = 0;

/** Run a task that writes files in the checkout. */
export async function withCheckoutWrite(task) {
  if (insideSharedHold()) return task();
  while (exclusiveHeld || exclusiveWaiting > 0) await nextChange();
  activeWrites++;
  // Marked inactive on release, so a continuation that outlives the task
  // (scheduled from inside it) acquires its own hold.
  const hold = { active: true };
  try {
    return await sharedHold.run(hold, task);
  } finally {
    hold.active = false;
    activeWrites--;
    wakeWaiters();
  }
}

/** Run a task that needs the checkout to itself (commit, pull, rebase, abort). */
export function withCheckoutExclusive(task) {
  if (insideSharedHold()) {
    return Promise.reject(new Error('withCheckoutExclusive called inside a shared checkout hold (would deadlock)'));
  }
  exclusiveWaiting++;
  const run = exclusiveQueue.then(async () => {
    while (activeWrites > 0) await nextChange();
    exclusiveWaiting--;
    exclusiveHeld = true;
    try {
      return await task();
    } finally {
      exclusiveHeld = false;
      wakeWaiters();
    }
  });
  exclusiveQueue = run.catch(() => {});
  return run;
}
