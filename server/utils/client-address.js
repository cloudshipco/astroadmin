/**
 * A client's address, in the two forms the server needs:
 *
 * - `clientAddress` is the address itself, for the log: an IPv4-mapped IPv6
 *   address (`::ffff:203.0.113.9`, how a dual-stack socket reports an IPv4
 *   client) is unwrapped to its IPv4 form, and anything that is not an
 *   address is null. fail2ban bans single addresses, so the log names the
 *   client's own.
 * - `rateLimitKey` is what the rate limits count against: an IPv4 address
 *   as it is, and an IPv6 address by its /56 network. One IPv6 client is
 *   usually given a whole /64, often a /56 or a /48, so counting each
 *   address on its own lets it rotate through addresses and never reach a
 *   budget. /56 is express-rate-limit 8's default: it groups the common
 *   residential delegation (a /56) and every /64 inside it, while a /48
 *   would put whole organisations' networks behind one budget.
 *
 * The address is `req.ip`, which comes from X-Forwarded-For only when the
 * request came through a trusted proxy (`trust proxy`, server/index.js).
 */

import net from 'net';

/** IPv6 prefix length the rate limits group by. */
export const IPV6_RATE_LIMIT_PREFIX = 56;

/**
 * The address with an IPv4-mapped IPv6 form unwrapped and any zone index
 * (`%en0`) removed, or null when it is not an IP address.
 * @param {unknown} address
 * @returns {string | null}
 */
export function clientAddress(address) {
  if (typeof address !== 'string') return null;
  const withoutZone = address.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(withoutZone);
  const unwrapped = mapped && net.isIPv4(mapped[1]) ? mapped[1] : withoutZone;
  return net.isIP(unwrapped) ? unwrapped : null;
}

/**
 * The eight 16-bit groups of a valid IPv6 address (`::` expanded, a dotted
 * IPv4 tail turned into two groups).
 * @param {string} address - net.isIPv6(address) is true
 * @returns {number[]}
 */
function ipv6Groups(address) {
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const parse = (part) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const headGroups = parse(head);
  if (tail === undefined) return headGroups;
  const tailGroups = parse(tail);
  return [...headGroups, ...new Array(8 - headGroups.length - tailGroups.length).fill(0), ...tailGroups];
}

/**
 * The key the rate limits count an address against: `ipv4:<address>`, or
 * `ipv6:<network>/56`. Anything that is not an address shares one key, so
 * it cannot escape the budget either.
 * @param {unknown} address req.ip
 * @returns {string}
 */
export function rateLimitKey(address) {
  const client = clientAddress(address);
  if (client === null) return 'invalid';
  if (net.isIPv4(client)) return `ipv4:${client}`;
  const groups = ipv6Groups(client);
  const fullGroups = Math.floor(IPV6_RATE_LIMIT_PREFIX / 16);
  const partialBits = IPV6_RATE_LIMIT_PREFIX % 16;
  const network = groups.slice(0, fullGroups);
  if (partialBits > 0) network.push(groups[fullGroups] & ((0xffff << (16 - partialBits)) & 0xffff));
  return `ipv6:${network.map((group) => group.toString(16)).join(':')}::/${IPV6_RATE_LIMIT_PREFIX}`;
}
