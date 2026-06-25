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
# `sops-nix.nixosModules.sops` at the host level. No untrusted code runs here —
# the site code is first-party and the npm dependency tree builds on Netlify
# (build-on-push), not on this host.
#
# Secrets never enter the Nix store. Per instance, the host's sops file holds:
#   astroadmin/<name>/admin_password_hash   (from `astroadmin hash-password`)
#   astroadmin/<name>/session_secret        (a long random string)
#   astroadmin/<name>/deploy_key            (SSH private key, repo write access)
# This module declares the matching `sops.secrets` and renders the admin env
# via a `sops.templates` file.
#
# ⚠️ OPEN: browser-reachable preview routing. The editor's iframe loads
# `previewUrl` directly in the browser, so a localhost preview isn't reachable
# as-is. `previewUrl` is left configurable and defaults to the localhost dev
# server; exposing it safely (an authenticated admin preview-proxy route, or a
# protected preview vhost) is to be finalized against a live instance — see the
# Phase 3 plan. The admin vhost below is complete and correct regardless.
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

      previewUrl = lib.mkOption {
        type = lib.types.str;
        default = "http://127.0.0.1:${toString config.previewPort}";
        description = ''
          Browser-facing preview URL handed to the editor iframe (PREVIEW_URL).
          Defaults to the localhost dev server — NOT browser-reachable when
          hosted; override once preview exposure is finalized (see module note).
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

      projectRoot = lib.mkOption {
        type = lib.types.path;
        default = "${config.stateDir}/checkout";
        description = "Where the site repo is checked out (ASTROADMIN_PROJECT_ROOT).";
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
      ExecStart = checkoutScript name inst;
    };
  };

  mkAdminService = name: inst: lib.nameValuePair "astroadmin-${name}-admin" {
    description = "AstroAdmin editor — ${inst.domain}";
    after = [ "network-online.target" "astroadmin-${name}-checkout.service" ];
    requires = [ "astroadmin-${name}-checkout.service" ];
    wantedBy = [ "multi-user.target" ];
    environment = (instanceEnv name inst) // {
      ASTROADMIN_HOST = "127.0.0.1";
      ASTROADMIN_PORT = toString inst.adminPort;
      SESSION_DB_PATH = "${inst.stateDir}/sessions.db";
      ALLOWED_ORIGINS = "https://${inst.domain}";
      PREVIEW_URL = inst.previewUrl;
      GIT_AUTHOR_NAME = inst.committerName;
      GIT_COMMITTER_NAME = inst.committerName;
      GIT_AUTHOR_EMAIL = inst.committerEmail;
      GIT_COMMITTER_EMAIL = inst.committerEmail;
    };
    serviceConfig = hardening // {
      User = cfg.user;
      Group = cfg.group;
      WorkingDirectory = inst.projectRoot;
      # Rendered by sops-nix from the host's sops file (ADMIN_USERNAME +
      # ADMIN_PASSWORD_HASH + SESSION_SECRET); never in the Nix store.
      EnvironmentFile = config.sops.templates.${envTemplate name}.path;
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
    environment = instanceEnv name inst;
    serviceConfig = hardening // {
      User = cfg.user;
      Group = cfg.group;
      WorkingDirectory = inst.projectRoot;
      StateDirectory = "astroadmin/${name}";
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
      owner = cfg.user;
      mode = "0400";
    };
    ${secretKey name "admin_password_hash"} = { sopsFile = inst.sopsFile; owner = cfg.user; };
    ${secretKey name "session_secret"}      = { sopsFile = inst.sopsFile; owner = cfg.user; };
  };

  mkInstanceTemplate = name: inst:
    let
      hashPlaceholder = config.sops.placeholder.${secretKey name "admin_password_hash"};
      secretPlaceholder = config.sops.placeholder.${secretKey name "session_secret"};
    in {
      ${envTemplate name} = {
        owner = cfg.user;
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
    locations."/" = {
      proxyPass = "http://127.0.0.1:${toString inst.adminPort}";
      proxyWebsockets = true;     # admin live-reload / ws
    };
  };

  eachInstance = f: lib.mapAttrsToList f cfg.instances;

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
      description = "Contact email for the Let's Encrypt account.";
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
    systemd.services = lib.listToAttrs (lib.flatten (eachInstance (name: inst: [
      (mkCheckoutService name inst)
      (mkAdminService name inst)
      (mkPreviewService name inst)
    ])));

    # sops secrets + rendered env templates, merged across instances.
    sops.secrets = lib.mkMerge (eachInstance mkInstanceSecrets);
    sops.templates = lib.mkMerge (eachInstance mkInstanceTemplate);

    # nginx: one TLS vhost per instance → its admin port. The preview port is
    # deliberately NOT given a vhost.
    services.nginx = {
      enable = true;
      recommendedProxySettings = true;
      recommendedTlsSettings = true;
      recommendedGzipSettings = true;
      recommendedOptimisation = true;
      virtualHosts = lib.listToAttrs (eachInstance mkVhost);
    };

    security.acme = {
      acceptTerms = true;
      defaults.email = cfg.acmeEmail;
    };

    # nginx + ACME HTTP-01 need 80/443 open.
    networking.firewall.allowedTCPPorts = [ 80 443 ];
  };
}
