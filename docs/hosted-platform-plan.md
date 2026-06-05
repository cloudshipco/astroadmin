# Hosted Platform Plan

This plan describes how AstroAdmin should evolve from a single-site Docker deployment into a hosted CMS platform for many Astro sites.

The core position is:

- Keep git-backed filesystem content as the source of truth.
- Do not run customer site code inside the control plane.
- Treat install, schema extraction, preview, and build as untrusted code execution.
- Run untrusted work in disposable, strongly isolated workers.
- Serve published sites from immutable static artifacts behind a CDN.

## Current Baseline

The current Docker deployment is a good self-hosted model for one trusted site:

- AstroAdmin edits a mounted checkout at `/site`.
- The preview server runs against the same checkout.
- A builder polls a second checkout, runs `npm ci` and `npm run build`, and copies `dist` behind nginx.
- Git is used for commits, push, rollback, and auditability.

That model does not scale cleanly to a hosted platform because every site would need long-lived clones, preview servers, build processes, deploy keys, and web routing. More importantly, Astro projects are executable code. A site can run code during dependency install, schema parsing, dev server startup, and production build.

## Threat Model

Assume the following can be malicious or compromised:

- Site repository contents.
- `package.json` scripts and dependencies.
- Astro config, content config, integrations, Vite plugins, and build-time code.
- Uploaded files, including SVGs.
- Editor accounts for a single tenant.
- Git provider credentials scoped to one site.

The platform must protect:

- Other tenants.
- Platform control-plane database and secrets.
- Git credentials for other sites.
- Artifact storage for other sites.
- Worker hosts.
- Published site routing.

The practical rule is that no customer repo code should execute in a process that has broad platform credentials, access to other tenants, or a shared writable filesystem.

## Isolation Recommendation

Use microVM isolation for untrusted site execution.

The safest target architecture is a short-lived microVM per untrusted job, or per active preview session. Firecracker-style microVMs are the natural fit because they combine hardware virtualization with startup and density characteristics closer to containers. Firecracker is designed for secure multi-tenant container/function workloads, and production Firecracker setups rely on KVM plus defense-in-depth such as jailer, seccomp, cgroups, chroot, and privilege dropping.

This should not normally mean one permanent microVM per site. A permanent VM per site is simpler to reason about, but it is expensive and leaves compromised dev servers alive for longer. The safer default is:

- MicroVM per schema extraction job.
- MicroVM per production or preview build job.
- MicroVM per active dev preview session only while an editor is using it.
- Static artifacts for everything published or idle.

Plain Docker containers are not enough as the main trust boundary for hostile site code. Recent kernel local privilege escalation issues, such as Copy Fail, are a reminder that container isolation still shares the host kernel. A container escape or kernel privilege escalation in a build worker could become a host compromise if the worker host is not aggressively hardened.

Recommended isolation tiers:

| Tier | Use | Isolation |
| --- | --- | --- |
| Control plane | Web app, API, billing, site metadata, auth | No customer code, standard containers are fine |
| Trusted self-hosted | Single customer running their own site | Current Docker Compose model |
| Hosted low-risk MVP | Internal/beta tenants only | Containers with gVisor/runsc, strict seccomp/AppArmor, no host secrets |
| Hosted production | Untrusted customer repos | MicroVM per build/schema job and per active dev preview session |

gVisor can be a useful intermediate hardening layer because it moves much of the Linux syscall surface into a userspace application kernel, reducing direct exposure to the host kernel. It is still not the same risk profile as a microVM. For a public hosted product running arbitrary Astro projects, microVMs should be the target.

## Platform Components

### 1. Control Plane

Responsibilities:

- Tenants, users, roles, and site ownership.
- Site metadata: domains, repo connection, branch, build command, framework settings.
- Git provider installation records.
- Publish state: active release id, latest successful build, latest failed build.
- Job queue and job history.
- Audit log for edits, commits, publishes, and credential use.

Rules:

- It never mounts a customer repository.
- It never imports customer code.
- It only holds encrypted credentials and issues short-lived scoped tokens to workers.

### 2. Content Service

Responsibilities:

- Generate forms from cached schema metadata.
- Apply edits to content files.
- Validate requested file paths against an allowlist derived from collection metadata.
- Commit and push changes to the site repo.
- Handle merge conflicts and publish locks.

Implementation model:

- For each edit or publish, acquire a per-site lock.
- Prepare an isolated workspace from the target branch.
- Apply content changes.
- Commit using a platform identity or mapped editor identity.
- Push back to the repo.
- Release the lock.

For early versions, this can run as a worker job rather than a long-lived service. The key is that the writable checkout is per-site and disposable.

### 3. Schema Extraction Worker

Schema extraction is untrusted execution because Astro content configs can import project code and dependencies.

Flow:

1. Start an isolated job for a specific repo commit.
2. Install dependencies using locked dependency policy.
3. Run schema extraction in the sandbox.
4. Return a normalized JSON schema artifact.
5. Cache schema metadata by site id and commit hash.
6. Destroy the sandbox.

The control plane should consume only the normalized schema output, never the site module directly.

### 4. Build Worker

Builds are untrusted execution.

Flow:

1. Receive `site_id`, `commit_sha`, and build config.
2. Start a clean microVM.
3. Fetch repo with a short-lived read token.
4. Restore dependency/build cache scoped to that site or content-addressed cache key.
5. Run install and build with CPU, memory, disk, process, and wall-clock limits.
6. Upload built static artifact to object storage under an immutable release id.
7. Emit build logs and metadata.
8. Destroy the microVM.

The worker should have no write access to platform state except through a narrow job-result API.

### 5. Preview System

There are two viable preview modes.

#### Mode A: Build Preview Artifacts

This is safest and simplest operationally.

Flow:

1. User edits content.
2. System writes a draft commit, temporary branch, or patch workspace.
3. Build worker produces a preview artifact.
4. Preview URL serves that artifact from object storage/CDN.

Pros:

- No long-running untrusted dev server.
- Same output path as production.
- Easy to cache and share.
- Easy to isolate.

Cons:

- Slower feedback loop unless builds are optimized.
- Less useful for live editing if full builds take too long.

Use this as the default production preview mode.

#### Mode B: On-Demand Dev Preview MicroVM

This gives the best editor experience for sites where builds are slow or live preview matters.

Flow:

1. User opens editor.
2. Start or resume a per-site preview microVM.
3. Mount or sync a working tree into the microVM.
4. Run the Astro dev server inside the microVM.
5. Route `preview-{session}.platform.test` to that microVM.
6. Apply edits by syncing file changes or using a small guest agent.
7. Stop the microVM after an idle timeout.

Pros:

- Fast live preview once warm.
- Closer to local Astro developer workflow.

Cons:

- More expensive.
- More moving parts: routing, lifecycle, logs, warm pools.
- Dev servers execute arbitrary code for longer than build jobs.

Use this as an optional tier for active editing sessions, with aggressive idle shutdown.

### 6. Static Hosting

Published sites should not be served from local `dist` volumes.

Flow:

1. Build worker uploads immutable artifact to object storage.
2. Release record points site + environment to artifact id.
3. Edge/CDN routes domains to active artifact.
4. Rollback changes the active release pointer.

Storage layout example:

```text
sites/{site_id}/releases/{release_id}/...
sites/{site_id}/previews/{preview_id}/...
```

This avoids per-site nginx containers and makes hundreds of sites mostly a routing and storage problem, not a process management problem.

## Git Model

Keep git, but make the platform explicit about how it uses git.

Recommended rules:

- Use GitHub App installations or equivalent provider apps rather than long-lived SSH keys where possible.
- Tokens must be short-lived and scoped to one repo.
- One publish/edit lock per site branch.
- All platform-authored commits include editor id, site id, and request id in metadata.
- Never store writable git credentials inside preview/build images.
- Prefer commit-based releases over mutable branch builds.

Content writes should stay constrained to known content and asset paths. If users need broader filesystem edits later, treat that as a developer workflow, not a CMS editor workflow.

## Caching Strategy

Fast previews and builds require caching, but cache boundaries matter.

Safe defaults:

- Dependency cache is scoped by site id and lockfile hash.
- Build cache is scoped by site id, commit hash, framework version, Node version, and environment.
- Never share writable caches across tenants.
- Content-addressed read-only caches can be shared only after careful design.
- Cache restore should not grant access to secrets.

Preview optimization ideas:

- Detect content-only changes and reuse dependency install.
- Prebuild schema metadata on repo webhook.
- Warm a small pool of generic Node/Astro microVM snapshots.
- Keep active preview microVMs warm only while an editor is present.
- Fall back to artifact preview when a dev preview session is idle or unavailable.

## Secrets and Network Policy

Build and preview jobs should receive only the secrets needed for that job.

Default policy:

- No platform database credentials in workers.
- No cross-tenant object storage credentials.
- Read-only repo token for builds.
- Write repo token only for content commit jobs.
- Outbound network restricted where possible.
- Block access to cloud instance metadata endpoints.
- Separate hosts or node pools for untrusted execution.
- Patch host kernel, guest kernel, microcode, Firecracker/gVisor/runtime aggressively.

Sites that need build-time environment variables should receive only that site’s configured variables, and those variables should be masked in logs.

## Routing

Use a central router instead of per-site nginx configs.

Responsibilities:

- Map custom domains to site ids.
- Terminate TLS.
- Serve active release artifacts.
- Route preview sessions to preview artifacts or active preview microVMs.
- Enforce admin/preview access policy.

Preview URLs should be unguessable and revocable. Production domains should only serve immutable artifacts selected by release records.

## Scaling Milestones

### Phase 0: Keep Self-Hosted Docker

Keep the current Docker solution as the self-hosted/single-site deployment path. Document it as trusted-code deployment, not hosted multi-tenant architecture.

### Phase 1: Hosted Control Plane Prototype

- Add site registry and per-site configuration.
- Add job table and queue.
- Move build/publish into worker jobs.
- Store artifacts in object storage.
- Serve published sites from artifact storage.
- Keep workers containerized only for trusted/internal tenants.

### Phase 2: Isolated Schema and Build Workers

- Stop importing site schema code in the admin process.
- Run schema extraction in a sandbox worker.
- Run production builds in sandbox workers.
- Add per-site locks.
- Add release records and rollback.
- Add webhook-triggered builds.

### Phase 3: Preview Architecture

- Implement artifact previews first.
- Add build acceleration and cache reuse.
- Add optional on-demand dev preview microVMs for active edit sessions.
- Add idle shutdown, logs, restart, and session routing.

### Phase 4: Production Isolation

- Move untrusted workers to microVMs.
- Separate untrusted worker hosts from control-plane hosts.
- Add strict network policy and metadata blocking.
- Add patch pipeline for host kernel, guest images, Firecracker/gVisor/runtime.
- Add abuse controls: rate limits, quotas, max build duration, max artifact size.

### Phase 5: Hundreds of Sites

- Domain router backed by release records.
- CDN cache invalidation by release id.
- Queue autoscaling by build backlog.
- Warm microVM snapshots for common Node/Astro images.
- Observability per site, job, release, and tenant.
- Disaster recovery for repo credentials, artifacts, and metadata.

## Open Decisions

- Whether hosted editing creates commits directly on the main branch, a draft branch, or a platform-managed content branch.
- Whether preview uses temporary commits, patch files, or a draft workspace.
- Whether schema extraction can be made static enough to avoid executing most site code.
- Whether to operate Firecracker directly, use a managed microVM platform, or use Kubernetes with a microVM runtime.
- How much arbitrary project configuration to allow in build commands.
- Whether SVG upload is allowed by default, sanitized, or disabled for non-developer editors.

## Initial Recommendation

Build the hosted version around artifact previews first and microVM-isolated build/schema jobs. Add on-demand dev preview microVMs after the artifact pipeline works.

This gives a safe base:

- Public production hosting is just static artifacts.
- Most untrusted code execution is short-lived.
- The control plane never runs customer code.
- Git remains the durable, user-owned source of truth.
- Live preview can be added as a premium/advanced capability without compromising the core architecture.

## References

- Firecracker project: https://github.com/firecracker-microvm/firecracker
- Firecracker production host setup recommendations: https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md
- Firecracker jailer documentation: https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md
- gVisor overview: https://gvisor.dev/docs/
- gVisor security model: https://gvisor.dev/docs/architecture_guide/security/
- Cloudflare Workers security model: https://developers.cloudflare.com/workers/reference/security-model/
- Copy Fail overview: https://en.wikipedia.org/wiki/Copy_Fail
