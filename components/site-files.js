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
 *
 * In a build `siteRoot` is the directory the build ran in; nothing here is
 * meant to read files from a deployed server.
 */
import { root } from 'astro:config/server';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const siteRoot = fileURLToPath(root);
export const publicDir = join(siteRoot, 'public');

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
