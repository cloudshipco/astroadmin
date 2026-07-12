# AstroAdmin per-site instance — NixOS module
#
# Declares `services.astroadmin`, which runs one hosted AstroAdmin editor per
# site. Each instance is:
#   - a git checkout of the site repo (content + preview source),
#   - the AstroAdmin Bun server (the editor + content-commit/push), and
#   - an `astro dev` preview server, bound to localhost,
# fronted by nginx with a per-host Let's Encrypt cert (HTTP-01) at the
# instance's domain.
#
# Conventions follow our in-house NixOS hosts pattern: nginx + `security.acme`
# (not Caddy), and **sops-nix** for secrets (not agenix). Import
# `sops-nix.nixosModules.sops` at the host level.
#
# Isolation: each instance runs as its OWN Unix user (`astroadmin-<name>`), not
# a shared account. The site's own code is first-party, but its npm/bun
# dependency TREE is not, and that tree executes on this host — the checkout
# one-shot runs `bun install` (postinstall scripts) and the preview runs
# `astro dev`. Per-user identity is what makes the 0400 mode on each instance's
# deploy key / session secret actually isolate one tenant from another.
#
# RESIDUAL RISK (filesystem plane only): per-user isolation covers secrets and
# state, NOT the shared host network namespace. The admin + `astro dev` servers
# bind 127.0.0.1:<port> with no auth of their own (auth lives at nginx), so a
# process running as one tenant can still connect to a sibling's localhost port
# (reading draft/preview content) or, during a sibling's restart window, bind
# that port first and receive nginx-forwarded requests + cookies. Fully closing
# this needs per-tenant network isolation (network namespaces / microVMs), which
# is tracked as the microVM-per-editor migration — not solvable with Unix users
# alone. Exploiting it requires code execution as a tenant in the first place.
#
# Secrets never enter the Nix store. Per instance, the host's sops file holds:
#   astroadmin/<name>/admin_password_hash   (from `astroadmin hash-password`)
#   astroadmin/<name>/session_secret        (a long random string)
#   astroadmin/<name>/deploy_key            (SSH private key, repo write access)
# This module declares the matching `sops.secrets` and renders the admin env
# via a `sops.templates` file.
#
# Browser-reachable preview: each instance gets a nested preview subdomain
# (`previewHost`, default `preview.<domain>`) — an authenticated nginx TLS vhost
# that reverse-proxies to the localhost `astro dev` at root. It's gated by an
# `auth_request` to the admin's /api/session; the admin session cookie is scoped
# to `domain` (SESSION_COOKIE_DOMAIN) so it reaches this child host but never a
# sibling instance. `previewUrl` (PREVIEW_URL) defaults to `https://<previewHost>`,
# so the iframe loads a real HTTPS origin instead of the viewer's localhost.
# Point a DNS A-record for `previewHost` at the host before rebuilding (ACME).
#
# Example (see ./example-host.nix):
#
#   services.astroadmin = {
#     enable = true;
#     acmeEmail = "ops@example.com";
#     instances.site-a = {
#       domain      = "admin.example.com";
#       repoUrl     = "git@github.com:org/site-a.git";
#       adminPort   = 4001;
#       previewPort = 4321;
#       adminUsername = "client";
#       sopsFile      = ../secrets/site-a.yaml;
#     };
#   };

{ config, lib, pkgs, ... }:

let
  cfg = config.services.astroadmin;

  # The instance submodule — one attrset entry per site.
  instanceOpts = { name, config, ... }: {
    options = {
      domain = lib.mkOption {
        type = lib.types.str;
        example = "admin.example.com";
        description = "Public hostname for the editor; nginx serves TLS here.";
      };

      repoUrl = lib.mkOption {
        type = lib.types.str;
        example = "git@github.com:org/site-a.git";
        description = "SSH git URL of the site repo (cloned with the deploy key).";
      };

      branch = lib.mkOption {
        type = lib.types.str;
        default = "main";
        description = "Branch the editor edits, commits to, and pushes.";
      };

      user = lib.mkOption {
        type = lib.types.str;
        default = "astroadmin-${name}";
        description = ''
          Dedicated Unix user this instance's units run as. Per-instance by
          design (NOT a shared account): each instance runs untrusted code on the
          host — the site repo's npm/bun dependency tree executes during the
          checkout one-shot (`bun install` postinstall) and under `astro dev` —
          so a shared user would let one site's process read another site's
          deploy key / session secret / password hash despite their 0400 mode.
          A per-user identity is what makes that mode actually isolate tenants.
          Override only to pin a pre-existing uid.
        '';
      };

      group = lib.mkOption {
        type = lib.types.str;
        default = config.user;
        description = "Primary group for the instance user (defaults to a matching per-instance group).";
      };

      adminPort = lib.mkOption {
        type = lib.types.port;
        description = "Localhost port for the AstroAdmin server (nginx proxies to it).";
      };

      previewPort = lib.mkOption {
        type = lib.types.port;
        description = "Localhost port for the `astro dev` preview server.";
      };

      adminUsername = lib.mkOption {
        type = lib.types.str;
        default = "admin";
        description = "Login username (the password hash + session secret come from sops).";
      };

      previewHost = lib.mkOption {
        type = lib.types.str;
        default = "preview.${config.domain}";
        description = ''
          Nested preview subdomain (a CHILD of `domain`). nginx serves a TLS
          vhost here that reverse-proxies to the localhost `astro dev` at root,
          gated by an auth_request to the admin's /api/session. Being a child of
          the admin host, the admin session cookie (scoped to `domain`) reaches
          it, but sibling instances never do. Needs its own DNS A-record.
        '';
      };

      previewUrl = lib.mkOption {
        type = lib.types.str;
        default = "https://${config.previewHost}";
        description = ''
          Browser-facing preview origin handed to the editor iframe (PREVIEW_URL).
          Defaults to the preview subdomain — a real HTTPS origin, so the iframe
          no longer points at the viewer's localhost.
        '';
      };

      publicUrl = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "https://example.com";
        description = ''
          Public/production site origin (PUBLIC_URL). Optional. When set, the
          editor shows a "View live site" link and, after a Publish, polls this
          origin to report when the change is actually live — useful with
          build-on-push hosts (Netlify, Cloudflare Pages) where a deploy lags
          the push by a short while. Leave null to disable the live check.
        '';
      };

      sopsFile = lib.mkOption {
        type = lib.types.path;
        description = ''
          sops file holding this instance's secrets under the keys
          astroadmin/<name>/{admin_password_hash,session_secret,deploy_key}.
        '';
      };

      stateDir = lib.mkOption {
        type = lib.types.path;
        default = "${cfg.stateDir}/${name}";
        description = "Per-instance state dir (checkout, session DB, caches).";
      };

      checkoutPath = lib.mkOption {
        type = lib.types.path;
        default = "${config.stateDir}/checkout";
        description = "Where the site repo is cloned (the git root).";
      };

      subdir = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "site";
        description = ''
          Subdirectory of the repo that holds the Astro project, for monorepos
          (e.g. the Netlify `base`). Empty = the repo root. astroadmin runs and
          `bun install`s here; git commit/push still act on the whole checkout.
        '';
      };

      projectRoot = lib.mkOption {
        type = lib.types.path;
        default =
          if config.subdir == "" then config.checkoutPath
          else "${config.checkoutPath}/${config.subdir}";
        description = "Astro project root (ASTROADMIN_PROJECT_ROOT) — checkoutPath or its subdir.";
      };

      committerName = lib.mkOption {
        type = lib.types.str;
        default = "AstroAdmin";
        description = "git author/committer name for content commits.";
      };

      committerEmail = lib.mkOption {
        type = lib.types.str;
        default = "astroadmin@${config.domain}";
        description = "git author/committer email for content commits.";
      };
    };
  };

  # sops secret/template key helpers.
  secretKey = name: leaf: "astroadmin/${name}/${leaf}";
  envTemplate = name: "astroadmin-${name}.env";
  deployKeyPath = name: config.sops.secrets.${secretKey name "deploy_key"}.path;

  # Shared SSH command pinning the per-instance deploy key (no agent, no other
  # keys). accept-new trusts github.com's host key on first connect.
  gitSshCommand = name: inst:
    "${pkgs.openssh}/bin/ssh -i ${deployKeyPath name} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new";

  # Common environment for an instance's units.
  instanceEnv = name: inst: {
    NODE_ENV = "production";
    HOME = inst.stateDir;                       # bun/astro/git caches live here
    ASTROADMIN_PROJECT_ROOT = inst.projectRoot;
    GIT_SSH_COMMAND = gitSshCommand name inst;
  };

  # One-shot: clone the repo if absent, then `bun install`. Does NOT auto-pull
  # an existing checkout (the editor owns local commits/pushes) — site CODE
  # updates are a deliberate redeploy, not a restart side effect.
  checkoutScript = name: inst: pkgs.writeShellScript "astroadmin-${name}-checkout" ''
    set -euo pipefail
    export GIT_SSH_COMMAND="${gitSshCommand name inst}"
    if [ ! -e ${inst.checkoutPath}/.git ]; then
      ${pkgs.git}/bin/git clone --branch ${inst.branch} ${inst.repoUrl} ${inst.checkoutPath}
    fi
    cd ${inst.projectRoot}
    ${pkgs.bun}/bin/bun install --frozen-lockfile || ${pkgs.bun}/bin/bun install
  '';

  # systemd hardening shared by the long-running units.
  hardening = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
  };

  mkCheckoutService = name: inst: lib.nameValuePair "astroadmin-${name}-checkout" {
    description = "AstroAdmin checkout + deps — ${inst.domain}";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = inst.user;
      Group = inst.group;
      StateDirectory = "astroadmin/${name}";
      # 0700 (not systemd's 0755 default): owner-only, so a sibling instance's
      # user can't traverse in and read this instance's sessions.db (0644, in
      # the home) — and, unlike 0750, a shared/overridden group grants nothing
      # either. systemd enforces this on the existing leaf dir at every start,
      # so it takes effect on already-provisioned live boxes too — unlike
      # `homeMode`, which only applies when createHome first makes the dir.
      StateDirectoryMode = "0700";
      ExecStart = checkoutScript name inst;
    };
  };

  mkAdminService = name: inst: lib.nameValuePair "astroadmin-${name}-admin" {
    description = "AstroAdmin editor — ${inst.domain}";
    after = [ "network-online.target" "astroadmin-${name}-checkout.service" ];
    wants = [ "network-online.target" ];
    requires = [ "astroadmin-${name}-checkout.service" ];
    wantedBy = [ "multi-user.target" ];
    # The admin shells out to bare `git` (simple-git, for Publish commit/push)
    # and `bunx` (astro build); systemd's minimal service PATH lacks both, so
    # put them on the unit's PATH explicitly.
    path = [ pkgs.git pkgs.bun ];
    environment = (instanceEnv name inst) // {
      ASTROADMIN_HOST = "127.0.0.1";
      ASTROADMIN_PORT = toString inst.adminPort;
      SESSION_DB_PATH = "${inst.stateDir}/sessions.db";
      ALLOWED_ORIGINS = "https://${inst.domain}";
      PREVIEW_URL = inst.previewUrl;
      # Scope the session cookie to the admin host so it also reaches the nested
      # preview subdomain (for the preview vhost's auth_request) — but never a
      # sibling instance's host. See config.js sessionCookie.domain.
      SESSION_COOKIE_DOMAIN = inst.domain;
      # Per-instance cookie name: avoids the connect.sid host-only/domain
      # collision, and further isolates instances (distinct names).
      SESSION_COOKIE_NAME = "astroadmin_${name}";
      # Push on EVERY commit path, not just the big Publish button. The
      # changes-panel "Commit" hits /api/git/commit, which only pushes when
      # autoPush is on; without this a client's commit lands locally but never
      # triggers the Netlify build-on-push (silent "saved but site unchanged").
      GIT_AUTO_PUSH = "true";
      GIT_AUTHOR_NAME = inst.committerName;
      GIT_COMMITTER_NAME = inst.committerName;
      GIT_AUTHOR_EMAIL = inst.committerEmail;
      GIT_COMMITTER_EMAIL = inst.committerEmail;
    } // lib.optionalAttrs (inst.publicUrl != null) {
      # Enables the editor's "View live site" link + post-publish live-status check.
      PUBLIC_URL = inst.publicUrl;
    };
    serviceConfig = hardening // {
      User = inst.user;
      Group = inst.group;
      WorkingDirectory = inst.projectRoot;
      # Rendered by sops-nix from the host's sops file (ADMIN_USERNAME +
      # ADMIN_PASSWORD_HASH + SESSION_SECRET); never in the Nix store.
      EnvironmentFile = config.sops.templates.${envTemplate name}.path;
      # systemd creates + chowns this (under /var/lib) before the unit runs and
      # grants it read-write under ProtectSystem=strict.
      StateDirectory = "astroadmin/${name}";
      # 0700 (not systemd's 0755 default): owner-only, so a sibling instance's
      # user can't traverse in and read this instance's sessions.db (0644, in
      # the home) — and, unlike 0750, a shared/overridden group grants nothing
      # either. systemd enforces this on the existing leaf dir at every start,
      # so it takes effect on already-provisioned live boxes too — unlike
      # `homeMode`, which only applies when createHome first makes the dir.
      StateDirectoryMode = "0700";
      # --no-astro: the dedicated preview unit owns `astro dev`; the admin must
      # NOT spawn a second one (it did, and a failed spawn killed the admin).
      ExecStart = "${pkgs.bun}/bin/bun ${inst.projectRoot}/node_modules/astroadmin/bin/cli.js start --no-astro";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  mkPreviewService = name: inst: lib.nameValuePair "astroadmin-${name}-preview" {
    description = "AstroAdmin preview (astro dev) — ${inst.domain}";
    after = [ "astroadmin-${name}-checkout.service" ];
    requires = [ "astroadmin-${name}-checkout.service" ];
    wantedBy = [ "multi-user.target" ];
    # astro dev runs under Bun (`bunx --bun`), whose runtime file-watcher does NOT
    # fire for src/content edits — the preview would serve stale content until a
    # restart. Force chokidar (Vite's watcher) into polling mode so the editor's
    # live preview reflects saves. Polling is a stat() loop, so it works
    # regardless of runtime; the interval trades latency for CPU.
    environment = (instanceEnv name inst) // {
      CHOKIDAR_USEPOLLING = "1";
      CHOKIDAR_INTERVAL = "300";
    };
    serviceConfig = hardening // {
      User = inst.user;
      Group = inst.group;
      WorkingDirectory = inst.projectRoot;
      StateDirectory = "astroadmin/${name}";
      # 0700 (not systemd's 0755 default): owner-only, so a sibling instance's
      # user can't traverse in and read this instance's sessions.db (0644, in
      # the home) — and, unlike 0750, a shared/overridden group grants nothing
      # either. systemd enforces this on the existing leaf dir at every start,
      # so it takes effect on already-provisioned live boxes too — unlike
      # `homeMode`, which only applies when createHome first makes the dir.
      StateDirectoryMode = "0700";
      # Bind to localhost ONLY — never given an nginx vhost of its own.
      ExecStart = "${pkgs.bun}/bin/bunx --bun astro dev --host 127.0.0.1 --port ${toString inst.previewPort}";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  # sops secrets for one instance: the deploy key (owned by the service user)
  # plus the two values folded into the rendered env template.
  mkInstanceSecrets = name: inst: {
    ${secretKey name "deploy_key"} = {
      sopsFile = inst.sopsFile;
      owner = inst.user;
      mode = "0400";
    };
    ${secretKey name "admin_password_hash"} = { sopsFile = inst.sopsFile; owner = inst.user; };
    ${secretKey name "session_secret"}      = { sopsFile = inst.sopsFile; owner = inst.user; };
  };

  mkInstanceTemplate = name: inst:
    let
      hashPlaceholder = config.sops.placeholder.${secretKey name "admin_password_hash"};
      secretPlaceholder = config.sops.placeholder.${secretKey name "session_secret"};
    in {
      ${envTemplate name} = {
        owner = inst.user;
        content = ''
          ADMIN_USERNAME=${inst.adminUsername}
          ADMIN_PASSWORD_HASH=${hashPlaceholder}
          SESSION_SECRET=${secretPlaceholder}
        '';
      };
    };

  mkVhost = name: inst: lib.nameValuePair inst.domain {
    forceSSL = true;
    enableACME = true;            # per-host Let's Encrypt cert via HTTP-01
    # AstroAdmin is a CMS with image upload (/api/images); nginx's 1 MB default
    # would 413 anything larger. Allow room for photos.
    extraConfig = "client_max_body_size 25m;";
    locations."/" = {
      proxyPass = "http://127.0.0.1:${toString inst.adminPort}";
      proxyWebsockets = true;     # admin live-reload / ws
    };
    # Brute-force guard on the only credential-accepting endpoint. The app's
    # own limiter is a shared 100/15min budget across all of /api/*, so a
    # login-specific ceiling belongs here. Exact-match wins over "/" for this
    # URI only; everything else keeps the plain proxy. The zone is declared
    # once in appendHttpConfig below. 429 (not the 503 default) so the client
    # sees a retryable rate-limit, matching the app limiter's semantics.
    locations."= /api/login" = {
      proxyPass = "http://127.0.0.1:${toString inst.adminPort}";
      extraConfig = ''
        limit_req zone=astroadmin_login burst=10 nodelay;
        limit_req_status 429;
      '';
    };
  };

  # Authenticated preview vhost on the nested preview subdomain: reverse-proxy
  # to the localhost `astro dev` at ROOT (so Astro's absolute asset paths + HMR
  # ws work), gated by an nginx auth_request to the admin's /api/session. The
  # admin session cookie (scoped to `domain`) reaches this child host; siblings
  # never do. The astro dev port itself is never given a public vhost.
  mkPreviewVhost = name: inst: lib.nameValuePair inst.previewHost {
    forceSSL = true;
    enableACME = true;
    locations."/" = {
      proxyPass = "http://127.0.0.1:${toString inst.previewPort}";
      proxyWebsockets = true;     # Astro HMR
      extraConfig = ''
        auth_request /__preview_authz;
        error_page 401 = @preview_login;
        # Vite dev rejects unknown Host values ("host not allowed"); present
        # localhost upstream so the check passes. The browser still talks to the
        # real preview origin, and Vite's HMR client derives its ws URL from
        # window.location, so live-reload still targets this host.
        proxy_set_header Host localhost;
      '';
    };
    # Subrequest: the admin's dedicated /__authz (204 authed, 401 not). NOT an
    # /api/ route — those are rate-limited, and a preview page fires one
    # subrequest per asset, so a rate-limited endpoint 429s → auth_request 500.
    # And NOT /api/session, which 200s logged-out (auth_request reads as ALLOW).
    # nginx forwards the client's Cookie header by default; drop the body.
    locations."= /__preview_authz" = {
      proxyPass = "http://127.0.0.1:${toString inst.adminPort}/__authz";
      extraConfig = ''
        internal;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host ${inst.domain};
      '';
    };
    # Unauthenticated: serve a tiny static page INSIDE the iframe — never a
    # redirect to the admin root (that loads the whole dashboard in the iframe,
    # whose own preview pane re-triggers this → an infinite hall of mirrors).
    # The link uses target=_top so login opens in the full window.
    # Return 200 (not 401) here: a 401 from the error handler re-matches
    # `error_page 401` → internal-redirect loop → nginx 500. The page itself is
    # the "denied" signal; the code just can't be 401.
    locations."@preview_login".extraConfig = ''
      default_type text/html;
      return 200 '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{font:15px/1.6 system-ui,sans-serif;color:#334155;margin:2.5rem;text-align:center}a{color:#4f46e5}</style><p>Preview needs an active editor session.</p><p><a href="https://${inst.domain}/" target="_top">Open the editor</a>, log in, then reload.</p>';
    '';
  };

  eachInstance = f: lib.mapAttrsToList f cfg.instances;

in {
  options.services.astroadmin = {
    enable = lib.mkEnableOption "hosted AstroAdmin editor instances";

    # NOTE: identity is per-instance now (see `instances.<name>.user`), not a
    # single shared `services.astroadmin.user`. That option was removed so each
    # tenant is isolated by its own Unix user.

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/astroadmin";
      description = "Base state directory; each instance gets a subdir.";
    };

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      example = "ops@example.com";
      description = "Contact email for the Let's Encrypt account.";
    };

    instances = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule instanceOpts);
      default = {};
      description = "Per-site editor instances, keyed by a short name.";
    };
  };

  config = lib.mkIf cfg.enable {
    # A dedicated unprivileged user + group PER instance, so one site's process
    # can't read another site's 0400 secrets. Each user's home is its own state
    # subdir (0750). The shared base dir stays root-owned (tmpfiles below).
    users.users = lib.listToAttrs (eachInstance (name: inst:
      lib.nameValuePair inst.user {
        isSystemUser = true;
        group        = inst.group;
        home         = inst.stateDir;
        createHome   = true;
        homeMode     = "0700";
      }));
    users.groups = lib.listToAttrs (eachInstance (name: inst:
      lib.nameValuePair inst.group {}));

    # A system username is capped at 31 chars; "astroadmin-<slug>" could exceed
    # it for a very long slug. Fail eval with a clear message rather than a
    # cryptic useradd error at switch time.
    assertions = (eachInstance (name: inst: {
      assertion = builtins.stringLength inst.user <= 31;
      message = "astroadmin: instance '${name}' derives user '${inst.user}' (${toString (builtins.stringLength inst.user)} chars) which exceeds the 31-char system-username limit — use a shorter instance name or set instances.${name}.user.";
    })) ++ [
      # Distinct Unix identity per instance — two instances pinning the same
      # explicit `user` would silently collapse (listToAttrs keeps the last),
      # re-sharing the account this whole design exists to separate.
      (let users = eachInstance (name: inst: inst.user); in {
        assertion = (builtins.length users) == (builtins.length (lib.unique users));
        message = "astroadmin: two instances resolve to the same Unix user (${lib.concatStringsSep ", " users}) — give each a distinct instances.<name>.user.";
      })
    ];

    # Base state dir stays root-owned (each instance's home is a subdir it owns).
    systemd.tmpfiles.rules = [ "d ${cfg.stateDir} 0755 root root -" ];

    # Ownership migration: instances used to share the `astroadmin` user, so on
    # an existing box each state subdir + its contents (checkout, node_modules,
    # sessions.db) is still owned by that account. Re-chown to the per-instance
    # user, once — guarded on the current owner so it's a no-op after migration
    # and on fresh installs (StateDirectory/createHome make it correct there).
    system.activationScripts.astroadmin-state-migrate = {
      deps = [ "users" "groups" ];
      text = ''
        # Base dir root-owned + traversable, set HERE (this script is ordered
        # before unit start via deps) rather than relying on tmpfiles ordering —
        # it was the old shared user's 0700 home, and per-instance users need x
        # on it to reach their own subdirs at first post-switch start.
        if [ -e ${cfg.stateDir} ]; then
          ${pkgs.coreutils}/bin/chown root:root ${cfg.stateDir}
          ${pkgs.coreutils}/bin/chmod 0755 ${cfg.stateDir}
        fi
      '' + lib.concatStringsSep "\n" (eachInstance (name: inst: ''
        # Per-instance state used to be owned by the shared `astroadmin` user;
        # re-own to the per-instance user. A root-owned completion marker (in
        # the 0755 root base dir, so a tenant can't forge it to skip a real
        # migration) makes this genuinely one-time: once set, we never scan
        # again. Until then the guard uses find (not a top-dir owner check) so
        # an interrupted chown -R still converges — a top-only check would see
        # the top already re-owned and skip, orphaning descendants under the
        # deleted uid forever. The marker is written only AFTER chown succeeds
        # (or when there was nothing to migrate), never mid-run.
        if [ ! -e ${cfg.stateDir}/.migrated-${name} ]; then
          if [ -e ${inst.stateDir} ] \
             && [ -n "$(${pkgs.findutils}/bin/find ${inst.stateDir} \! -user ${inst.user} -print -quit 2>/dev/null)" ]; then
            echo "astroadmin: migrating ${inst.stateDir} ownership -> ${inst.user}:${inst.group}"
            ${pkgs.coreutils}/bin/chown -R ${inst.user}:${inst.group} ${inst.stateDir}
          fi
          ${pkgs.coreutils}/bin/touch ${cfg.stateDir}/.migrated-${name}
        fi
      ''));
    };

    # Bun + git available host-wide (the checkout one-shot and units call them).
    environment.systemPackages = [ pkgs.bun pkgs.git ];

    # One checkout one-shot + admin + preview unit per instance.
    systemd.services = lib.listToAttrs (lib.flatten (eachInstance (name: inst: [
      (mkCheckoutService name inst)
      (mkAdminService name inst)
      (mkPreviewService name inst)
    ])));

    # sops secrets + rendered env templates, merged across instances.
    sops.secrets = lib.mkMerge (eachInstance mkInstanceSecrets);
    sops.templates = lib.mkMerge (eachInstance mkInstanceTemplate);

    # nginx: per instance, a TLS admin vhost (→ admin port) and an authenticated
    # preview vhost on the nested preview subdomain (→ astro dev at root). The
    # astro dev port is never exposed directly.
    services.nginx = {
      enable = true;
      recommendedProxySettings = true;
      recommendedTlsSettings = true;
      recommendedGzipSettings = true;
      recommendedOptimisation = true;
      # Each instance contributes two long vhost names (<slug>.<domain> +
      # preview.<slug>.<domain>). With more than one instance the combined
      # server_names exceed nginx's default 64-byte hash bucket, so nginx fails
      # to start ("could not build server_names_hash"). Bump it so multi-instance
      # hosts work out of the box. (A host may raise it further if needed.)
      serverNamesHashBucketSize = lib.mkDefault 128;
      # One shared per-IP zone for every instance's /api/login (declared once
      # at http scope; the per-vhost locations consume it). 5 req/min steady
      # with burst 10 permits a fumbled human login but caps a brute force at
      # ~10 quick tries then one per 12s — argon2id + 32-char generated
      # passwords make that hopeless. Deliberately NOT applied to /__authz
      # (session-cookie check, no password) — the preview vhost fires it once
      # per asset via auth_request, where a 429 becomes a 500.
      appendHttpConfig = ''
        limit_req_zone $binary_remote_addr zone=astroadmin_login:1m rate=5r/m;
      '';
      virtualHosts = lib.listToAttrs (
        (eachInstance mkVhost) ++ (eachInstance mkPreviewVhost)
      );
    };

    security.acme = {
      acceptTerms = true;
      defaults.email = cfg.acmeEmail;
    };

    # nginx + ACME HTTP-01 need 80/443 open.
    networking.firewall.allowedTCPPorts = [ 80 443 ];
  };
}
