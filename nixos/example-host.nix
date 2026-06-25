# Example NixOS host config wiring up AstroAdmin instances.
#
# Placeholders only — real per-site values (domains, repos, secret paths) live
# privately, NOT in this public repo. Import the module and declare one instance
# per site. Ports must be unique per instance.
#
# Secrets here are shown as agenix paths; sops-nix works equally. Each instance
# needs:
#   - <name>.env        → ADMIN_USERNAME, ADMIN_PASSWORD_HASH, SESSION_SECRET
#   - <name>-deploykey  → SSH private key with write access to the site repo
# Generate the hash with `astroadmin hash-password`; add the deploy key's PUBLIC
# half to the repo's GitHub Deploy Keys (allow write).

{ ... }:

{
  imports = [ ./astroadmin-instance.nix ];

  services.astroadmin = {
    enable = true;
    acmeEmail = "ops@example.com";

    instances = {
      site-a = {
        domain      = "admin.site-a.example";
        repoUrl     = "git@github.com:org/site-a.git";
        adminPort   = 4001;
        previewPort = 4321;
        environmentFile = "/run/secrets/astroadmin-site-a.env";
        deployKeyFile   = "/run/secrets/astroadmin-site-a-deploykey";
      };

      # Add site-b / site-c the same way, with unique ports:
      # site-b = { domain = "admin.site-b.example"; repoUrl = "..."; adminPort = 4002; previewPort = 4322; ... };
      # site-c = { domain = "admin.site-c.example"; repoUrl = "..."; adminPort = 4003; previewPort = 4323; ... };
    };
  };
}
