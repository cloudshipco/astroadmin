# Backlog triage 2 and the second fix wave

Status: RELEASED as 1.11.0 (2026-10-30, tag v1.11.0 at 58ac79b; npm shasum dfdbc0d, the tarball packed from that commit). The structural git fix is #93; open from this wave: #91, #92.
plus #89 are on main, and the gate passed on the combined tree: `npm test`
76/76, and every slow test by name. Decisions: #83 rebases in a throwaway
worktree inside the exclusive hold (not the check's worktree, which would mean
holding the lock through the build) and moves the live checkout with
`reset --keep`; #70 drops a block `""` only where the site's real zod refuses it
at that path (#69's top level kept and pinned); #3 deletes `server/api/build.js`.
Triage of all 38 open issues at 32da2eb (main
and origin/main), by four read-only agents reading the code, `git log` and
the issue threads, plus a happy-dom probe of the real renderer. Follows
plans/2026-10-29-backlog-triage.md (released as 1.10.0).

## Triage

Nothing is fixed outright. Partly fixed: #27 (doctor warns; the integration
injects nothing), #37 (covered except a plain checkbox and a plain number),
#47 (links navigate and focus nothing), #54 (the give-up case is amber), #59
(the commit route is tested; the pull lock is not), #63 and #66 (umbrellas,
below).

| # | Size | Design first | Note |
|---|---|---|---|
| 83 | M | yes | Only fails when the remote moved: the push is rejected and the 502 says "try again", which never works |
| 84 | S | no | `commitPublishPaths` and `commitConfiguredGitPaths` stage raw `getGitPaths`, not `getAllowedGitPaths` |
| 67 | M-L | yes | The branch is not a port: simple-git 3.36 refuses `core.hooksPath`/`core.fsmonitor` without its `unsafe` opt-ins; five raw `execFile('git')` callers (worst: the check's `worktree add`) are outside it; the branch's test is vacuous (`--no-verify`) |
| 64 | M | small | simple-git 4 deletes every ambient `GIT_*` variable unless allowed (`GIT_SSH_COMMAND`, author/committer, set by the NixOS unit). Same lane as #67 |
| 59 | S | no | Pull-lock test. The barrier must move from git hooks to a `build.check` that waits on a file, since #67 disables hooks |
| 51 | S-M | yes | Nothing ever fetches, so `behind` is 0 in exactly the drift case; needs a fetch policy |
| 54 | S + M-L | yes (host API) | A push with no `publicUrl` still says "Published!" (S); host deploy-state needs a token (M-L) |
| 10 | S-M | small | rsync `validate()` accepts `/`, the project root, `dist/`; `keyPath` unquoted in `-e` |
| 3 | S | yes | `/api/build/*` has no caller in `ui/`: delete `server/api/build.js` rather than dedupe |
| 2 | S | no | Point `npm test` at `test:unit`; port the few uncovered api.test.js checks in-process |
| 49 | S-M | no | No `.github/`; blockers: macOS Chromium path (copied into 4 tests), git identity, `npm ci` |
| 88 | S | no | `bannerImage` + `bannerAlt` gets a built-in box that saves undeclared `bannerImageAlt` (Astro strips it) |
| 87 | S | small | Size textareas to content (min ~2 rows, three places); `.meta({ multiline: false })` forces an input |
| 85 | M | no | Object-shaped `file()` JSON lists as empty (`listSlugs` swallows the throw); YAML `file()` too |
| 69 | S | decided below | Keep the top-level rule, pin it, close. The issue text describes a reverted rule |
| 70 | M | yes | Recommended: drop a block `""` at an optional key only when the site's real zod refuses it there |
| 61 | S + S-M | small | A cleared non-nullable number saves `""` (probe-confirmed); the shim's `z` should be Astro's zod, bare `zod` the site's |
| 60 | M | yes | Map zod's default messages by `code`; a site's own message passes through |
| 56 | S | no | Add handlers count nested items; label `for` ids lose the form's `idPrefix` on reindex |
| 46 | M-L | yes | Recommended: collapse optional fields empty in the stored entry under "Show N more" |
| 47 | M | yes | Click focuses the field, a "Follow link" chip navigates |
| 86 | S | decided below | Document and warn in the doctor; support only when a site asks |
| 82 | M | yes | Key by the site path (`/images/team/x.jpg`), fall back to the bare name; phase 1 public uploads only; DELETE must remove the metadata entry |
| 77 | S | no | Delete the stale Playwright e2e; keep `playwright-core` as a direct devDependency |
| 75 | M | yes | Phase 1: Astro's 8 selector-only audit rules via htmlparser2 + css-select |
| 74 | M-L | yes | Build on #62's single owner of preview state |
| 73 | S | no | Not obsolete (peer dep is `astro >=6`): always use `<root>/node_modules/.cache` for the outDir; doctor's own failure wording, not "see the server log" |
| 62 | L | settled in issue | One owner of editor/preview state; restart from reverting 5ca7081 |
| 27 | S | small | Add the preview host to `vite.server.allowedHosts` when `isAstroAdminPreview` (whether the unit sets `PREVIEW_URL` is unverified) |
| 40 | S-M | no | A login-only limiter (`skipSuccessfulRequests`), one `auth.failed ip=` line with a timestamp, `session.regenerate()` on login |
| 52, 50 | M | light | Actionable here (`nixos/astroadmin-instance.nix`): a `runNixOSTest` in the Lima VM, then the checkout unit's hardening and limits |
| 19 | S each | no | Our glob matcher ignores `!` negations and lists dotfiles: use `tinyglobby` as Astro does; `file()` preview listing parses the file once per entry |
| 25 | - | - | Waitlist; leave open |

#66 remaining: `schema-parser.js` imports `fs/promises`; nested and block
`z.date()` written quoted when new; a new nullable list row saves `''`; stored
top-level keys with no field are dropped (`.passthrough()`); an MDX syntax
error names no entry; image listing follows symlinks; `build: null` and the
commit summary. To decide: the `pages`/`home` special cases, locale-less i18n
entries. Done: openArrayEditor (2002ab1). Won't-fix: `includeDb` (shelved
store).

#63 remaining: revert button on an untracked file; `ALLOWED_ORIGINS` vs
`Sec-Fetch-Site` docs; doctor-publish's shared tmpdir flake; document the
local doctor bin. Done: server paths in responses. Obsolete: the DB store
item. Moved: staging is #84.

## Proposed wave

Each lane in its own worktree, red-first, integrated by the parent.

1. **Publish staging** (`server/api/publish.js`, `git.js`): #84, #83, #54's
   unverified toast.
2. **Git client** (`createGitClient` + one `execFile` helper): #64 then #67,
   with #59's barrier moved to `build.check` first.
3. **Editor rendering** (form-generator render/handlers, field-widgets): #88,
   #87, #56.
4. **Editor read-back** (form-generator extract/cleanup, content-problems):
   #61 part 1, #37's last test, #69 pinned, #70 option C.
5. **Doctor and tests**: #73, #86's warning, #77 plus one shared
   `chromiumPath()` helper, #2.
6. **Server small**: #40, #19 (tinyglobby), #10's rsync guard, #3 (delete
   `server/api/build.js`).

Later: #82, #85, #60, #46, #47, the #62/#74 preview owner, #27, #75, #51,
#49, #50/#52.

## Done

| Lane | Issues | Notes |
|---|---|---|
| 1 publish staging | #84, #83, #54 (toast) | 409 `localChangesBody` when an incoming change overlaps a hand edit |
| 2 git client | #59, #64, #67 | `server/utils/git-exec.js`; simple-git 4.0.2; NixOS checkout unit hardened but NOT evaluated with Nix |
| 3 editor rendering | #88, #87, #56 | textareas fit content; `.meta({ multiline })` |
| 4 editor read-back | #61 (part 1), #37, #69, #70 | `DELIBERATE` byte changes in blank-optional-round-trip |
| 5 doctor and tests | #73, #86 (warn), #77, #2 | playwright-core pinned 1.57.0 |
| 6 server | #40, #19 (2 items), #10 (part 1), #3 | fail2ban regex `\] auth\.failed ip=<ADDR>$` |
| - | #89 | Found by the ops rollout: CmsVideo's `<style>` through linked node_modules |

Seams the parent fixed: the #83 worktree rebase used `git -C`, which simple-git 4
refuses (own client, `gitClientAt`); publish-sync's barrier moved from `pull` to
`rebase`.

## Follow-ups

Small, fix next:
- A new block starts an optional number at 0 (`createEmptyBlock`).
- A `z.literal(5)`/`z.literal(true)` with nothing stored saves `"5"`/`"true"`.
- `/api/git/pull` still pulls in the live checkout (merge mode), so unrelated
  dirty files still block it; move it onto the worktree rebase + `reset --keep`.
- #90: CmsVideo's video glob emits every rendered video twice.
- dashboard-layout-browser hung once after passing (1 in 5 runs); watch.

Larger or to file:
- Git hardening gaps: merge drivers, `core.sshCommand`, `credential.helper`,
  `url.*.insteadOf`; the publish check's build still inherits ambient `GIT_*`.
- LFS sites: the check's worktree holds pointer text (untested with git-lfs).
- Upstream: Astro's `isPathInRoot`/compile-metadata key mismatch (#89).
- rsync deploy has no timeout; `z.array(z.array(z.string()))` renders as text.

Retested on the hosted test editor (2026-10-29, tarball of fd854b4, Bun 1.3.13,
NixOS, Astro 7.4.4): the commit that failed the check with 1.10.0 published
(rebased onto a remote 2 commits ahead, check passed, pushed, live on the first
poll); author/committer and the deploy key came from the unit's GIT_* variables
under simple-git 4; no worktree or check directory left. Also from that run: a
site without `src/styles` logs "Staging note: fatal: pathspec 'src/styles' did
not match any files" on every publish; quieten it (default paths that do not
exist are not an error).

Before release: evaluate the NixOS module change; post the
drafted issue comments and close #2, #3, #37, #40, #59, #61 (part 1), #64, #67,
#69, #70, #73, #77, #83, #84, #86, #88, #89.

## Review pass 1 (2026-10-29)

Four fresh read-only reviewers on 32da2eb..main. Two HIGH, both regressions
from this wave: the #83 worktree rebase replayed commits upstream had
force-pushed away (no `--fork-point`), and a number cleared in the item modal
came back (the #61 deletion happens inside readFields, so `extractItem`'s
spread restored it). MEDIUM: LFS files recommitted as full bytes; merge
drivers, `uploadpack`, `core.sshCommand` not neutralised; pnpm packages missed
by #89; rsync `~user`; login limit per full IPv6 address; `trust proxy` 1 in
production lets a client forge its address; doctor Ctrl-C leaves its build and
folder; stale docs. Decisions: refuse LFS sites; delete `/api/git/pull`;
`trust proxy` defaults to loopback with an override. Release: the whole wave as
one release after the fixes (not a 1.10.1 hotfix); the npm release does not
need the NixOS module change. Fix lanes A (publish/git), B (editor), C
(server/auth/deploy), D (doctor/tests/docs, #90) running.

### Review 1 fixes (merged 2026-10-30)

All four lanes merged; gate passed on the combined tree (`npm test` 81/81, and
every slow, browser and packed test by name). A (publish/git): fork-point
rebase; filter-using sites refused (LFS and any clean/smudge driver); merge
drivers, upload/receive-pack, sshCommand, credential helpers, askpass and
gitProxy neutralised, `GIT_TERMINAL_PROMPT=0`; pnpm packages mirrored;
`/api/git/pull` deleted; missing default git paths no longer logged; a partly
staged file refuses. B (editor): item-modal clear kept; legacy `<x>ImageAlt`
carried into the declared alt; dry-run/failed deploys reported as such; no
repeated ids; leading newlines kept; textareas refit; optional numbers start
empty; typed literals. C (server): rsync `~user`, user/host validation and
`host:path` refusal; IPv6 /56 login limiting; `trust proxy` loopback with
`TRUST_PROXY`; `ASTROADMIN_DB` to the production build; `..` as a segment;
build process groups killed on exit. D: doctor Ctrl-C cleanup; every test file
classified; docs; publicDir wording; Chromium on Linux; #90 fixed. Filed #91
(CmsImage ships every public image as an unused `_astro` original).

Behaviour change for operators: git credential helpers (osxkeychain, gh) are no
longer used; HTTPS remotes need `GIT_ASKPASS` (docs/configuration.md, "Push
credentials").

Still before release: the real-browser save check (CLAUDE.md recipe) for the
item-modal clear, the legacy alt and typed literals; a second review pass if
wanted.

## Review pass 2 (2026-10-30, overnight)

Five agents on 5d2d43e..main, plus a real-browser save check on a throwaway
site (all scenarios pass: item-modal clear, moved alt, typed literals, new
block numbers, refit textareas, file() and top-level lists, no duplicate ids).
Every round-1 fix was confirmed to hold, and reverting each turns its test red.

New findings. Git (HIGH): `log.showSignature` + `gpg.program` runs on
log/file-history/show; `core.alternateRefsCommand` runs on the publish fetch.
Git (MEDIUM): `worktree add` checks out under the worktree's own gitdir, so
`includeIf "gitdir:**/worktrees/**"` config escapes the overrides and the
filter refusal; submodules (fetch recursion, status) and local-path remotes
run their own commands; transitive pnpm `.astro` deps; fork-point fallbacks
(URL remote, unmapped refspec, no reflog). Editor (MEDIUM): legacy alt in the
item modal; new blocks/cards save `""` for a nullable number. Server (MEDIUM):
behind a non-loopback TLS proxy the secure cookie is silently dropped (a side
effect of the loopback default: keep the default, warn and document); the
rsync remote guard judges spelling only (`$HOME`, backticks, `*` expand on old
rsync/openrsync). Plus low items and doc corrections.

DESIGN POINT for James: the git hardening is a deny-list of config keys, and
each round found more (round 1: merge drivers, uploadpack, sshCommand,
credential helpers; round 2: showSignature, alternateRefsCommand, includeIf in
worktrees, submodules, local remotes). That is the "count not falling" signal.
The structural fix is to stop site code writing the repository's `.git` at all
(on the hosted box the preview runs as the same Unix user as the admin):
a separate user for the preview, or a read-only `.git` for it. Then the
overrides become defence in depth instead of the boundary.

Round-2 fix lanes A (git), B (editor), C (server/docs), D (doctor/tests/CLAUDE.md)
running.

### Review 2 fixes (merged 2026-10-30)

All four lanes merged; gate passed (`npm test` 87/87, every slow, browser,
packed and doctor test by name). A (git): `log.showSignature`/`gpg.*.program`,
`core.alternateRefsCommand`, `push.gpgSign` neutralised; worktrees added
`--no-checkout` and checked out inside the worktree; filter refusal also sees
a linked worktree's config; no submodule recursion (fetch, status, diff) and a
gitlink refuses before any git work; local-path remotes refused unless
`git.allowLocalRemote: true`; transitive pnpm `.astro` deps mirrored;
`--fork-point` replaced by our own upstream record (`refs/astroadmin/upstream/*`),
so all four force-push layouts hold. B (editor): legacy alt in the item modal;
nullable numbers null/absent in new blocks and cards; real deploy/build failure
shapes reported accurately; unions of literals as typed selects; form key
order; a hidden dotted key was being lost (fixed). C (server): untrusted-proxy
login gets a fixed TRUST_PROXY message and an hourly warning; rsync remote
path allowlist; `trustProxy` config normalised; UTF-8 build output. D: doctor
interrupt messages and a kept fallback folder; CmsVideo `?`/`#` suffixes and
symlinks out of public/; publicDir wording; every browser test via
`launchChromium`.

Release-note items: a site whose remote is a local path needs
`git.allowLocalRemote: true`; a repo with a submodule or a git filter is
refused; HTTPS pushes take credentials only from `GIT_ASKPASS` or the
remote URL, and credential helpers (osxkeychain, gh) are no longer used;
behind a non-loopback proxy set `TRUST_PROXY`; a remote `rsync.path` with a
space, `:`, `%` or non-ASCII character is refused even with
`allowDestructivePath` (and one starting with `=`); `trustProxy` in
astroadmin.config.js is normalised like `TRUST_PROXY` (`'1'` is a hop
count); a correct login through an untrusted TLS proxy is a 500 naming
`TRUST_PROXY`, and a correct login over plain HTTP to a production server
is refused with a message saying sign-in needs HTTPS (it used to succeed
without a cookie and loop); the doctor's fallback build folder is kept in
the site root (it ignores itself); CmsVideo refuses a video file that is a
symlink pointing outside the site's public folder (a symlinked folder is
fine).

Flake seen once by two lanes under load: video-upload exits 1 after all its
checks pass (~1 in 16); an EFAULT on an upload temp dir. Not yet investigated.

## Review pass 3 (2026-10-30, overnight)

Three reviewers on 916a016..main. No high findings; the git reviewer judged
the git layer "defence in depth with known residual gaps", with no new class
of config that runs code. The editor found no data loss (untouched values
byte-identical through the three new mechanisms). Medium: a refused publish
advanced the upstream record, so the next publish brought back a
force-pushed-away commit (a regression from round 2's own fix); CmsVideo
refused a symlinked shared `public/images`; new blocks seeded literal
unions; doc placement of the staged-then-changed refusal.

Fixed (merged, gate passed: `npm test` 89/89 and all 20 slow tests by name):
the record moves only when the branch is on the fetched upstream; a base must
be contained by the HEAD from before this publish's commit, and symbolic refs
are never followed; triangular remotes (pushurl, pushInsteadOf) are refused;
a nested repo that `git add` would turn into a gitlink is refused; throwaway
worktrees never `git worktree prune` (server/utils/throwaway-worktree.js) and
the filter view fails closed after setup; refusal bodies say "committed" only
when true; literal unions start on "Choose..." in new blocks and cards; publish
messages after a push never say "not live"; CmsVideo follows a symlinked
folder and checks suffixed posters; rsync refuses a leading `=`; a plain-HTTP
production login says it needs HTTPS; doctor interrupt wording.

Not fixed, filed: #92 (a `.astro` re-exported from a package's JS still hits
#89; placing the check's worktree beside the checkout looks like the general
fix). Follow-ups: most test files print only a pass count (the runner uses exit
codes, so the gate is sound); video-upload flake under load; CmsImage's
`?`/`#` suffix gap; `filterDriverInUse` swallowing config errors; the commit
route with autoPush and nothing to commit now answers the 'remote' 409 first.

## Targeted check of the rebase base (2026-10-30)

30 adversarial scenarios through the real publish path. One HIGH: an upstream
REWOUND to an older commit with nothing new on top (the plain way to undo a
bad publish) had the removed commit pushed back, because the "already up to
date" shortcut ran before the known base was consulted. Fixed in 7a86ffd (the
shortcut applies only while the known base is still upstream); four rewind
scenarios red before, green after; `npm test` 89/89 and the slow publish
tests pass. Remaining known limits (need ref tampering or a remote config
change, documented here rather than fixed): the record is keyed by the remote
name or URL string, so switching `branch.<b>.remote` from a name to the same
remote's URL, or site code deleting `refs/astroadmin/upstream/*` with a URL
remote, loses the base and falls back to the merge-base; a record or tracking
ref deliberately pointed at a person's unpushed commit makes that commit look
upstream.

## Status for James (morning of 2026-10-30)

main is 110 commits ahead of origin, nothing pushed, nothing published, no
issues closed. Three review rounds plus a targeted check; the last round found
no high issue and the targeted check's one HIGH is fixed. Before release:
decide the git-hardening design point (round 2 above), decide #92, push, cut
the release (minor: 1.11.0) with the release-note items above, then the ops
session bumps the test editor and the client editor publishes its pending
edits.
