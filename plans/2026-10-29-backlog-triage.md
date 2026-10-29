# Backlog triage and the first fix wave

Status: RELEASED as 1.10.0 (2026-10-29, tag v1.10.0 at 1748ee3; npm shasum
04e1aeb, the tarball packed from that commit). A minor release: the commit log
is narrower, `file()` ids are read-only, top-level lists are edited inline, and
sites can label any field. Before publishing: #39, #54's message, #81, and a
real-browser check of main on a copy of a real site (all collections, blocks,
the modal stack, the Changes panel), which found the commit-dialog focus bug.

## Triage

I checked all 48 open issues against the code at a985bb3, reading the code and
`git log` only.

- Closed as fixed: #15 (nested slugs), #30 (nullable/union), #31 (date-time).
  Closed as obsolete with the shelved SQLite store: #4, #11.
- To close once this is pushed: #28 (the README now says Astro 7 is tested),
  #43 (the case reported in the wild is fixed; the rest is #69 and #70).
- #82 (focal point): its body now has the design notes. One point per image in
  `.metadata.json`, read by CmsImage through `components/site-files.js`
  (`publicFile`, from #79). Open questions: images keyed by bare filename
  across three folders, `image()` fields out of scope, CmsVideo out of phase 1.
- Still open: #67 (git hardening; port `feat/auth-commit-hardening`), #10
  (rsync `--delete` has no guard), #40 (login limiter), #64 (simple-git 4),
  and the #69/#70 pair, which needs a design first.

## Fixed

Each fix got a failing test first. Five parallel lanes, each in its own
worktree, then a fresh three-reviewer pass, then two more lanes for what the
review found.

| Issue | Fix |
|---|---|
| #34 | A top-level list whose items are not objects is edited inline, as a field's list is (`TOP_LEVEL_LIST_KEY`); only lists of objects are cards. The review found that the first version missed unions and nested lists. |
| #35 | `ui/modal-stack.js`: one document listener sends Escape to the topmost modal only. |
| #68 | Git routes return only the site's own files: `scopeRepoPath`, renames checked at both ends, the pull's files read from git between the HEADs, `--relative` diffs, a log limited to the git paths. |
| #71 | A markdown entry with no body is saved without a blank line after `---`. |
| #72 | A `file()` entry's identity field is read-only: `id` if the entry has one, else `slug`. A save keeps the identity's key and type. |
| #78 | CmsImage serves the files it does not optimise under the site's `base`. |
| #79 | `components/site-files.js` gets the site root from `astro:config/server`, not `process.cwd()`. |
| #80 | A library video opened in its own tab plays: videos get `media-src 'self'; sandbox allow-same-origin`, with no `allow-scripts`. The reason was measured in Chromium: from an opaque origin the request is cross-site, so no session cookie is sent, and without CORS the response is discarded. |

Fixes from the review:
- the git log and file-history `limit` is clamped to 1..100;
- renames show in the Changes panel;
- problem marks reach the items of a top-level list;
- the schema markers are defined once (`ui/schema-markers.js`);
- numeric `file()` ids are found the way Astro finds them, and stay numbers.

## Found and not done

- Publish is blocked by any uncommitted change in the repository, even one
  outside the site, because `pull --rebase` refuses. Worth an issue.
- `stageGitPaths` stages the raw `git.paths`, not `getAllowedGitPaths`.
- The files store cannot edit object-shaped `file()` JSON (`{ "<id>": {...} }`),
  though Astro and the validator accept it.
- With a custom `publicDir`, CmsImage and CmsVideo find nothing: their globs
  are `/public/images`.
- Closing a stacked modal unlocks page scroll while the modal under it is
  still open. The modal stack could own scroll locking.
- `openArrayEditor` may be dead code.
- A whole-list problem on an inline top-level list has no field mark.
