# Implementation plan: Phase 3 — auth + public hosting (per-site instances)

**Date:** 2026-06-25
**Status:** READY — infra decisions confirmed 2026-06-25 (see "Decisions (confirmed)"). Host
is a fresh NixOS box the user is provisioning. Parent:
`plans/2026-06-08-3-sites-online-implementation.md` (Phase 3) and
`plans/2026-06-08-hosted-platform-near-term-architecture.md` (architecture).

## Decisions (confirmed 2026-06-25)
Conventions follow our existing in-house NixOS hosts pattern (the host flake mirrors it).
1. **Host + runtime:** a **new NixOS host** dedicated to AstroAdmin instances (user is
   spinning it up). Per-instance **systemd units** (admin + preview) — declarative, idiomatic,
   feeds the SaaS NixOS substrate. The host flake lives **privately** (alongside the ops
   notes), not in this public repo. Recommended spec below.
2. **Preview:** live **`astro dev`** per instance, bound to localhost. Instant hot-reload;
   runs first-party site deps on the host (acceptable for these 3 — no untrusted code).
   ⚠️ Browser-reachable preview routing is the one open integration item (the editor iframe
   loads `previewUrl` directly) — finalize against a live instance.
3. **TLS/proxy + secrets:** **nginx + `security.acme`** (per-host Let's Encrypt, HTTP-01) and
   **sops-nix** for secrets — matching our house NixOS pattern (not Caddy/agenix). HTTP-01 fits the
   mixed-registrar single subdomains with no DNS API keys.
4. **Site A:** already **live on Netlify** but **NOT GitHub-linked** (deployed manually so
   far). Editor → `admin.<site-a-domain>`. (Concrete domain / Netlify site id / repo are in
   the private ops doc — this repo is public.)
   - ⚠️ **CD prerequisite:** connect Site A's Netlify project to its GitHub repo for
     build-on-push, else Publish (push) won't trigger a build. **Same gap for Site C.** Site B
     is already GitHub-linked.
   - ⚠️ **Per-site registrar varies:** Site A's domain is on a third-party registrar's
     nameservers (**not Namecheap**), so `namecheap-cli` does NOT manage it — add the `admin.`
     A record at that registrar. Check each site's NS before assuming `nc`.

### Recommended NixOS host spec
Workload is light on CPU (builds run on Netlify, not here) but each instance runs a Vite
`astro dev` preview, which is memory-hungry. Per instance ≈ bun admin (~100–150 MB) + astro
dev (~300–400 MB) ≈ ~0.5 GB; 3 instances + nginx + OS ≈ ~2 GB working set.
- **Recommended: 2 vCPU / 4 GB RAM / 50–80 GB SSD** (DO ~$24/mo). Comfortable headroom for 3
  Vite preview servers; avoids OOM.
- Could start **1 vCPU / 2 GB** for Site A alone and resize to 4 GB when adding B + C.
- Disk: 3 Astro checkouts + `node_modules` (~0.5–1 GB each) + session DBs + logs → 50 GB
  ample (80 GB for room).
- DO has no native NixOS image — provision via **`nixos-infect`** (our proven in-house path:
  convert a fresh Ubuntu 24.04 droplet → NixOS in place), mirroring our existing bootstrap
  script. (nixos-anywhere + disko is the alternative, but infect is the house pattern.)

## Goal

Let the 3 clients edit content in a **hosted** AstroAdmin reachable on the internet, one
instance per site. Loop: client logs in → edits → AstroAdmin writes files → commit + push
→ **Netlify build-on-push** → live. No control plane, no build workers, no isolation stack
(SaaS phase). Stand up **Site A first** as the simplest end-to-end proof, then Site B (also
do its DNS go-live), then Site C.

## What's already built (verified 2026-06-25)

Phase 3's auth slice is largely done; the gap is **hosting/ops**, not auth code.

**Auth (present, in `server/utils/auth.js` + `server/index.js` + `server/config.js`):**
- `verifyCredentials` — username + argon2id password hash via `Bun.password`, timing-safe
  (length-independent), runs the password check even on a wrong username. Plaintext
  `ADMIN_PASSWORD` is a dev-only fallback; a hash under a non-Bun runtime fails closed.
- `/api/login`, `/api/logout`, `/api/session`; `requireAuth` middleware on **every**
  `/api/*` data route (collections, content, build, publish, git, images).
- express-session; **SQLite session store in prod** (`SESSION_DB_PATH`, default
  `/data/sessions.db`) so logins survive restarts; cookie `secure` (prod) + `httpOnly` +
  `sameSite=strict` + 7-day maxAge; `trust proxy` set in prod (correct cookies behind a
  reverse proxy).
- Rate limiting on `/api/*` in prod (100 / 15 min); `authConfigWarnings` logs loudly on weak
  prod config (default user/pass, plaintext password, default session secret).
- `astroadmin hash-password` CLI to generate `ADMIN_PASSWORD_HASH`.

**Publish path (present, in `server/api/publish.js` + `git.js`):**
- `POST /api/publish`: optional git pre-step (pull --rebase → stage `git.paths` → commit →
  push) → build+deploy only **if** a deploy adapter is set. With **no adapter** (our case),
  it commits + pushes and stops — exactly the Netlify-on-push model.
- Staging is restricted to `config.git.paths` (files mode default: `src/content/`,
  `src/styles/`, `public/images/`); the binary content DB is never staged unless
  `includeDb`. `git.js` has a path-allowlist + traversal guard for file-level ops.

**Config / env (in `server/config.js`):** prod is driven by env — `NODE_ENV=production`,
`ASTROADMIN_PROJECT_ROOT`, `ASTROADMIN_PORT`/`ASTROADMIN_HOST`, `ADMIN_USERNAME`,
`ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `SESSION_DB_PATH`, `ALLOWED_ORIGINS` (CORS; prod
default is `[]` → must be set), `PREVIEW_URL` (prod default `http://localhost:4322`),
`GIT_ENABLED`. Production server command is `astroadmin start`.

## Gaps to close (small code) — do alongside Site A

1. **Commit hardening** (`publish.js` `runGitStep` + `git.js` `commitConfiguredGitPaths`):
   run git with hooks/filters disabled so a content commit can never execute repo code —
   `-c core.hooksPath=/dev/null --no-verify`, `core.fsmonitor=false`, disabled
   clean/smudge/LFS filters. We control the checkout so risk is low, but the architecture
   doc requires it and it's cheap. Reject symlinks in staged paths.
2. **Session fixation:** call `req.session.regenerate()` on successful login before setting
   `authenticated` (express-session keeps the pre-login session id otherwise). Small.
3. **Login brute-force:** add a stricter limiter on `/api/login` specifically (e.g. 10 / 15
   min per IP) on top of the general `/api/` limiter. Small.
4. **Confirm the UI gate:** the page routes (`/`, `/dashboard`) serve static HTML to anyone
   (data is API-protected — standard SPA shape). Verify the dashboard JS redirects to
   `/login` when `/api/session` returns unauthenticated, so an unauthenticated visitor never
   sees a broken shell. (No server change expected; just confirm.)

These are deliberately minor — the auth substrate is sound.

## The real work: per-site hosting

Each instance =
- the **AstroAdmin Bun server** (`astroadmin start`, `NODE_ENV=production`), bound to
  localhost, behind a TLS reverse proxy at `admin.<clientdomain>`;
- a **working checkout of the site repo** at `ASTROADMIN_PROJECT_ROOT` (for content files +
  preview), with that repo's **write deploy key** so push works;
- a **persistent volume** for `SESSION_DB_PATH` (and the checkout);
- env: per-site `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH`, a unique strong `SESSION_SECRET`,
  `ALLOWED_ORIGINS=https://admin.<clientdomain>`, `PREVIEW_URL` (see below).

### Preview (the trickiest bit)

The component-preview route (`integration/preview-route.astro`, `prerender = false`) and the
edit-preview iframe need a **running SSR server** on the checkout — content-only editing
still wants live preview. Options:
- **(A) Live `astro dev` per instance** (recommended): instant hot-reload preview, matches
  dev-mode UX. Runs the site's (first-party) dependency tree on the admin host — acceptable
  for these 3 sites per the architecture doc (no untrusted code; the supply-chain isolation
  that pushes builds to Netlify is a SaaS-phase concern). Bind the dev server to **localhost
  only** and proxy it through the authed admin — never expose it publicly. `PREVIEW_URL`
  points at it.
- (B) Build-preview (astro build → serve dist): also runs deps, slower, no hot reload.
- (C) Point preview at the Netlify deploy: no local server, but edits aren't visible until
  published — poor editor UX. Rejected for v1.

So each instance runs **two** processes: the admin server + an `astro dev` preview, as two
systemd units sharing the instance's working dir.

### Reverse proxy + TLS — nginx + `security.acme` (HTTP-01)

`services.nginx` with one TLS vhost per instance (`forceSSL` + `enableACME`) →
`proxyPass http://127.0.0.1:<adminPort>`. Per-host Let's Encrypt via HTTP-01 (no DNS API
keys; works across the sites' different registrars). The `astro dev` preview port is **never**
given a vhost — localhost-only. Matches our house nginx+acme convention. (Our other hosts use
a single DNS-01 wildcard per zone; that doesn't fit 3 admin subdomains across different
registrars, so per-host HTTP-01 here.)

### Runtime mechanism — NixOS module (built; `nixos/astroadmin-instance.nix`)

A NixOS module `services.astroadmin`, parameterised per site (domain, repoUrl, ports,
adminUsername, sopsFile), emitting per instance:
- a **checkout** one-shot (clone if absent + `bun install`; no auto-pull);
- `systemd` unit: AstroAdmin admin (`astroadmin start`, `NODE_ENV=production`, per-site env);
- `systemd` unit: `astro dev` preview (localhost bind);
- an nginx TLS vhost.
Secrets via **sops-nix**: the module declares `sops.secrets` (password hash, session secret,
deploy key) and renders the admin `EnvironmentFile` via `sops.templates` — never in the Nix
store. Bun + git host-wide. Reused per site; the seed of the SaaS NixOS substrate.

### Deploy key + push

Per-repo **write deploy key** generated per instance (`ssh-keygen`), public half added to the
GitHub repo's Deploy Keys (write access), private half on the host with
`GIT_SSH_COMMAND`/`~/.ssh/config` scoping it to that repo's remote. `simple-git` uses system
git, so push "just works" once the key is wired. (GitHub App tokens are the SaaS-phase
upgrade; deploy keys are the right near-term primitive.)

### DNS

`admin.<clientdomain>` A record → NixOS host IP. **Per-domain registrar varies** — Site A is
on a third-party registrar's nameservers (not Namecheap), so `namecheap-cli` does NOT apply;
add the record there. Check each site's NS before assuming `nc`. For Site B's go-live, also
the apex/`www` cutover from Wix → Netlify (separate, client-coordinated). (Concrete domains in
the private ops doc.)

## Site A first — execution outline

Site A is Astro 5.16, astroadmin ^0.2.0, content via `src/content/config.ts`; already
file-based → **no content migration**; live on Netlify (manual deploys). (Repo / domain /
Netlify ids: private ops doc.)
1. **Wire CD:** connect Site A's Netlify project to its GitHub repo (build-on-push) so Publish
   triggers a build. Confirm a push to `main` builds green (parallel to the Site B
   confirmation; the manual deploys become CD).
2. **Provision the NixOS host** (user) per spec, via `nixos-infect`; host flake in the private
   ops repo, mirroring our in-house NixOS hosts setup (sops-nix + nginx).
3. **Instantiate the NixOS module** (`nixos/astroadmin-instance.nix`) for Site A: set
   domain/repoUrl/ports/adminUsername/sopsFile; the checkout one-shot clones + `bun install`s.
4. **Secrets (sops):** `astroadmin hash-password` → `admin_password_hash`; a unique
   `session_secret`; an ed25519 `deploy_key` (its `.pub` added to the repo's Deploy Keys,
   write). The module renders the env + wires the key.
5. systemd units (admin + localhost `astro dev` preview) come from the module; finalize
   `previewUrl` exposure (the open item) against the live instance.
6. nginx + ACME vhost `admin.<site-a-domain>` → admin port; A record at the registrar → host
   IP (must resolve before rebuild so HTTP-01 validates).
7. Merge the auth/commit-hardening (PR #23) and ensure the instance runs that version.
8. **End-to-end test:** log in over TLS → edit a content field → preview updates → Publish →
   commit pushed → Netlify build-on-push → change live. Verify an unauthenticated request is
   rejected and the preview server isn't publicly reachable.

Then Site B (instance + the Wix→Netlify go-live; already GitHub-linked) and Site C (instance;
**also wire its Netlify CD** — not GitHub-linked either).

## Explicitly NOT in this phase (SaaS)

Control plane, multi-tenancy, isolated/gVisor/Firecracker build workers, GitHub App token
minting, object-storage media pipeline, provider-agnostic atomic rollback, draft/workspace
(Option C) DB cache. Near-term: per-site instances, first-party code, Netlify builds.

## Open items (not blocking the build-out)
- Provision + harden the NixOS host (user) — then I instantiate the module for Site A.
- **Browser-reachable preview routing** — the editor iframe loads `previewUrl` directly, so a
  localhost preview isn't reachable as-is. Likely a small astroadmin preview-proxy route (auth
  inherited) or a protected preview vhost. Finalize against the live instance.
- Whether to run the 3 preview servers always-on or lazily (start always-on; revisit if the
  2 GB tier is used).
