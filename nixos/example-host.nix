# Example NixOS host config wiring up AstroAdmin instances.
#
# Placeholders only — real per-site values (domains, repos) live privately, NOT
# in this public repo. Import the module and declare one instance per site;
# ports must be unique per instance. Conventions match omni-tend/hosts:
# sops-nix secrets + nginx + security.acme.
#
# The host's flake imports `sops-nix.nixosModules.sops` alongside this module.
# Each instance's sopsFile holds, under astroadmin/<name>/:
#   admin_password_hash   (from `astroadmin hash-password`)
#   session_secret        (a long random string)
#   deploy_key            (SSH private key; add its .pub to the repo's GitHub
#                          Deploy Keys, write-enabled)

{ ... }:

{
  imports = [ ./astroadmin-instance.nix ];

  services.astroadmin = {
    enable = true;
    acmeEmail = "ops@example.com";

    instances = {
      site-a = {
        domain        = "admin.site-a.example";
        repoUrl       = "git@github.com:org/site-a.git";
        adminPort     = 4001;
        previewPort   = 4321;
        adminUsername = "client-a";
        sopsFile      = ./secrets/site-a.yaml;
      };

      # Add site-b / site-c the same way, with unique ports:
      # site-b = { domain = "admin.site-b.example"; repoUrl = "..."; adminPort = 4002; previewPort = 4322; adminUsername = "client-b"; sopsFile = ./secrets/site-b.yaml; };
      # site-c = { domain = "admin.site-c.example"; repoUrl = "..."; adminPort = 4003; previewPort = 4323; adminUsername = "client-c"; sopsFile = ./secrets/site-c.yaml; };
    };
  };
}
