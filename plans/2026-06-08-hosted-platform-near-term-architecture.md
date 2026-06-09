# Hosted platform — near-term architecture & content-store decision

**Date:** 2026-06-08
**Status:** DECIDED (direction). This records decisions reached in the content-store
brainstorm and the near-term hosted-platform architecture that follows from them. It is
a design/decision doc — no implementation here. Supersedes the open question in
`plans/2026-06-08-content-store-direction.md`.

---

## Decisions (locked)

1. **Content store: B now → C later.** Revert the admin to **files + git as the source of
   truth** now. Keep the storage-agnostic editing UX (auto-generated zod forms, block
   editor). Demote the SQLite content store + Astro-6 content-layer loader out of the hot
   path. Re-introduce a DB **later** only as a per-editor *draft/editing cache* that
   materialises to `src/content` files and commits on publish (Option C). The DB-store
   work (v1.0.0) stays preserved on tag `v1.0.0`; nothing is deleted, it is shelved.
2. **AstroAdmin is a hosted, multi-tenant CMS platform for Astro sites** — this is the
   active near-term goal (not a north star). `docs/hosted-platform-plan.md` is the
   intended direction and is NOT stale.
3. **Firecracker is deferred.** Too much work for the current stage and not yet required.
   It remains the eventual production-isolation target for untrusted tenants.
4. **Isolated build jobs from day one.** The build runs outside the control plane in an
   isolated job from the very first version — see rationale below.

---

## Near-term project (the actual one): 3 client sites editing online

Clarified 2026-06-08: this is **not** the SaaS platform. The immediate need is to let 3
non-technical clients edit the **content** of sites whose **code we own**, via AstroAdmin
reachable on the internet. The SaaS multi-tenant cloud CMS/hosting product is a **later**
phase that reuses what we learn here. Waveney is already live (built locally → Netlify); the
gap is the *editor*, not the site.

**Key simplification — Netlify is the build sandbox + host.** Once content is files-in-git,
the loop is: client edits in hosted AstroAdmin → AstroAdmin commits + pushes → Netlify
builds-on-push → live. So near-term we need **no** build worker, isolation stack, deploy
adapters, or release records on our side — Netlify does build, host, and rollback. All that
machinery (this doc's control-plane/worker/microVM design) is the **SaaS phase**. This maps
to the platform plan's existing *"Trusted self-hosted — single customer"* tier, run publicly.

**Site inventory (verified 2026-06-08):**

| Site | Astro | AstroAdmin | Store | Near-term work |
|---|---|---|---|---|
| Feathered Thorns (`feathered-thorns`, `cloudshipco/feathered-thorns`) | 5.16 | 0.2.0 | files | none on content; just hosted editor + auth |
| Waveney (`…/waveney-build/site`, `cloudshipco/waveney-build-website`) | 6.4 | 0.2.0 | DB store, no files | DB→files export (preserve live content) + revert to file mode |
| RWE (`…/rhythmworkseast.co.uk`, `cloudshipco/rhythmworkseast`) | 6.3 | 0.1.0 | DB store + stale files | same revert + version bump |

**Realizations:**
- Published AstroAdmin **0.2.0 is already the file-based build** (FT runs it). "B" =
  continue the 0.2.0 file line + port the improved zod-form/block-editor UX onto it; do NOT
  publish the v1.0.0 DB store as mainline.
- **Astro 6 was only required for the DB store** (content-layer loader is Astro-6-only).
  Dropping the DB store removes that reason → simplest path for waveney/RWE is revert to
  their `astro5` file-based tags (proven by FT). Confirm no other Astro-6 need.
- Waveney/RWE **current live content lives in local `content.db`** → a one-time DB→files
  export is required before revert so no content is lost.
- AstroAdmin has a `session-store.js` but **no evidence of real multi-user auth** (it was a
  local tool). **Auth + public hosting is the main net-new near-term work** — verify first.

**Decisions resolved (2026-06-08):**
- **Hosting model: per-site instances (3 deployments).** One AstroAdmin per site, each
  scoped to one repo, one client login, holding only that repo's write credential. No
  multi-tenancy code to build; smallest blast radius; matches the trusted-self-hosted tier.
  Multi-tenancy is built later for the SaaS phase, informed by operating these three.
- **Waveney + RWE: stay on Astro 6, switch to file-based content.** Content config moves
  from `astroadminLoader` (DB) to a `glob()` file collection over `src/content`. We keep
  v1.0.0's improved zod-4 / block-editor UX but point its storage at **files, not the DB**.
  (Implication: file editing must work under the v1.0.0 codebase + Astro 6 — verify; FT
  proves the 0.2.0 file path but on Astro 5.)

**Near-term scope (revised, replaces the cut-down v1 list below for THIS phase):**
1. AstroAdmin: make the v1.0.0 zod/block-editor UX read/write **files** instead of the DB;
   build a one-time **DB→files exporter** for the waveney/RWE migration.
2. Migrate waveney + RWE: export `content.db` → `src/content` files, swap
   `astroadminLoader` → `glob()` in `content.config.ts`, commit. FT needs nothing here.
3. Add **auth** (login per site) to AstroAdmin and deploy one instance per site publicly.
   AstroAdmin needs a working checkout of each site (for preview) + that repo's write cred.
4. Wire content-commit (hardened: `--no-verify`, no hooks/filters, path allowlist) → push →
   Netlify build-on-push. Netlify handles build, host, and rollback.

The SaaS control-plane / isolated-build / provider-agnostic-deploy design in the rest of
this doc remains the **target for the SaaS phase**, not this near-term project.

---

## Why git+files is the source of truth (not the DB)

The hosted goal does **not** select "DB as source of truth". It selects git-as-truth, for
reasons that are intrinsic to the platform plan:

- **Version history / rollback (a hard requirement) is free with git** — old versions,
  diffs, rollback are built in and battle-tested. The DB path makes this a build-it-
  yourself feature (was open issue #11): reinventing git, worse.
- **Reproducible, commit-based releases are the backbone of the platform.** A release = a
  commit SHA. Rollback = move the release pointer to an older commit/artifact. DB-as-truth
  turns a release into "commit SHA + DB snapshot" and complicates immutability/rollback.
- **The security model forbids build-time DB reads.** The current loader reads
  `.astroadmin/content.db` *at build time*. In the hosted model, builds run in isolated
  workers that get only a short-lived **read-only repo token** — "no platform database
  credentials in workers". A build that reads a multi-tenant content DB needs exactly the
  cross-tenant credential the plan forbids. Materialising content → files removes the need;
  once you materialise, files are what you build from. That is B/C, not A.
- **"Every save is a commit" is reduced, not dissolved, and only once C exists.** Hiding
  git from the editor removes the *manual* commit step, but NOT push latency, branch
  protection, merge conflicts, per-site locks, GitHub rate/outage limits, or commit spam.
  So git cannot be the *live editing substrate* for non-technical editors — it is the
  **published durability ledger**. The live editing substrate is the C draft workspace,
  which commits to git only on publish. This is why C's trigger is the first non-technical
  external client, not a vague "later" (see Sequencing).

The DB's real value is **editor experience** (drafts, structured/relational editing,
transactional concurrency). Per the brainstorm's Q7, the *valuable* editing UX is
storage-agnostic. So the DB belongs as a **draft cache on top of git (C)**, not as the
source of truth.

---

## Why builds are isolated from the control plane from day one

Not just "we will need it for untrusted tenants eventually." It is justified **now**:

- The site *code* is first-party (ours), but the **npm dependency tree is not**.
  Dependencies execute arbitrary code during `npm ci` / `install` scripts and during the
  Astro build (config, integrations, Vite plugins).
- A single malicious/compromised transitive dependency in **one** site's build is a
  site-level supply-chain attack. If that build runs inside the control plane, it can reach
  control-plane secrets, git write credentials, and other tenants' data.
- Therefore the build must never execute in a process holding broad platform credentials.
  Isolating it from the start contains site-level supply-chain compromise to a single,
  disposable, low-privilege job — regardless of whether the tenant is trusted.

The *isolation mechanism* can be weak initially (a plain container) because the **boundary**
is what matters; the mechanism is swappable later (see roadmap).

---

## Architecture (near-term, Firecracker-free, provider-agnostic)

```
Control plane (NixOS host, trusted — runs NO site code or site deps)
  ├─ Editor UI + zod forms / block editor      (storage-agnostic; retained from current work)
  ├─ Site registry, auth, roles, release records
  ├─ Content-commit job → write files → git commit → git push
  │     • holds the WRITE credential; runs NO site code
  ├─ Build orchestration  → spawns isolated build job
  └─ Credential store (GitHub App; mints short-lived scoped tokens)

Isolated build job (separate from control plane from day one)
  ├─ Inputs: site_id, commit_sha, build config
  ├─ Creds:  short-lived READ-ONLY repo token only (never the write key)
  ├─ Runtime: plain container / systemd-nspawn now
  │            → gVisor/runsc (first untrusted tenants)
  │            → Firecracker microVM (production untrusted)   [swap behind same contract]
  ├─ Runs: npm ci + astro build  (untrusted dependency tree)
  ├─ Channel: narrow job-result API back to control plane — nothing else
  └─ Output: one immutable artifact (dist/) addressed by release id

Deploy (provider-agnostic)
  ├─ Deploy adapter registry (already exists: server/utils/deploy.js, adapters/rsync.js)
  ├─ First adapter: Netlify *manual/prebuilt* deploy (netlify deploy --dir=dist) — NOT a
  │     Netlify build (building ourselves keeps us provider-agnostic)
  ├─ Other targets later: S3+CDN, own nginx, etc.
  └─ Release records (site → active release → artifact/commit)
        • CAVEAT: "pointer flip identical across providers" is only true when WE serve the
          artifact (our object storage + CDN + router). With Netlify manual-deploy, the
          active deploy, aliases, domain routing, preview URLs, cache, redirects/headers,
          and rollback are PROVIDER state. Near-term: accept provider-specific rollback
          (Netlify keeps deploy history). True provider-agnostic rollback is a later
          milestone gated on owning the serving layer — do not claim it before then.
```

Two version layers, both required and both owned by us:
- **Content history** → git (free, from B).
- **Release/deploy history** → artifact-per-commit release records.

---

## Credentials model

**Invariant:** a writable git credential must never share an execution context with
untrusted build code (= the dependency tree).

- **Primitive:** GitHub App installation (short-lived ~1h tokens, repo-scoped, centrally
  revocable) — preferred over long-lived SSH deploy keys, which don't scale and leak
  indefinitely. Deploy keys are a fallback if we avoid running an App initially.
- **Write path (content commit/push):** holds a write token → but "runs no site code" is
  NOT free. git itself is an execution vector. The content-commit job must enforce:
  `git -c core.hooksPath=/dev/null commit --no-verify`, disabled git filters/LFS smudge,
  `core.fsmonitor=false`, a **path allowlist** derived from collection metadata, no symlink
  traversal, no arbitrary file writes, and media sanitization on upload. It must NOT run
  npm scripts, formatters, Astro config, remark/rehype plugins, or schema code. Schema
  metadata is consumed only from the sandboxed extraction artifact, never by importing site
  code in this job. Lives in the control plane / a thin commit job; never in the build job.
- **Read path (build fetch):** isolated build job gets only a short-lived read-only token,
  minted per job. Never sees the write key.
- Credentials are stored encrypted in the control plane and never baked into build/preview
  images.

---

## Isolation roadmap (mechanism swap behind a stable job contract)

| Stage | Trigger | Build runtime |
|---|---|---|
| Now | **First-party / trusted tenants only**, on a worker host with no platform secrets | Plain container / `systemd-nspawn` — this is **process separation, NOT a security boundary** |
| Next | First **untrusted** tenant repo builds (incl. beta) | gVisor / runsc (container-shaped, low effort, packaged on NixOS) |
| Production | Public untrusted Astro hosting | Firecracker microVM (NixOS can build guest images declaratively) |

The build job's *contract* (inputs / read-only token / job-result API / artifact output)
is fixed from day one, so the **API boundary** is stable. But the runtime swap is **not a
drop-in substitution**: container → gVisor → Firecracker changes image format, boot
lifecycle, filesystem mounts, cache restore, artifact egress, DNS/network policy, metadata
blocking, log streaming, secret injection, resource accounting, and snapshot strategy.
Design a `WorkerRuntime` interface now; budget real work for each runtime, not just a
config flip.

**Hard rule:** a plain container must NEVER build an untrusted repo. Plain-container
builds are gated to first-party/trusted tenants. The first untrusted (even beta) tenant is
a gVisor gate, per the platform plan's own isolation tiers — the near-term plan must not
regress that.

---

## The pivotal sequencing variable (from Codex review)

**Who is the first hosted tenant — my own sites (I edit), or external non-technical
clients?** This resizes everything:

- **My own sites first (I/trusted person edits):** B-without-C is genuinely fine for v1;
  plain-container builds are fine (first-party); media/schema-extraction isolation can lag.
  This is the cut-down v1 below.
- **External non-technical clients in the first iteration:** then C (a draft workspace),
  gVisor isolation, schema-extraction isolation, media strategy, auth/roles/audit are
  **all required up front** — they are not "later." git-as-live-editing breaks for
  non-technical editors (commit spam, conflicts, latency you can't hide).

The trigger for each "deferred" item below is **the first external client**, not a date.
Decide this first; it determines whether the 1–2 week scope is realistic.

### DECISION (2026-06-08): external clients edit in v1 — but content only, code stays first-party

Answered: external non-technical clients are in scope for v1. **Critical scoping nuance**
(per requirement #3 — *we* build the sites, clients only edit **content**, not code):

- **Untrusted-CODE isolation stays DEFERRED.** Because the site code (and its zod schemas)
  is first-party, gVisor / Firecracker / sandboxed schema-extraction are NOT v1. The
  plain-container build boundary remains correct (it exists for the npm-dependency
  supply-chain risk = process separation, no platform secrets on the worker). These only
  move into scope if/when a client brings or pushes their own site **code**.
- **Multi-USER control plane IS now v1, and it is NOT a 1–2 week add:**
  auth + roles + per-tenant content scoping; a **draft/preview workspace (C-lite)** so
  non-technical editors don't commit-on-keystroke; the hardened content-commit job; media
  upload handling; audit log.

**Timeline split (the live-client deadline and the platform must not compete):**
1. **Next 1–2 weeks (shippable):** B revert + publish v1.0.0 files-based → **unblocks
   waveney going live now** as a developer-deployed site. This is the thing with a deadline.
2. **Hosted multi-user editor** (auth/roles/draft-preview/tenant-isolation/hardened-commit/
   media) = the next milestone, **weeks not days**, built on the same file substrate.

⚠️ Assumption to confirm: clients edit content only. If clients will ever push site CODE,
the full untrusted isolation stack (gVisor → Firecracker, sandboxed schema extraction)
re-enters scope and must be designed before that capability ships.

## Sequencing — cut-down v1 (Codex: the broad 6-step list is too much for 1–2 weeks)

Minimal first version = **one repo, one tenant, one locked branch, content-only commits,
artifact build job, manual domain/deploy, NO untrusted tenants:**

1. **Revert admin to files + git (B):** restore file read/write, keep the zod-form /
   block-editor UX, demote loader/DB/importer out of the hot path.
2. **Publish AstroAdmin v1.0.0 as a files-based release** — unblocks waveney go-live
   (gitignored-DB → empty-CI-build problem disappears). Files-based, not a DB commitment.
   *(Steps 1–2 are the plausible, self-contained slice. Everything below is the platform
   and should not be promised inside the same 1–2 weeks.)*
3. **Thin control plane:** site registry + the content-commit job (hardened per Credentials),
   single locked branch, per-site lock.
4. **Isolated build job (container) from day one**, behind the `WorkerRuntime` contract.
5. **One deploy adapter** (Netlify manual/prebuilt), provider-state rollback accepted.
6. **GitHub App** for repo creds (read token for builds, write token for commits).

---

## Gaps to decide BEFORE building (Codex P1s — expensive to change later)

- **Media / assets strategy.** Unaddressed and a classic git-CMS pain wall (binary diffs,
  GitHub file/repo limits, clone time, LFS auth, CDN transforms, EXIF/SVG sanitization,
  upload UX). Decide now: in-git vs Git LFS vs **object storage with content references**
  (likely the right answer). Changing this after content exists is costly.
- **Schema extraction is untrusted execution.** The zod forms are generated from the
  *site's own* schema code — extracting them runs repo code. It needs the **same isolation
  story as the build worker** before any hosted editing is credible; it is not free.
- **Content-commit job hardening** — see Credentials (hooks/filters/LFS/symlinks/path
  allowlist). Not optional once it holds a write token.
- **Auth / tenancy / audit** — tenant membership, site roles, editor identity in commits,
  repo-install ownership, invite flow, preview authorization, audit log, impersonation,
  offboarding, credential revocation. Required before real clients touch it.
- **Backups** — git does NOT cover: platform DB, release records, artifact storage,
  credential metadata, audit logs, preview/draft state, and media (if media isn't in git).

## Deferred (explicitly out of scope now) — but trigger = first external client, not "later"

- **DB-as-draft-cache (Option C).** Required as soon as a non-technical external client
  edits. Name it honestly: **git is the published source; the DB is the editorial
  workspace.** It is an anti-pattern only if drafts/comments/unpublished assets/workflow
  state live ONLY in the cache with no durability/backup — so give the workspace its own
  backup model. (Prior art: Tina = git-backed + editing layer; Decap = commits/PRs;
  Sanity = DB-first materialized via APIs. Pure "commit on every save" is what mature
  systems avoid — don't reinvent a worse version.)
- gVisor / Firecracker isolation — gated on the first untrusted tenant, per the roadmap.
- On-demand dev-preview microVMs (artifact previews first, per the platform plan).
- Multi-tenant untrusted onboarding (abuse controls, quotas, network policy, patch
  pipeline).
- At "hundreds of sites" scale: shallow/disposable workspaces (no long-lived clones),
  webhook reconciliation, idempotent commit jobs, retry queues, explicit conflict UX.

---

## Open questions

1. ~~First hosted tenant?~~ **ANSWERED:** external clients, **content-only** (code stays
   first-party). 3 specific sites; per-site instances; untrusted-code isolation deferred to
   SaaS phase. See "Near-term project".
2. **Media storage:** in-git vs Git LFS vs object storage with references. (For 3 small
   marketing sites, in-git images are likely fine near-term; revisit for SaaS.)
3. Build sandbox now: plain container/podman vs a Nix build derivation (pure + sandboxed +
   reproducible, more setup per site). Lean container for speed; Nix attractive long-term.
4. Content-commit job: inline in the control plane initially, or its own discrete job from
   the start (mirrors the build-job boundary).
5. Draft model for C: draft branch vs platform-managed content branch vs DB workspace.
6. Per-site publish lock — needed once concurrent edits/commits are possible.
7. Preview: artifact preview first (safe, same path as production); dev-preview microVMs
   much later.
8. Do we own the serving layer (object storage + CDN + router) eventually, or stay on
   provider hosting? Determines whether provider-agnostic atomic rollback is achievable.

---

## State to preserve (regardless)

- AstroAdmin v1.0.0 on `main` + tag `v1.0.0` (DB store intact even though shelved).
- waveney: branch `astro6-migration` (PR #7), tag `astro5` (pre-migration rollback).
- RWE: branch `astro6-migration` (pushed), tag `astro5`.

## References

- `plans/2026-06-08-content-store-direction.md` — the brainstorm that framed the decision.
- `docs/hosted-platform-plan.md` — platform vision / security model (git-as-truth, isolation tiers).
- `docs/sqlitecontentstoreplan.md` — the shelved DB-store spec.
- `docs/deploy-adapters.md` — current deploy model.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 13 findings (7 P1, 6 P2), all incorporated |

- **CODEX:** Direction validated (git as durable published source is right; B→C sound).
  Corrections folded in: (1) plain containers = process separation, trusted-tenant-only,
  gVisor before any untrusted repo; (2) runtime swap is non-trivial, `WorkerRuntime`
  boundary now but real per-runtime work; (3) content-commit job hardening rules
  (hooks/filters/LFS/symlinks/path allowlist); (4) provider-agnostic atomic rollback only
  if we own the serving layer; (5) media strategy + schema-extraction isolation added as
  pre-build P1 decisions; (6) C's trigger compressed to "first external client", not
  "later"; (7) v1 scope cut to one tenant / one locked branch / content-only; (8)
  auth/tenancy/audit/backups named as required.
- **CROSS-MODEL:** Claude and Codex agree on the core decision (git-as-truth, B→C). No
  disagreement on direction; Codex added the 3 missing P1 gaps (media, schema-extraction,
  content-commit hardening) and compressed C's timeline.
- **UNRESOLVED:** None blocking. Near-term scope is defined (3 sites, per-site instances,
  Astro-6 files, auth + public hosting, Netlify build-on-push). Codex's heavy P1s
  (gVisor/Firecracker/schema-extraction sandbox, provider-agnostic deploy, release records)
  are correctly **deferred to the SaaS phase** because near-term tenants edit content only
  on first-party code and Netlify is the build sandbox.
- **VERDICT:** Direction CLEARED. Near-term project scoped: get 3 clients self-editing
  online on the file substrate. Next artifact = a concrete implementation plan for that
  (AstroAdmin file-editing + DB→files exporter + auth + per-site hosting). The SaaS
  control-plane design in this doc stands as the later-phase target.
