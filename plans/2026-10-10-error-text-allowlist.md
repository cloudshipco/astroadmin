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
