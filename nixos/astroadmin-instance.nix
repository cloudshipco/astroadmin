# AstroAdmin per-site instance — NixOS module
#
# Declares `services.astroadmin`, which runs one hosted AstroAdmin editor per
# site. Each instance is:
#   - a git checkout of the site repo (content + preview source),
#   - the AstroAdmin Bun server (the editor + content-commit/push), and
#   - an `astro dev` preview server, bound to localhost,
# fronted by Caddy with automatic TLS at the instance's domain.
#
# This is the near-term hosting substrate for the 3-client rollout (see the
# project's Phase 3 plan); it is also the seed of the later SaaS NixOS substrate.
# No untrusted code runs here — the site code is first-party and the npm
# dependency tree builds on Netlify (build-on-push), not on this host.
#
# Secrets are NEVER in the Nix store: `environmentFile` (the per-site admin
# credentials + session secret) and `deployKeyFile` (the repo write deploy key)
# are out-of-store paths, provisioned via agenix/sops-nix or placed on the host
# out of band.
#
# Example (see ./example-host.nix for a fuller one):
#
#   services.astroadmin = {
#     enable = true;
#     instances.site-a = {
#       domain      = "admin.example.com";
#       repoUrl     = "git@github.com:org/site-a.git";
#       adminPort   = 4001;
#       previewPort = 4321;
#       environmentFile = "/run/secrets/astroadmin-site-a.env";
#       deployKeyFile   = "/run/secrets/astroadmin-site-a-deploykey";
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
        description = "Public hostname for the editor; Caddy serves TLS here.";
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

      adminPort = lib.mkOption {
        type = lib.types.port;
        description = "Localhost port for the AstroAdmin server (Caddy proxies to it).";
      };

      previewPort = lib.mkOption {
        type = lib.types.port;
        description = "Localhost port for the `astro dev` preview server.";
      };

      stateDir = lib.mkOption {
        type = lib.types.path;
        default = "${cfg.stateDir}/${name}";
        description = "Per-instance state dir (checkout, session DB, caches).";
      };

      projectRoot = lib.mkOption {
        type = lib.types.path;
        default = "${config.stateDir}/checkout";
        description = "Where the site repo is checked out (ASTROADMIN_PROJECT_ROOT).";
      };

      environmentFile = lib.mkOption {
        type = lib.types.path;
        description = ''
          Out-of-store EnvironmentFile with the per-site secrets, one per line:
            ADMIN_USERNAME=...
            ADMIN_PASSWORD_HASH=...   (from `astroadmin hash-password`)
            SESSION_SECRET=...        (a long random string)
          Never commit this; provision via agenix/sops-nix.
        '';
      };

      deployKeyFile = lib.mkOption {
        type = lib.types.path;
        description = ''
          Out-of-store path to the SSH private deploy key with WRITE access to
          the site repo. Its public half is added to the repo's Deploy Keys.
        '';
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

  # Shared SSH command pinning the per-instance deploy key (no agent, no other
  # keys). accept-new trusts github.com's host key on first connect.
  gitSshCommand = inst:
    "${pkgs.openssh}/bin/ssh -i ${inst.deployKeyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new";

  # Common environment for an instance's units.
  instanceEnv = inst: {
    NODE_ENV = "production";
    HOME = inst.stateDir;                       # bun/astro/git caches live here
    ASTROADMIN_PROJECT_ROOT = inst.projectRoot;
    GIT_SSH_COMMAND = gitSshCommand inst;
  };

  # One-shot: clone the repo if absent, then `bun install`. Does NOT auto-pull
  # an existing checkout (the editor owns local commits/pushes) — site CODE
  # updates are a deliberate redeploy, not a restart side effect.
  checkoutScript = inst: pkgs.writeShellScript "astroadmin-${inst.domain}-checkout" ''
    set -euo pipefail
    export GIT_SSH_COMMAND="${gitSshCommand inst}"
    if [ ! -e ${inst.projectRoot}/.git ]; then
      ${pkgs.git}/bin/git clone --branch ${inst.branch} ${inst.repoUrl} ${inst.projectRoot}
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

  mkAdminService = name: inst: lib.nameValuePair "astroadmin-${name}-admin" {
    description = "AstroAdmin editor — ${inst.domain}";
    after = [ "network-online.target" "astroadmin-${name}-checkout.service" ];
    requires = [ "astroadmin-${name}-checkout.service" ];
    wantedBy = [ "multi-user.target" ];
    environment = (instanceEnv inst) // {
      ASTROADMIN_HOST = "127.0.0.1";
      ASTROADMIN_PORT = toString inst.adminPort;
      SESSION_DB_PATH = "${inst.stateDir}/sessions.db";
      ALLOWED_ORIGINS = "https://${inst.domain}";
      PREVIEW_URL = "http://127.0.0.1:${toString inst.previewPort}";
      GIT_AUTHOR_NAME = inst.committerName;
      GIT_COMMITTER_NAME = inst.committerName;
      GIT_AUTHOR_EMAIL = inst.committerEmail;
      GIT_COMMITTER_EMAIL = inst.committerEmail;
    };
    serviceConfig = hardening // {
      User = cfg.user;
      Group = cfg.group;
      WorkingDirectory = inst.projectRoot;
      EnvironmentFile = inst.environmentFile;
      # systemd creates + chowns this (under /var/lib) before the unit runs and
      # grants it read-write under ProtectSystem=strict.
      StateDirectory = "astroadmin/${name}";
      ExecStart = "${pkgs.bun}/bin/bun ${inst.projectRoot}/node_modules/astroadmin/bin/cli.js start";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  mkPreviewService = name: inst: lib.nameValuePair "astroadmin-${name}-preview" {
    description = "AstroAdmin preview (astro dev) — ${inst.domain}";
    after = [ "astroadmin-${name}-checkout.service" ];
    requires = [ "astroadmin-${name}-checkout.service" ];
    wantedBy = [ "multi-user.target" ];
    environment = instanceEnv inst;
    serviceConfig = hardening // {
      User = cfg.user;
      Group = cfg.group;
      WorkingDirectory = inst.projectRoot;
      StateDirectory = "astroadmin/${name}";
      # Bind to localhost ONLY — the preview server is never publicly exposed;
      # it is reached only via the authed admin's PREVIEW_URL proxy.
      ExecStart = "${pkgs.bun}/bin/bunx --bun astro dev --host 127.0.0.1 --port ${toString inst.previewPort}";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  mkCheckoutService = name: inst: lib.nameValuePair "astroadmin-${name}-checkout" {
    description = "AstroAdmin checkout + deps — ${inst.domain}";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = cfg.user;
      Group = cfg.group;
      StateDirectory = "astroadmin/${name}";
      ExecStart = checkoutScript inst;
    };
  };

in {
  options.services.astroadmin = {
    enable = lib.mkEnableOption "hosted AstroAdmin editor instances";

    user = lib.mkOption {
      type = lib.types.str;
      default = "astroadmin";
      description = "User the instances run as.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "astroadmin";
      description = "Group the instances run as.";
    };

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/astroadmin";
      description = "Base state directory; each instance gets a subdir.";
    };

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      example = "ops@example.com";
      description = "Contact email for Caddy's Let's Encrypt account.";
    };

    instances = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule instanceOpts);
      default = {};
      description = "Per-site editor instances, keyed by a short name.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Dedicated unprivileged service user.
    users.users = lib.mkIf (cfg.user == "astroadmin") {
      astroadmin = {
        isSystemUser = true;
        group = cfg.group;
        home = cfg.stateDir;
        createHome = true;
      };
    };
    users.groups = lib.mkIf (cfg.group == "astroadmin") { astroadmin = {}; };

    # Bun + git available host-wide (the checkout one-shot and units call them).
    environment.systemPackages = [ pkgs.bun pkgs.git ];

    # One checkout one-shot + admin + preview unit per instance.
    systemd.services = lib.listToAttrs (lib.flatten (lib.mapAttrsToList (name: inst: [
      (mkCheckoutService name inst)
      (mkAdminService name inst)
      (mkPreviewService name inst)
    ]) cfg.instances));

    # Caddy: one auto-TLS vhost per instance → its admin port. The preview port
    # is deliberately NOT given a vhost.
    services.caddy = {
      enable = true;
      email = cfg.acmeEmail;
      virtualHosts = lib.mapAttrs' (name: inst:
        lib.nameValuePair inst.domain {
          extraConfig = "reverse_proxy 127.0.0.1:${toString inst.adminPort}";
        }
      ) cfg.instances;
    };

    # Caddy needs 80/443 open for ACME + serving.
    networking.firewall.allowedTCPPorts = [ 80 443 ];
  };
}
