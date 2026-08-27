# Hosting AstroAdmin on NixOS

`astroadmin-instance.nix` is a NixOS module that runs one hosted AstroAdmin
editor per site. It's the near-term hosting substrate for self-editing client
sites (and the seed of the later SaaS substrate). Conventions follow our
in-house NixOS hosts pattern: **nginx + `security.acme`** for TLS and **sops-nix**
for secrets.

## What each instance runs

- a **git checkout** of the site repo at `projectRoot` (content + preview source);
- the **AstroAdmin server** (`astroadmin start`) on `127.0.0.1:<adminPort>` — the
  editor + the content-commit/push path;
- an **`astro dev` preview** on `127.0.0.1:<previewPort>`, reached in the browser
  through its own authenticated TLS vhost at `previewHost`;
- an **nginx** TLS vhost at `domain` (per-host Let's Encrypt cert, HTTP-01) →
  the admin port.

**Untrusted code does run on the host.** The site's own code is first-party, but
its npm/bun dependency tree is not, and that tree executes here: the checkout
one-shot runs `bun install` (postinstall scripts) and the preview runs
`astro dev`. Netlify builds the *public* site, which is a separate thing.

That is what the isolation is for. Each instance runs as its own
`astroadmin-<name>` Unix user, which is what makes the 0400 mode on its deploy
key, session secret and password hash actually separate one tenant from another
— so a privilege escalation out of one of those users defeats the whole model.
The long-running units and the checkout one-shot therefore set
`RestrictNamespaces`, blocking `unshare()`/`clone()` with namespace flags:
unprivileged user + network namespaces are a standing kernel local-privesc
surface for exactly this kind of code, and a recurring CVE class rather than a
single bug. Nothing here needs namespaces.

## Usage

```nix
# In the host's flake module list: sops-nix.nixosModules.sops + this module.
{
  imports = [ ./astroadmin-instance.nix ];

  services.astroadmin = {
    enable = true;
    acmeEmail = "ops@example.com";
    instances.site-a = {
      domain        = "admin.example.com";
      repoUrl       = "git@github.com:org/site-a.git";
      adminPort     = 4001;     # unique per instance
      previewPort   = 4321;     # unique per instance
      adminUsername = "client";
      publicUrl     = "https://site-a.com";  # optional: live-status + View-site link
      # subdir     = "site";    # set only if the Astro project is in a subdir
      sopsFile      = ./secrets/site-a.yaml;
    };
  };
}
```

See `example-host.nix` for a multi-site example.

## Per-site provisioning checklist

0. **Site `astro.config.mjs`** must be wired for the hosted editor, or the
   preview iframe fails (Vite blocks the proxied preview host, and there are no
   preview routes):
   - `integrations: [astroadmin()]` (from `astroadmin/integration`);
   - `vite.server.allowedHosts = [".your-editor-domain", "localhost"]` so the
     `preview.<domain>` iframe (served through nginx) can reach the dev server;
   - `vite.server.hmr = false` (the editor does its own refresh);
   - `site: "https://…"`.
1. **Secrets** in `sopsFile`, under `astroadmin/<name>/`:
   - `admin_password_hash` — from `astroadmin hash-password`;
   - `session_secret` — a long random string;
   - `deploy_key` — an ed25519 private key (`ssh-keygen -t ed25519 -f key -N ""`);
     add its `.pub` to the repo's **GitHub Deploy Keys with write access**.
   The module declares the `sops.secrets` + renders the admin `EnvironmentFile`
   via a `sops.templates` file; nothing lands in the Nix store.
2. **DNS**: an `A` record for `domain` → the host IP, at the domain's registrar
   (check its nameservers — not every site is on Namecheap). HTTP-01 needs the
   name resolving to the host before the first rebuild so ACME can validate.
3. **Netlify CD** (if using Netlify): connect the site's Netlify project to its
   GitHub repo **via the dashboard GitHub-App flow** (not the API, which leaves
   the link half-provisioned) so the editor's push triggers a build-on-push.
   Because the editor commits via a deploy key (an "unverified committer"),
   Netlify holds each build for approval — enable **Team settings → Access &
   security → Visitor access → "Auto-approve deploys from non-team members"**
   (team-level) so pushes deploy automatically.
4. `nixos-rebuild switch`. The checkout one-shot clones + `bun install`s on first
   activation; ACME issues the cert once `domain` resolves to the host.

## Provisioning the host

Use **`nixos-infect`** (our proven in-house path: convert a fresh Ubuntu 24.04
DO droplet → NixOS 25.11 in place), not nixos-anywhere — mirror our existing
host bootstrap script. Spec: 2 vCPU / 4 GB / 50–80 GB (1 vCPU / 2 GB is fine for
one site).

## Notes / decisions

- **Preview routing is done** (this note used to say it was the one open item;
  it was finalized against live instances and the claim went stale). Each
  instance gets a nested preview subdomain, `previewHost`, defaulting to
  `preview.<domain>`: an nginx TLS vhost that reverse-proxies to the localhost
  `astro dev`, gated by an `auth_request` to the admin's `/api/session`. The
  admin session cookie is scoped to `domain`, so it reaches this child host but
  never a sibling instance, and `previewUrl` defaults to `https://<previewHost>`
  so the iframe loads a real HTTPS origin rather than the viewer's localhost.
  An unauthenticated request gets a short "preview needs an active editor
  session" page, not content. Point a DNS A-record at the host for `previewHost`
  before rebuilding, or ACME cannot issue its certificate.
- **Site code updates** are a deliberate redeploy, and the redeploy is one
  command: `systemctl restart astroadmin-<name>-checkout`. The checkout one-shot
  clones if absent, otherwise fast-forwards onto `origin/<branch>`, then
  `bun install`s; the admin and preview units are `partOf` it, so they restart
  with it and pick up the new schema/templates. Nothing runs on a timer — a push
  converges when an operator asks, not on its own.

  The fast-forward is `--ff-only` and refuses to move if the checkout is dirty,
  on another branch, or diverged from origin, so an editor commit that could not
  be pushed is never discarded. Each refusal is a warning, not a unit failure:
  the admin unit `requires` the checkout unit, so failing here would take a live
  editor offline over a transient fetch error. Warnings land in
  `journalctl -u astroadmin-<name>-checkout`.
- **Resources**: each `astro dev` (Vite) preview is the memory cost — budget
  ~0.5 GB/instance; 2 vCPU / 4 GB comfortably hosts three.
- **Secrets** never enter the Nix store (sops-nix).
- **Untested on a live host** as of writing — validate with `nixos-rebuild
  build` against the target before the first `switch`.
