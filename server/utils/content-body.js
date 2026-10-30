/**
 * The body of an entry save (/api/content): read as it arrives, parsed only
 * after sign-in.
 *
 * Read at once: a save sent as a page is left (keepalive, #103) can arrive on
 * a connection the closing page then ends, and Bun drops a request body no one
 * has read by then ("stream is not readable"); a body read on arrival is kept.
 * Parsed after requireAuth: the JSON parse is the costly part, and an entry
 * may be up to CONTENT_BODY_LIMIT, so a request with no session never gets it.
 * The parse refuses what express.json() refuses, with its error types, so the
 * app's error handler answers them the same way (#104): a body whose top level
 * is not an object or array (strict), malformed JSON, a charset other than
 * UTF-8.
 */

import express from 'express';

export const CONTENT_BODY_LIMIT = '5mb';

/** Read a JSON request's body into a Buffer (req.body), up to the limit. */
export const readContentBody = express.raw({ type: 'application/json', limit: CONTENT_BODY_LIMIT });

const STRICT_START = /^[\x20\x09\x0a\x0d]*([\[{])/;

/** After sign-in: turn the Buffer readContentBody kept into the parsed body. */
export function parseContentBody(req, res, next) {
  if (!Buffer.isBuffer(req.body)) return next();
  const charset = contentCharset(req);
  if (charset !== 'utf-8') {
    return next(createError(415, `unsupported charset "${charset.toUpperCase()}"`, { charset, type: 'charset.unsupported' }));
  }
  const text = req.body.toString('utf8');
  if (text.length === 0) {
    req.body = {};
    return next();
  }
  if (!STRICT_START.test(text)) {
    return next(createError(400, 'the request body must be an object or array', { type: 'entity.parse.failed' }));
  }
  try {
    req.body = JSON.parse(text);
  } catch (error) {
    return next(createError(400, error.message, { type: 'entity.parse.failed' }));
  }
  next();
}

// The shape body-parser's errors have (status, type), which the app's error
// handler reads.
function createError(status, message, { type, ...details }) {
  return Object.assign(new Error(message), { status, statusCode: status, expose: true, type, ...details });
}

function contentCharset(req) {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(req.headers['content-type'] || '');
  return match ? match[1].toLowerCase() : 'utf-8';
}
