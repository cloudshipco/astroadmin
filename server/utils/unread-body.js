/**
 * End the connection of a response sent before its request's body was read.
 *
 * Bun's node:http (1.3.4) does not discard a request body the app never read:
 * on a kept-alive connection the leftover bytes are parsed as the next
 * request, which then gets a 431 or hangs until the client gives up. Node
 * discards them itself. A refusal sent before reading (a 401 from requireAuth
 * on an entry save, which is parsed only after sign-in, or a 403 from the
 * same-origin check) is that case. `Connection: close` alone does not stop
 * Bun reusing the connection, so the socket is destroyed once the response has
 * been written.
 *
 * Bun reports `req.complete` false for a request with no body (a GET) too, so
 * only a request that declares a body counts.
 */
export function closeIfBodyUnread(req, res, next) {
  res.on('finish', () => {
    if (req.complete || !declaresBody(req)) return;
    req.socket?.destroy();
  });
  next();
}

function declaresBody(req) {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = Number(req.headers['content-length']);
  return Number.isFinite(length) && length > 0;
}
