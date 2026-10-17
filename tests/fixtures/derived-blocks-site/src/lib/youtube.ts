// Derived from the same site (comments removed): the video block's URL check.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = /* @__PURE__ */ new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const SHORT_HOST = "youtu.be";
const YOUTUBE_URL_MESSAGE = "Paste a YouTube link, e.g. https://www.youtube.com/watch?v=\u2026";
function youtubeVideoId(input) {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  let candidate = null;
  if (host === SHORT_HOST) {
    candidate = url.pathname.match(/^\/([^/]+)\/?$/)?.[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === "/watch" || url.pathname === "/watch/") {
      candidate = url.searchParams.get("v");
    } else {
      candidate = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/)?.[1] ?? null;
    }
  }
  return candidate !== null && VIDEO_ID.test(candidate) ? candidate : null;
}
const LOCAL_PATH = /^\/[^\\"<>\u0000-\u001f\u007f]*$/;
const PROTOCOL_RELATIVE = /^\/\//;
function isLocalPosterPath(value) {
  return value === "" || LOCAL_PATH.test(value) && !PROTOCOL_RELATIVE.test(value) && value.length > 1;
}
export {
  YOUTUBE_URL_MESSAGE,
  isLocalPosterPath,
  youtubeVideoId
};
