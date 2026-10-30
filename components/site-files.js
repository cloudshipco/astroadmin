/**
 * The site's own files, for CmsImage and CmsVideo (server side only: it is
 * imported from their frontmatter, never shipped to a browser).
 *
 * - `siteRoot`: the site's root directory, from Astro's own config
 *   (`astro:config/server`, Astro >= 6), so it is right when the site is run
 *   from another directory (`astro dev --root ./site`). `process.cwd()` is
 *   only the directory the command was started in.
 * - `publicDir`: `<siteRoot>/public`. Deliberately not Astro's `publicDir`
 *   setting: the components' globs are `/public/images/...` and the admin
 *   uploads into `public/images`, so the lookup here must name the same
 *   folder as those, whatever the site sets.
 * - `publicFile(sitePath)`: the file a `/images/...` value names under
 *   public/ (a `?query` or `#fragment` is not part of the file), or
 *   undefined when it is not one (missing, a folder, outside public/,
 *   a file that is a symlink resolving outside public/ and its own folder,
 *   a malformed %-escape). A symlinked folder is followed.
 * - `imageMetadata(sitePath)`: the focal point and crop the admin stored for
 *   an image in `public/images/.metadata.json` (#82), as
 *   `{ focalPoint: {x, y} | null, crop: {x, y, width, height} | null }`.
 *   The file is an object keyed by site path (`/images/team/x.jpg`), with
 *   legacy entries keyed by bare filename (`x.jpg`); the entry at the site
 *   path (before any `?`/`#`) is read, else, ONLY for a path directly under
 *   `/images/` (`/images/x.jpg`, no further `/`), the one at the bare
 *   filename: the older admin keyed only those, so a legacy `x.jpg` must not
 *   reach `/images/team/x.jpg` (an unrelated photo would take the point, or
 *   be cropped, or fail the build).
 *   It is deployed data, so each value is validated here and anything
 *   malformed (a missing or unparsable file, a non-object entry, a point or
 *   crop out of range) is null. Read with SYNC fs (never fs/promises: see
 *   CLAUDE.md), parsed once per process and re-read when the file's mtime or
 *   size changes, so a point set during `astro dev` reaches the next render.
 *
 * In a build `siteRoot` is the directory the build ran in; nothing here is
 * meant to read files from a deployed server.
 */
import { root } from 'astro:config/server';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCrop } from './crop.js';

export const siteRoot = fileURLToPath(root);
export const publicDir = join(siteRoot, 'public');
const METADATA_FILE = join(publicDir, 'images', '.metadata.json');

let metadataCache; // { mtimeMs, size, entries }

/** The metadata file's entries, re-read when the file changed; `{}` when it is missing or not JSON. */
function metadataEntries() {
  let stat;
  try {
    stat = statSync(METADATA_FILE);
  } catch {
    metadataCache = undefined;
    return {};
  }
  if (metadataCache && metadataCache.mtimeMs === stat.mtimeMs && metadataCache.size === stat.size) {
    return metadataCache.entries;
  }
  let entries = {};
  try {
    const parsed = JSON.parse(readFileSync(METADATA_FILE, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) entries = parsed;
  } catch {
    entries = {}; // half-written by the admin, or not ours: as if absent
  }
  metadataCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
  return entries;
}

function parseFocalPoint(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { x, y } = value;
  for (const number of [x, y]) {
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 100) return null;
  }
  return { x, y };
}

const NO_METADATA = Object.freeze({ focalPoint: null, crop: null });

/** A legacy entry is keyed by bare filename; the older admin keyed only files directly under /images/. */
const LEGACY_KEYED = /^\/images\/([^/]+)$/;

/** The stored `{ focalPoint, crop }` for `sitePath` (e.g. /images/x.jpg); each null when not stored or malformed. */
export function imageMetadata(sitePath) {
  const key = sitePath.split(/[?#]/)[0];
  const entries = metadataEntries();
  const legacyKey = key.match(LEGACY_KEYED)?.[1];
  const entry = [key, ...(legacyKey === undefined ? [] : [legacyKey])]
    .map((candidate) => (Object.hasOwn(entries, candidate) ? entries[candidate] : undefined))
    .find((candidate) => typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate));
  if (!entry) return NO_METADATA;
  return { focalPoint: parseFocalPoint(entry.focalPoint), crop: parseCrop(entry.crop) ?? null };
}

/** The absolute path of the file `sitePath` (e.g. /images/x.jpg) names under public/, or undefined. */
export function publicFile(sitePath) {
  let decoded;
  try {
    decoded = decodeURIComponent(sitePath.split(/[?#]/)[0]);
  } catch {
    return undefined; // a malformed escape (URIError): treat as missing
  }
  const file = normalize(join(publicDir, decoded));
  if (!file.startsWith(publicDir + sep)) return undefined;
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  // A FILE that is itself a symlink is refused when it points out of both
  // public/ and the folder holding it, as the admin's image picker refuses
  // one: the build would copy whatever it points at into the site. A linked
  // FOLDER is the site owner's layout (releases/N/public/images ->
  // /srv/shared/images) and is followed, as CmsImage's glob follows it.
  if (lstatSync(file).isSymbolicLink()) {
    const target = realpathSync(file);
    const inside = [publicDir, dirname(file)].some((folder) => target.startsWith(realpathSync(folder) + sep));
    if (!inside) return undefined;
  }
  return file;
}

/**
 * True when `sitePath` names a file under public/ with exactly that case in
 * every segment below public/, as a case-sensitive filesystem (the server a
 * site deploys to) would find it, also on macOS's case-insensitive one.
 */
export function existsInPublicExactCase(sitePath) {
  const file = publicFile(sitePath);
  if (file === undefined) return false;
  let directory = publicDir;
  for (const segment of file.slice(publicDir.length + 1).split(sep)) {
    if (!readdirSync(directory).includes(segment)) return false;
    directory = join(directory, segment);
  }
  return true;
}

/** True when `sitePath` (e.g. /images/x.jpg) is a file under public/. */
export function existsInPublic(sitePath) {
  return publicFile(sitePath) !== undefined;
}

/** A root-relative path under the site's `base`; anything else (a URL, `//host`) as it is. */
export function withBase(sitePath) {
  if (!sitePath.startsWith('/') || sitePath.startsWith('//')) return sitePath;
  return import.meta.env.BASE_URL.replace(/\/$/, '') + sitePath;
}
