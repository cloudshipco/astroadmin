# Deploy adapter: build-on-host + push artifact (Option B)

**Date:** 2026-07-09
**Status:** netlify adapter BUILT and PARKED on branch
`feat/netlify-deploy-adapter` (not merged). Decision (2026-07-10): use **Netlify
Pro build-on-push** as the interim (no deploy token on the box), and migrate to
**self-host + Cloudflare** in ~4 weeks — where the deploy adapter (rsync, or this
netlify one) gets used. Netlify deploy tokens are account-wide incl. billing, so
the box-hosted netlify adapter is a non-starter for us; the self-host target uses
the existing `rsync` adapter (no token). Migration plan lives in the private ops
repo: `astroadmin-ops/plans/2026-07-09-self-host-migration.md`.

## Why

Today the intended publish path is `git push` → the git host's CI builds &
deploys (build-on-push). That couples us to the git host **and** the CI
provider, and build-on-push for **private org-owned** repos sits behind a paid
CI tier. Option B decouples deploy from the git host:

**Publish → build on our host → push the built `dist/` to a static host via a
scoped deploy token.** The static host never sees the repo, so no per-repo CI
authorization and no paid tier for private repos. It's also **host-agnostic**
(Netlify / Cloudflare Pages / object store / our own nginx) and fits a future
DB-backed, non-git content model.

Building on our host is safe for **first-party** sites (trusted code). For the
future multi-tenant SaaS with **untrusted** tenant builds, the build step moves
into a per-tenant **microVM sandbox** (the `saas-microvm-research` spike) — same
adapter, isolated builder. See Roadmap.

## Design

AstroAdmin already has a deploy-adapter framework (`server/utils/deploy.js` +
`adapters/rsync.js`) and the publish flow already runs *git step → build →
deploy(adapter)* (`server/api/publish.js`). So this is additive:

1. **`adapters/netlify.js`** — implements the adapter interface
   (`name` / `validate(config)` / `deploy({projectRoot, distDir, config, log})`).
   `deploy` runs `netlify deploy --prod --dir=<projectRoot>/<distDir>
   --site=<siteId>` via `spawn` (no shell), auth via `NETLIFY_AUTH_TOKEN` in the
   child env (never on argv). Register it in `deploy.js` (`netlify:
   netlifyAdapter`).
2. **Env-driven deploy config** (`server/config.js`) so a hosted instance can
   enable it without an `astroadmin.config.js`:
   - `DEPLOY_ADAPTER` → `deploy.adapter`
   - `NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN` → `deploy.netlify`
   Defaults keep `adapter: null` (deploy disabled) for non-hosted use.
3. **Publish flow** (unchanged code): commit+push preserves content history
   off-box; then `runProductionBuild()` (`astro build` on the host) → the
   configured adapter deploys `dist/`. The push no longer *triggers* deploy — the
   adapter does.
4. **NixOS module** — per instance: `deployAdapter`/`netlifySiteId` options →
   set `DEPLOY_ADAPTER`/`NETLIFY_SITE_ID` env, `NETLIFY_AUTH_TOKEN` from sops,
   and `netlify-cli` on the admin unit PATH.
5. **Secrets** — the Netlify auth token joins the per-instance sops file.

## Build note

`astro build` runs in the instance's project root (the checkout, or its
`subdir`), using the files-mode content already on disk. Output honors the
site's build config; the adapter deploys that directory. The admin unit already
has `bun`/`git` on PATH (for `bunx --bun astro build` + git).

## Tasks

- [x] `adapters/netlify.js` + registry entry (branch `feat/netlify-deploy-adapter`)
- [x] env-driven `deploy` config in `config.js`
- [ ] NixOS module: deploy env + CLI + sops token — **deferred**; the self-host
      target uses `rsync` (no token), so this only matters if we ever deploy to
      Netlify from the box (we won't, per the billing-token constraint)
- [ ] release astroadmin (minor) + bump the hosted site — deferred to the
      self-host migration
- [ ] ops: enable the deploy step for the instance (rsync web-root, self-host)
- [ ] live test: edit → Publish → build → deploy → change live

## Roadmap (beyond first-party)

- **Per-tenant microVM build sandbox** for untrusted builds (Firecracker/Cloud
  Hypervisor — the `saas-microvm-research` spike). The adapter is unchanged; only
  *where the build runs* moves into isolation.
- **On-demand preview** — start `astro dev` only when the editor/preview is open,
  instead of always-on, so one host packs far more instances (the preview server
  is the RAM hog).
- Host-agnostic adapters beyond Netlify (Cloudflare Pages, S3+CDN, self-hosted
  nginx on the same box → zero third-party recurring cost).
