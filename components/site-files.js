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
 *   public/, or undefined when it is not one (missing, a folder, outside
 *   public/, a malformed %-escape).
 *
 * In a build `siteRoot` is the directory the build ran in; nothing here is
 * meant to read files from a deployed server.
 */
import { root } from 'astro:config/server';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const siteRoot = fileURLToPath(root);
export const publicDir = join(siteRoot, 'public');

/** The absolute path of the file `sitePath` (e.g. /images/x.jpg) names under public/, or undefined. */
export function publicFile(sitePath) {
  let decoded;
  try {
    decoded = decodeURIComponent(sitePath);
  } catch {
    return undefined; // a malformed escape (URIError): treat as missing
  }
  const file = normalize(join(publicDir, decoded));
  if (!file.startsWith(publicDir + sep)) return undefined;
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
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
