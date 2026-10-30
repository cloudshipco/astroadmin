/**
 * The order of one editor page's saves (#103).
 *
 * The dashboard numbers every save it sends (`saveOrder: {client, number}`,
 * one random client id per page load). Saves can reach the file's write queue
 * out of order: a save sent as the page is left cannot wait for one already in
 * flight, and the route awaits schema work before it queues. So the store,
 * inside the queue, writes a save only if that page has not already had a
 * newer one written to the same file; an older one is acknowledged unwritten
 * (`superseded`). The same number again is a repeat (the client re-sends a
 * keepalive request the browser refused, which may have arrived): not
 * written twice, and answered as written.
 * Saves from different pages (or tabs), and saves without `saveOrder`, are
 * written in arrival order as before.
 */

const CLIENT_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
// Records are tiny; the least recently written go once there are this many.
// An evicted page's older save would then be written as it arrives, which
// needs that save to wait while 5000 other page-and-file pairs are written.
const MAX_RECORDS = 5000;

/** @type {Map<string, number>} `<file key>\0<client>` -> the newest number written */
const newestWritten = new Map();

/**
 * A request's `saveOrder`, or null when it has none or it is malformed (then
 * the save is written in arrival order).
 * @param {*} value
 * @returns {{client: string, number: number}|null}
 */
export function parseSaveOrder(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { client, number } = value;
  if (typeof client !== 'string' || !CLIENT_PATTERN.test(client)) return null;
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { client, number };
}

const recordKey = (fileKey, order) => `${fileKey}\0${order.client}`;

/**
 * What to do with a save, asked inside the file's write queue: 'write' it,
 * or not, as a 'repeat' of the newest one written (answered as written) or as
 * 'superseded' by a newer one.
 * @param {string} fileKey - the file, and for a file() entry its id
 * @param {{client: string, number: number}|null} order
 * @returns {'write'|'repeat'|'superseded'}
 */
export function saveOrderVerdict(fileKey, order) {
  if (!order) return 'write';
  const newest = newestWritten.get(recordKey(fileKey, order));
  if (newest === undefined || order.number > newest) return 'write';
  return order.number === newest ? 'repeat' : 'superseded';
}

/**
 * Record a save as written, after its write succeeded (a failed write must not
 * make its own retry look superseded).
 * @param {string} fileKey
 * @param {{client: string, number: number}|null} order
 */
export function recordWrittenSave(fileKey, order) {
  if (!order) return;
  const key = recordKey(fileKey, order);
  newestWritten.delete(key);
  newestWritten.set(key, order.number);
  if (newestWritten.size > MAX_RECORDS) newestWritten.delete(newestWritten.keys().next().value);
}
