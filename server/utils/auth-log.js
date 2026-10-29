/**
 * The failed-login log line, for a host's fail2ban (or any log watcher):
 *
 *   [2026-10-29T14:03:07.412+00:00] auth.failed ip=203.0.113.9
 *
 * One line per refused login, always this shape. The address is `req.ip`,
 * which is the socket address unless the app trusts a proxy (production
 * trusts one, so it is the address nginx passed on). Nothing the client typed
 * (the username, a header) is written, so no request can forge a second line
 * or an address of its choosing: an address that does not parse as one is
 * written as `ip=invalid`.
 *
 * The line is written by the login handler, which runs after the same-origin
 * guard, so a cross-site page cannot get a victim's browser to produce it
 * (unlike a status code in the web server's access log).
 */

import { clientAddress } from './client-address.js';

/** `2026-10-29T14:03:07.412+01:00`: local time with its UTC offset. */
export function isoWithOffset(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const pad = (number, width = 2) => String(number).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/**
 * The address as fail2ban should see it: the client's own (IPv4-mapped IPv6
 * unwrapped), never the /56 the rate limits group it into, since fail2ban
 * bans single addresses (server/utils/client-address.js).
 */
export function loggableAddress(address) {
  return clientAddress(address) ?? 'invalid';
}

/**
 * @param {string | undefined} address req.ip
 * @param {Date} [date]
 */
export function authFailedLine(address, date = new Date()) {
  return `[${isoWithOffset(date)}] auth.failed ip=${loggableAddress(address)}`;
}
