# Error text the editor sees: an allowlist, not a scrubber

## Problem

Server errors reached editors with absolute server paths in them. The fix was
a redactor that scrubs any text: known directories made relative, other
absolute paths cut to their last segment, quoted paths as tokens, `../`
climbs resolved, URLs exempted. Review rounds 2, 3, 4 and 5 each found another
shape it missed (spaces, apostrophes, backticks, `file://` with `%20`, query
strings) or over-redacted (`'/about'` in a zod enum message became `'about'`).
Scrubbing free text cannot be made complete.

## Decision

Only one kind of error text is worth showing an editor verbatim: the site's
own Astro build failing the publish check, because it names the entry and
field to fix. Everything else gets a fixed message.

- **API errors** (git, filesystem, uploads, schema reload, content routes,
  collections, build, deploy): the response carries a fixed, route-specific
  message ("Couldn't save the image", "Couldn't read this entry"), never
  `error.message`. The full error is logged on the server. Where an error is
  the editor's to fix and carries no path (a validation refusal, a missing
  entry, an invalid slug), the route's own message stays as it is today.
- **The publish check's 422** (and the doctor's build output): Astro's output,
  with ANSI codes and stack frames stripped and the KNOWN roots removed (the
  check's worktree, the project root, their realpaths). No generic rule
  rewrites other paths or quoted values. If what remains still contains an
  absolute path outside those roots (a git error from an external git
  directory, say), the output is replaced by a fixed message and logged.
- **A missing git identity** keeps its specific, path-free advice.

## Removed

The generic redaction rules: quoted-token handling, `../` climb resolution,
the unquoted-absolute-path regex, URL exemptions, HOME exclusions.
`clientErrorMessage` becomes "fixed message plus server log".

## Tests

- Each API route's failure returns its fixed message and no path, with a
  positive control that the failure really happened, and the full error in
  the server log.
- The 422 keeps Astro's real message (entry and field names, `'/about'`-style
  values, URLs) with the worktree and project roots removed.
- A 422 whose output names an absolute path outside the known roots falls back
  to the fixed message.
- Every round 2-5 leak case from the review files becomes a regression case.

## Round 6: the 422 carries no Astro text

Showing Astro's output with server paths "detected and hidden" kept failing
review the same way the scrubber did (a sibling `/srv/site,backup`, Windows
and absent mount points missed; zod values like `'/home/about'` hidden), and
on the hosted box a sibling directory names another client's site. So the
publish check's refusal is built from structured parts only:

- the entries Astro refused (the ids already parsed from its output);
- the Astro error code, mapped to a plain sentence for the codes editors hit
  (invalid entry data, a missing image file, an MDX/markdown syntax error,
  ...); any other code reads "Astro refused the build (<code>); see the
  server log";
- for each refused entry, AstroAdmin's own schema validation of it (field
  paths, messages and accepted values; this text is ours).

Astro's raw output goes to the server log only. The same applies to the
production build and the doctor's build output; build responses carry no
configured command line, and a deploy response carries chosen status fields,
not adapter output.

Done (2026-10-11): `server/utils/build-failure.js` builds the refusal; the
redactor (`redact-server-paths.js`) is deleted. Codes are read from Astro's
`[Code]` / `Code:` lines; frontmatter YAML errors (js-yaml prints no code)
and MDX syntax errors (a rule id such as `(mdx-jsx:...)`) are recognised by
their own shape. Entries come only from the checked commit, and their
validation reads the committed text (`git show`), not the live tree. One
loss: Astro's MDX syntax error names no file, so the editor learns that an
MDX entry is broken but not which one (the log has the line and column).

Round 7 (done, shipped in 1.6.0 on 2026-10-11): a refused entry is listed only
when it is CONFIRMED in the checked commit: a Location line pointing at a
committed regular file of the same collection, or an id computed as Astro 7
assigns it (a frontmatter `slug` first; full `file()` ids, spaces included)
matching exactly one committed entry. A missing image is blamed only on an
entry whose own `./` or `../` reference fails to resolve in the commit (body
images read with the site's markdown processor). Validation uses the checked
commit's schemas, never the live cache. Otherwise the editor gets the code's
sentence with no entry. Deferred to #66: the commit's schema parse uses
`fs/promises` (capped at 20 s, falls back to listing the entry unchecked).
