# Content store direction: DB vs filesystem — a brainstorm

**Status:** DECIDED (2026-06-08) — outcome **B now → C later** (hosted platform is the
active goal; isolated build jobs from day one; Firecracker deferred). The decision and the
resulting near-term architecture live in
`plans/2026-06-08-hosted-platform-near-term-architecture.md`. This doc is retained as the
framing/rationale that led there.

**Date:** 2026-06-08

## How to use this doc

Read top to bottom, then jump to **Questions for the brainstorm**. The goal of the
next session is to *decide a direction* (A, B, or C below) — or at least decide what
we'd need to learn to choose. Do not start building until we've picked. The DB-store
work is shipped and proven, so there is no time pressure beyond the waveney go-live.

---

## TL;DR

We moved AstroAdmin from editing **filesystem** content (`src/content/*.md`) to a
**SQLite content store** (`.astroadmin/content.db`) read at build time via an Astro-6
content-layer loader. It works — proven byte-equivalent on two sites (rhythm-works-east,
waveney-build). But the move surfaced a gap we haven't built: **content now lives only
on the machine running AstroAdmin** (the DB is gitignored), which breaks durability and
continuous deployment for a real client site.

Meanwhile `docs/hosted-platform-plan.md` — our own platform vision — explicitly says
**"keep git-backed filesystem content as the source of truth."** So the DB store may be
pulling against where we said we wanted to go. Before we invest more (npm publish, deploy
adapters, version history), we should decide: **double down on the DB store, revert to
filesystem+git, or build a hybrid where files/git stay the source of truth and the DB is
just an editing convenience.**

---

## Where we are now (ground truth)

**Shipped (AstroAdmin v1.0.0 on `main`, NOT published to npm):**
- SQLite content store (`server/utils/db.js`), Astro-6 content-layer loader
  (`loader/index.js` `astroadminLoader`, runtime driver select in `loader/open-db.js`:
  `bun:sqlite` under Bun, `better-sqlite3` fallback under Node).
- File→DB importer (`server/utils/import-files.js`, `astroadmin migrate`).
- Deploy adapter registry (`server/utils/deploy.js`) + `adapters/rsync.js`;
  `server/api/publish.js`; git made optional.
- zod-4 schema parsing fixed; forms + block editor render under Astro 6 / zod 4.

**Proven:** two sites migrated 5→6 + DB store, both build byte-equivalent to their old
file-based builds. Admin UI dogfooded.

**NOT built (the gap this decision is about):**
- **Durability** — `content.db` is gitignored; it exists only on the editing machine.
  Laptop dies → content is gone (code is in git, content is not).
- **Continuous deployment** — a CI checkout (Netlify build-on-push) has no DB, so it
  would ship an empty site. Deploys are hand-run locally. (Documented; commented on
  waveney #2.)
- **Version history** for content (open issue #11).
- A clean publish/sync story for static hosts.

**Forcing functions making this live now:**
- waveney-build wants to go live for a real client (#1: DNS cutover from Wix).
- waveney can't build on a fresh clone/CI because `astroadmin` is pinned `^0.2.0` but the
  build needs the unpublished v1.0.0 via a local symlink (waveney #6). Publishing v1.0.0
  to npm is the keystone that unblocks the migration PRs — but we shouldn't publish a
  direction we're about to reverse.

---

## The central tension

> **`docs/hosted-platform-plan.md` core position:** "Keep git-backed filesystem content
> as the source of truth. ... Git is used for commits, push, rollback, and auditability."

The DB store contradicts that. Either:
- the hosted-platform plan is stale and we've deliberately changed direction (then update
  that doc), or
- the DB store was a local optimisation that drifted from the intended architecture (then
  reconsider it).

We should name which it is. This contradiction is the strongest argument that the
decision is real and not just polish.

---

## What the DB store buys us vs costs us

| | DB store (current) | Filesystem + git |
|---|---|---|
| Content durability | On editing machine only (gitignored) ❌ | In git, distributed, durable ✅ |
| CD / build-on-push | Broken (no DB in CI) ❌ | Works out of the box ✅ |
| Version history | Must build (#11) | Free via git log ✅ |
| Reviewable diffs | Binary blob | Human-readable md/json diffs ✅ |
| Astro version | Astro 6 only (content layer) | Astro 5 or 6 ✅ |
| Build runtime | Bun (or better-sqlite3 native dep) | Any ✅ |
| Non-technical editor never touches git | ✅ (edits go to DB, not commits) | ❌ (every save is a commit) |
| Structured queries / relations | ✅ (rows, joins) | ❌ (glob + filter in JS) |
| Concurrent / multi-author editing | ✅ (transactional) | ❌ (merge conflicts) |
| Drafts / unpublished states | Natural in a DB | Awkward in files |
| Hosted multi-tenant platform backbone | Natural fit | Needs per-site clones |
| Implementation surface | Loader, importer, drivers, deploy adapters, zod parsing | Much smaller |

**Read:** filesystem wins decisively on *durability, deployment, and simplicity*. DB wins
on *editor experience for non-technical users, structured data, and the hosted-platform
ambition*. The question is which set matters for what AstroAdmin is actually for.

---

## The prior question: what is AstroAdmin *for*?

The right answer changes with the product:
- **(i) A developer's local CMS** for Astro sites I build and deploy for clients (current
  reality — RWE, waveney). Here the editor is often *me* or a semi-technical client, deploys
  are controlled, and simplicity/durability matter most → **filesystem+git looks better.**
- **(ii) A hosted CMS platform** where non-technical clients self-edit and we host
  (`hosted-platform-plan.md`). Here decoupling edits from git, drafts, and multi-tenancy
  matter → **DB (or DB-over-git) looks better**, but a lot more must be built.

We're currently *shipping (i)* while *the DB store is justified mainly by (ii)*. That
mismatch is the core of the decision.

---

## The options

### Option A — Commit to the DB store
Keep SQLite as the editing source of truth and build the missing layer.
- **Build:** durable storage off the laptop (managed/remote DB, or sync), a real deploy
  path (Netlify deploy adapter that builds where the DB lives and pushes `dist`), content
  version history (#11), then publish v1.0.0.
- **Pros:** lands the editor-experience and platform upside; the shipped work is the
  foundation.
- **Cons:** most to build; contradicts the hosted-platform plan unless we revise it;
  durability/CD are non-trivial; couples sites to Astro 6 + Bun.
- **Effort:** high. **Reversibility:** low once a client is live on it.

### Option B — Revert to filesystem + git
AstroAdmin edits content *files* again and commits them; loader/DB removed (or demoted).
- **Build:** restore file read/write in the admin (this is roughly what AstroAdmin did
  before the DB store — see early git history), keep the zod-form/block-editor UX (that
  part is independent of where content lives), drop the loader/importer/drivers from the
  hot path.
- **Pros:** durability, CD, version history, reviewable diffs — all free. Re-aligns with
  `hosted-platform-plan.md`. Simplest. Astro-version agnostic. Unblocks go-live fastest.
- **Cons:** throws away (or shelves) the DB work; every content save is a git commit;
  weaker for non-technical multi-author editing and drafts; no structured queries.
- **Effort:** medium (mostly deletion + restoring file writers). **Reversibility:** high —
  the DB store stays on a tag/branch if we want it back.

### Option C — Hybrid: files/git are source of truth, DB is an editing cache
The admin reads/writes the DB for a fast structured editing experience, but **every save
(or publish) is materialised to `src/content` files and committed to git.** Build reads
files (standard Astro), not the DB.
- **Build:** a DB→files exporter (mirror of the existing `migrate` importer), wired into
  save/publish; build goes back to the glob loader; DB becomes a rebuildable cache.
- **Pros:** keeps the nice editing UX *and* gets durability/CD/history/diffs for free;
  reconciles with the hosted-platform plan (git stays source of truth); the existing
  importer is half of the exporter.
- **Cons:** two representations to keep in sync (drift risk); more moving parts than B;
  "DB as cache" must be genuinely disposable or it rots.
- **Effort:** medium-high. **Reversibility:** high.

---

## Questions for the brainstorm

1. **What is AstroAdmin for in the next 12 months** — my client-site tool (i), or a hosted
   product (ii)? This dominates everything else.
2. Is `hosted-platform-plan.md` still the intended direction? If yes, why did we build a DB
   store against its stated position? If no, it needs rewriting.
3. For the *actual clients we have* (RWE, waveney), does anyone benefit from DB-only
   features (drafts, non-git editing, structured queries) — or would files+git serve them
   fully?
4. How much do we value **content durability + CD** for a live client site? (Right now both
   are unsolved on the DB path.) Is that a go-live blocker?
5. If we keep the DB: where does the durable copy live, and who operates it?
6. What's the cost of being wrong each way, and how reversible is each (see effort/revers.
   notes above)?
7. Does the editing UX (auto-generated zod forms, block editor) actually depend on the DB,
   or is it storage-agnostic? (If agnostic, B/C keep the good part and we lose little.)

## State to preserve regardless of decision
- AstroAdmin v1.0.0 is on `main` + tag `v1.0.0` (DB store intact even if we revert).
- waveney: branch `astro6-migration` (PR #7), tag `astro5` (pre-migration rollback).
- RWE: branch `astro6-migration` (pushed), tag `astro5`.
- **Do not publish AstroAdmin to npm until this is decided** (publishing signals commitment
  to the DB store and unblocks merging the migration PRs).

## References
- `docs/sqlitecontentstoreplan.md` — the DB-store spec (the "for" case).
- `docs/hosted-platform-plan.md` — platform vision (git-backed filesystem as source of truth).
- `docs/deploy-adapters.md` — current deploy model.
- Open issues: #11 (content version history), #2/#3/#4/#10 (DB-store cleanups).
- waveney repo: PR #7, issue #6 (npm pin), issue #2 (CD blocked by gitignored DB).
- Auto-memory: `astroadmin-db-content-store` (full status of the effort).

## My lean (not a decision)
Given the clients we actually have are developer-deployed single-tenant sites, and given
our own platform plan says git+files is the source of truth, **Option C (hybrid) or B
(revert)** look stronger than A right now — they restore durability/CD/history for free and
keep the editing UX, which appears to be the genuinely valuable part. A is right *only* if
we're committing to the hosted multi-tenant product soon. Worth pressure-testing this hard
in the session — I may be undervaluing the editor-experience/drafts upside.
