# Implementation plan: 3 client sites editing online (files + hosted AstroAdmin)

**Date:** 2026-06-08
**Status:** READY TO BUILD. Decisions resolved (2026-06-08):
- **Auth:** username + password per instance (argon2/bcrypt, login + middleware over the
  existing session store, HTTPS-only, login rate-limit).
- **Hosting:** **Docker on the NixOS host now** (reuses `docker/`, fastest, right-sized).
  Ideal end-state is VM/microVM isolation on NixOS — but that is the **SaaS-phase substrate**
  + a research spike, NOT needed for these 3 sites (see "Hosting nuance" below).
- **Git credential:** per-repo deploy key per instance. **Publish:** direct (no draft step) for v1.
**Parent decision:** `plans/2026-06-08-hosted-platform-near-term-architecture.md`
(B = files+git; per-site instances; Astro 6 + files; Netlify builds-on-push; SaaS later)

## Progress (branch `feat/files-content-store`)

- ✅ **Phase 1** — file-based content store behind a `content.store` seam (db preserved).
- ✅ **Phase 2** — `astroadmin export` (DB→files), `import-files` deduped onto `glob-files`.
- ✅ **Auth hardening** (Phase 3 slice) — argon2 + timing-safe login, prod weak-config
  warnings, `astroadmin hash-password`. Login plumbing already existed; this hardened it.
- ✅ Removed legacy `docker/`.
- ⏳ **Next (needs the live sites / external infra — pause point):** for Site B + Site C, swap
  `content.config.ts` to `glob()`/`file()` **first**, then run `astroadmin export` (the exporter
  reads the parsed loaders for the target layout and refuses to export file()-origin rows under
  `astroadminLoader`); design the minimal per-site runtime + deploy keys + TLS; stand up
  Site A first.

All server-less tests green: content-files 10, content-store(db) 7, export 7, import 8,
loader 4, schema-parser-db 6, auth 5. (`api.test.js` needs a running server — pre-existing.)

## Goal

Let 3 non-technical clients edit the **content** of their already-deployed Astro sites via
AstroAdmin reachable on the internet. Loop: client edits → AstroAdmin writes files → commits
+ pushes → **Netlify build-on-push** → live. No build worker / isolation stack / deploy
adapters / release records on our side — Netlify is the build sandbox, host, and rollback.

## What the verification found (so estimates are grounded)

- **Storage is one module.** `server/utils/content.js` is the entire DB coupling; its public
  signatures (`readContent/writeContent/deleteContent/contentExists/getAvailableLocales`)
  were deliberately preserved from the old file-backed version, so API + forms + block editor
  are storage-agnostic and untouched.
- **The file implementation exists in history** at `356e7ab:server/utils/content.js`
  (`gray-matter`: `matter.stringify` for `.md` frontmatter+body, JSON for data; already
  handles file collections, i18n, glob dirs). Recover + adapt, don't rewrite.
- **The DB→files exporter is nearly free.** `server/utils/import-files.js` already computes
  each collection's glob base/pattern/paths (files→DB). Invert it: read DB rows, write via
  the restored file `writeContent`.
- **Astro 6 + glob is directly supported** — the schema parser already extracts
  `loaderBase/loaderPattern/loaderType/loaderFilePath`; no Astro-version coupling in editing.
- **Git already exists.** Commit+push is implemented in `server/api/git.js` (`simple-git`,
  `commitConfiguredGitPaths`, `git.push()`). Preview is the `integration/` Astro integration
  (configurable `preview.url`/`preview.method`).
- **Legacy `docker/` is being scrapped (user decision 2026-06-08).** It was built for the old
  self-hosted model — a builder image running `npm ci && build`, nginx serving `dist`, ssh.
  Netlify now does build + host + rollback, so that apparatus doesn't fit. We design a
  minimal per-site runtime fresh (see Phase 3). The old `docker/` dir is to be removed.
- **Auth is genuinely missing.** `session-store.js` is express-session *storage* only — no
  login / user model / route protection anywhere.

## Hosting nuance — why Docker (not microVMs) is right for these 3 sites

The ideal end-state is microVM isolation on a NixOS host, and that's the right instinct for
the SaaS phase. But for **these 3 sites it buys almost nothing**, because **no untrusted code
runs on our host:** each instance runs AstroAdmin (ours) + a checkout of a site whose code is
ours; the only untrusted thing (the npm dependency tree) executes **at build time on Netlify,
not on our host.** microVMs would be isolating trusted-from-trusted = operational hygiene, not
a security boundary. So Docker on the NixOS host is correctly sized now. microVM isolation
earns its cost at the SaaS phase, when we run **untrusted tenant builds on our own infra**.

**Research spike (off the critical path, SaaS-phase groundwork):** NixOS + microVM options —
Firecracker directly vs what Fly.io (Firecracker) / Railway use, plus Cloud Hypervisor, Kata,
gVisor; boot/snapshot/networking/secret-injection on NixOS; declarative guest images via Nix.
Output = a recommendation for the SaaS isolation substrate. Does **not** block shipping the 3 sites.

---

## Phase 1 — AstroAdmin: file-based storage on Astro 6 ✅ DONE (2026-06-08)

**Shipped:** a storage seam selecting files (default) vs db via `config.content.store`
(env `ASTROADMIN_CONTENT_STORE`). New: `server/utils/glob-files.js` (shared glob discovery),
`content-files.js` (file store: CRUD + listing, honours `loaderBase`/`loaderPattern`),
`content-db.js` (the v1.0.0 SQLite store moved behind the flag), `content-store.js`
(dynamic-import dispatcher — no DB driver loaded in files mode, no import cycle). `content.js`
is now a thin CRUD re-export; `collections.js` lists via the store; `config.js` adds the flag
and stages `src/content/` on commit. Tests: new `content-files.test.js` (8/8); existing
DB-mode tests pinned to db mode and still green (`content-store` 7/7, `loader` 4/4,
`import-files` 8/8, `schema-parser-db` 6/6). Server boots in files mode. DB path fully
preserved for the SaaS phase.

**Deferred within Phase 1:** refactor `import-files.js` to consume `glob-files.js` (dedupe)
— do it alongside the Phase 2 exporter so the glob logic unifies in one change.

Make AstroAdmin read/write content **files** again, keeping the v1.0.0 zod-4 / block-editor UX.

1. **Restore file `content.js`.** Recover `356e7ab:server/utils/content.js`; adapt it to use
   the v1.0.0 schema-parser metadata (`loaderBase/loaderPattern/loaderType/loaderFilePath`)
   that `import-files.js` already relies on, so glob base/pattern resolution matches. Keep the
   exact public signatures. Keep `sanitizePath` traversal guards.
2. **Storage seam (don't delete the DB store).** Introduce a thin storage selector
   (`config.content.store: 'files' | 'db'`, default `files`) so the v1.0.0 DB implementation
   stays available for the SaaS phase. Low cost; preserves the shelved work behind a flag.
3. **Take the DB out of the site hot path.** Sites use Astro's native `glob()`; the
   `astroadminLoader` (`loader/`) is no longer used by these sites. AstroAdmin server touches
   files directly. (Loader code stays in the repo for the SaaS/DB path.)
4. **Tests.** Restore/adapt the pre-DB file-based content tests from history; ensure the
   forms + 11/12-block discriminated-union editor round-trip through files under Astro 6.

**Effort:** medium. **Risk:** low (recovery + adaptation; UX untouched).

## Phase 2 — Migrate Site B + Site C off the DB store (content-preserving)

1. **Build `astroadmin export` (DB→files).** Reuse `import-files.js` glob metadata + the
   Phase-1 file `writeContent`: for each collection, read all DB rows (`db.js`), write files
   to the glob base. Mirror of `astroadmin migrate`. Idempotent.
2. **Per site (Site B, then Site C):**
   - Swap `content.config.ts`: `astroadminLoader` → `glob()` (and `file()` where used) **first** —
     the exporter reads the parsed loaders to know each collection's target layout
     (glob base/pattern, the file() array path, .md vs .mdx). It warns and falls back to
     `src/content/<collection>/` for any collection still on `astroadminLoader`.
   - Run `export` → content files (preserves current **live** content from local `content.db`).
   - Drop `.astroadmin/content.db` from the build path.
   - **Verify build byte-equivalence** to the current live build (same check used in the
     original migration) before cutover.
   - Commit on a branch → PR. Keep the astro6+DB branch/tag as rollback.
   - Site C also: bump `astroadmin` 0.1.0 → the new file-based version.
3. **Site A:** already file-based (Astro 5) — no content migration. It only becomes
   a hosting target in Phase 3.

**Effort:** low-medium per site. **Risk:** medium (Site B is live — gate on byte-equivalence;
keep DB + tag for rollback; do not touch the Netlify production build until verified).

## Phase 3 — Auth + public hosting (per-site instances)

1. **Auth (net-new).** Per chosen mechanism: hashed credentials, login route, session via the
   existing store, middleware protecting all UI + `/api` routes, secure cookies, HTTPS only,
   logout, basic rate-limiting on login.
2. **Harden the content-commit path** (`server/api/git.js`): commit with
   `-c core.hooksPath=/dev/null --no-verify`, disabled filters/LFS smudge, restrict staged
   paths to the content/asset allowlist (the configured git paths already scope this — tighten
   it), reject symlinks/traversal. It must run no site code.
3. **Hosting per site — minimal runtime, designed fresh** (legacy `docker/` scrapped; no
   builder, no nginx-serving-`dist` — Netlify does that). Each instance = AstroAdmin (Bun)
   + a checkout of the site repo (for content files + preview) + that repo's write deploy
   key, reachable at `admin.<clientdomain>` over TLS. Near-term vehicle: a small Dockerfile
   for the Bun server on the NixOS host; longer-term a NixOS module / microVM (per the SaaS
   research spike). Confirm the preview integration works against the hosted checkout
   (`preview.url`/`preview.method`). **First remove the obsolete `docker/` dir.**
4. **Publish flow:** edit → file write → "Publish" → commit + `git push` → **Netlify
   build-on-push** → live. Drop the local-build deploy adapters for these 3 sites (Netlify
   builds). Surface build status/link to the editor if cheap.

**Effort:** medium (auth) + low (reuse Docker/git). **Risk:** medium (internet-facing with
client logins — auth correctness + TLS + credential handling matter).

## Phase 4 — Rollout order

1. **Site A first** — least work (already file-based); proves auth + hosting +
   publish→Netlify on the simplest site.
2. **Site B** — already live; migrate content to files (Phase 2), verify byte-equivalence,
   stand up the editor, cut over.
3. **Site C** — same, plus the version bump.

## Explicitly NOT building now (SaaS phase)

Control plane, multi-tenancy, isolated build workers, gVisor/Firecracker, provider-agnostic
deploy adapters, release records, schema-extraction sandboxing, media/object-storage pipeline.
Near-term tenants edit content only on first-party code; Netlify is the build sandbox.

## Sequencing note

Phase 1 + the Site A slice of Phase 3 is the smallest end-to-end proof (one client
editing online). Do that first, then Site B (the one with a waiting client), then Site C.
