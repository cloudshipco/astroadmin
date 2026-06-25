# Hosting AstroAdmin on NixOS

`astroadmin-instance.nix` is a NixOS module that runs one hosted AstroAdmin
editor per site. It's the near-term hosting substrate for self-editing client
sites (and the seed of the later SaaS substrate).

## What each instance runs

- a **git checkout** of the site repo at `projectRoot` (content + preview source);
- the **AstroAdmin server** (`astroadmin start`) on `127.0.0.1:<adminPort>` — the
  editor + the content-commit/push path;
- an **`astro dev` preview** on `127.0.0.1:<previewPort>` — localhost only, reached
  solely through the authed admin's `PREVIEW_URL` proxy, never publicly exposed;
- a **Caddy** auto-TLS vhost at `domain` → the admin port.

No untrusted code runs on the host: the site code is first-party, and the npm
dependency tree builds on Netlify (build-on-push), not here.

## Usage

```nix
# configuration.nix (or a flake module)
{
  imports = [ ./astroadmin-instance.nix ];

  services.astroadmin = {
    enable = true;
    acmeEmail = "ops@example.com";
    instances.site-a = {
      domain      = "admin.example.com";
      repoUrl     = "git@github.com:org/site-a.git";
      adminPort   = 4001;     # unique per instance
      previewPort = 4321;     # unique per instance
      environmentFile = "/run/secrets/astroadmin-site-a.env";
      deployKeyFile   = "/run/secrets/astroadmin-site-a-deploykey";
    };
  };
}
```

See `example-host.nix` for a multi-site example.

## Per-site provisioning checklist

1. **Credentials secret** (`environmentFile`), out of the Nix store (agenix/sops):
   ```
   ADMIN_USERNAME=client
   ADMIN_PASSWORD_HASH=<from `astroadmin hash-password`>
   SESSION_SECRET=<long random string>
   ```
2. **Deploy key** (`deployKeyFile`): `ssh-keygen -t ed25519 -f key -N ""`; add the
   `.pub` to the repo's **GitHub Deploy Keys with write access**; place the private
   half at `deployKeyFile` (mode 600, owned by the `astroadmin` user).
3. **DNS**: an `A` record for `domain` → the host IP, at the domain's registrar
   (check its nameservers — not every site is on Namecheap).
4. **Netlify CD**: connect the site's Netlify project to its GitHub repo so the
   editor's push triggers a build-on-push. (Otherwise Publish pushes but nothing
   rebuilds.)
5. `nixos-rebuild switch`. The checkout one-shot clones + `bun install`s on first
   activation.

## Notes / decisions

- **Site code updates** are a deliberate redeploy: the checkout one-shot clones if
  absent and `bun install`s, but does **not** auto-pull an existing checkout (the
  editor owns local content commits/pushes). To pull new site code, update the
  checkout out of band or extend the one-shot.
- **Resources**: each `astro dev` (Vite) preview is the memory cost — budget
  ~0.5 GB/instance; 2 vCPU / 4 GB comfortably hosts three.
- **Secrets** are never in the Nix store — both `environmentFile` and
  `deployKeyFile` are out-of-store paths.
- **Untested on a live host** as of writing — validate with `nixos-rebuild
  build` against the target host before the first `switch`.
