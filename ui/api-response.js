/**
 * Read an /api response body as JSON, without turning a refusal into a
 * parse error.
 *
 * A 429 is never a result: it throws an error whose message says when to try
 * again ("Too many requests, try again in 3 minutes."), from the admin's JSON
 * body or the Retry-After header. A response that is not JSON at all (a proxy's
 * HTML error page, nginx's own 429) throws a readable error instead of
 * "Unexpected token ... is not valid JSON". Any other JSON body is returned
 * whatever the status, because callers read `error` from a 400 or 401.
 */

/** Thrown for a 429; `rateLimited` lets a caller show the message as is. */
export class ApiResponseError extends Error {
  /**
   * @param {string} message
   * @param {{status: number, rateLimited?: boolean}} details
   */
  constructor(message, { status, rateLimited = false }) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

/**
 * "Too many requests, try again in N minutes." from a Retry-After value.
 * @param {string|null} retryAfter - seconds, or an HTTP date
 * @param {number} [now]
 */
export function tooManyRequestsMessage(retryAfter, now = Date.now()) {
  let seconds = NaN;
  if (retryAfter !== null && retryAfter !== undefined && retryAfter !== '') {
    seconds = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : (Date.parse(retryAfter) - now) / 1000;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Too many requests, try again in a few minutes.';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many requests, try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * @param {Response} response
 * @returns {Promise<any>}
 */
export async function readJson(response) {
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  if (response.status === 429) {
    let message = null;
    if (isJson) {
      try {
        const body = await response.json();
        if (typeof body?.message === 'string' && body.message !== '') message = body.message;
      } catch { /* fall back to the header */ }
    }
    throw new ApiResponseError(message || tooManyRequestsMessage(response.headers.get('retry-after')), { status: 429, rateLimited: true });
  }
  if (!isJson) {
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    throw new ApiResponseError(`The server answered ${response.status}${statusText} instead of data.`, { status: response.status });
  }
  return response.json();
}

/**
 * A failure line for a notification: the bare `prefix`, or with the reason
 * when the reason is a rate limit (which the editor can act on).
 * @param {string} prefix - e.g. "Failed to save changes"
 * @param {unknown} error
 */
export function failureText(prefix, error) {
  return error instanceof ApiResponseError && error.rateLimited ? `${prefix}: ${error.message}` : prefix;
}
