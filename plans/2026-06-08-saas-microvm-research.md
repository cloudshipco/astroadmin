# SaaS isolation substrate research — microVMs, gVisor, and NixOS

**Date:** 2026-06-08
**Author:** research pass (web)
**Scope:** Recommend an isolation substrate and a realistic phased path for running
**untrusted tenant Astro/Node builds** on the operator's own infrastructure, for the
SaaS phase of AstroAdmin. Operator profile: solo dev, very comfortable with NixOS, runs
NixOS hosts, has **never used Firecracker**.

> Context: this feeds the SaaS-phase target in
> `plans/2026-06-08-hosted-platform-near-term-architecture.md` and
> `docs/hosted-platform-plan.md`. Those docs already lock the boundary
> (untrusted builds never share an execution context with platform write
> credentials) and a tiered isolation roadmap (container → gVisor → microVM). This
> briefing pressure-tests that roadmap against current (2025–2026) reality and names
> concrete tools.

---

## Executive summary / recommendation

**The roadmap in the existing architecture docs is correct and matches industry
practice. Keep it. This research firms up the tool choices and flags two updates.**

1. **Production end-state: Firecracker microVMs.** Hardware-virtualization (KVM) per
   job is the current consensus gold standard for adversarial multi-tenant code, and it
   is exactly what Fly.io uses to safely run arbitrary customer (and LLM-generated) code
   on shared hardware. For a NixOS operator, **`microvm.nix`** is the right way to run
   it: it builds NixOS guest images declaratively, runs each microVM as a systemd
   service, and supports Firecracker (plus Cloud Hypervisor / QEMU) behind one config
   surface. It is real and used in production-ish settings, but it is a hands-on,
   solo-maintained ecosystem — budget a spike, not a weekend.

2. **First hardening step beyond plain containers: gVisor (`runsc`).** This is the
   pragmatic, low-effort intermediate. It is an OCI runtime — drop it under
   containerd/Docker as a `runtimeClassName`/`--runtime` swap, no VM lifecycle to manage,
   packaged in nixpkgs. It is *weaker* than a microVM (userspace kernel, software-
   enforced, has had its own escapes) so it is "defense in depth," **not** the
   end-state for actively hostile tenants. Use it as the gate the moment the first
   untrusted repo builds, while Firecracker is being stood up.

3. **Two updates to the existing plan worth noting:**
   - **Consider Cloud Hypervisor as a serious alternative to Firecracker**, not just a
     fallback. `microvm.nix` supports both with near-identical config; CLH has a richer
     device model (virtiofs/9p shares that Firecracker lacks) which materially helps the
     **cache-restore / `/nix/store` sharing** problem that build jobs hit. Firecracker
     wins on minimal attack surface, snapshot maturity, and proven scale; CLH wins on
     dev ergonomics for exactly this build-cache use case. **Spike both.**
   - **Managed offload (Fly.io Machines API, or its new `sprites.dev`) is a legitimate
     way to skip self-hosting Firecracker entirely** for the untrusted-build layer while
     keeping your own control plane. For a solo operator this is very likely the right
     *first* production isolation — it removes the entire host-hardening / kernel-patch /
     jailer-CVE burden. Self-hosting `microvm.nix` becomes a cost-optimization or
     control/lock-in decision you make *later, with revenue*, not a prerequisite to launch.

**Recommended phased path (named tools):**

| Phase | Trigger | Substrate | Notes |
|---|---|---|---|
| 0 (now) | First-party / trusted only | Plain container or `systemd-nspawn` on a worker host with **no platform secrets** | Process separation, **not** a security boundary. Gate: never builds an untrusted repo. |
| 1 | First **untrusted** repo build (incl. beta) | **gVisor `runsc`** under containerd, strict seccomp, no host secrets, blocked metadata endpoint, separate node | Low effort, nixpkgs-packaged. Defense-in-depth, interim. |
| 2 (production, recommended first form) | Public untrusted Astro hosting, low ops appetite | **Fly.io Machines API** (managed Firecracker) as the build-execution backend; your control plane stays self-hosted | Offloads isolation + kernel patching. Per-second billing, scale-to-zero. Lock-in is moderate (OCI in, REST API out). |
| 2′ (production, self-hosted end-state) | Scale/margin/control demands it | **`microvm.nix` + Firecracker** (and/or **Cloud Hypervisor**) on a dedicated NixOS untrusted-worker host, with jailer, seccomp, snapshot warm-pool | The "own the substrate" option. Highest control, highest ops burden, requires aggressive kernel/microcode/VMM patching (see 2026 jailer CVE below). |

The key unknowns that justify a hands-on spike before committing self-hosted: warm-pool
boot latency for an Astro build, `/nix/store` + npm cache restore strategy into the
guest, and the real ops cost of the patch treadmill. Details in **Open questions** below.

---

## 1. What Fly.io and Railway actually use

### Fly.io — confirmed: Firecracker microVMs ("Fly Machines")

This is well-sourced from Fly's own docs/blog:

- **Application code runs in Firecracker microVMs.** Fly Machines are
  hardware-virtualized "containers" built from standard **OCI images** — "if your Docker
  or K8s runs it, so will Fly.io." Firecracker is a Rust VMM on Linux **KVM**, exposing a
  minimal device model (no USB/PCI/BIOS/legacy devices) to shrink both attack surface and
  per-VM memory footprint. It is the same microVM tech that backs **AWS Lambda**.
  (Fly architecture / Firecracker learn pages.)
- **Isolation model:** strong hardware-virtualization isolation lets Fly run different
  customers' apps on shared physical hosts; Fly makes a best-effort to dedicate a CPU
  core to a single microVM at a time (avoid steal/contention).
- **Machines API + orchestration:** a REST/JSON API. To create a machine, the control
  layer broadcasts a **NATS** message to hosts in the target region ("reserve me a
  machine with these specs"); hosts reply with offers; the API picks one and tells that
  host (`flyd`) to create the machine. Boot is **~300ms** for a cold "boot me a VM"
  (cross-region API latency included).
- **Lifecycle / scale-to-zero:** `stop` shuts a machine down without destroying it;
  `start` boots it again. **`suspend`/`resume`** uses **Firecracker snapshots** to capture
  full VM state (CPU registers, memory, file handles) so the next start can resume from
  snapshot instead of cold-booting — sub-second. With proxy autostop/autostart you pay
  **no CPU/RAM** while stopped or suspended (only rootfs storage).
- **Untrusted-code positioning (vendor's own words):** Fly markets Machines as "a safe
  execution sandbox for even the sketchiest user-generated (or LLM-generated) code,"
  citing kernel isolation via Firecracker, restricted network, controlled runtimes. In
  **Jan 2026** Fly launched **`sprites.dev`** — persistent Firecracker microVMs (100GB
  NVMe) aimed squarely at the AI-agent / code-sandbox market. (Confirms Fly actively
  sells microVM isolation as a sandbox primitive, relevant to Q4.)

> Takeaway: Fly is a working, public proof of exactly the architecture the AstroAdmin
> plan targets — per-job Firecracker microVMs from OCI images, snapshot-based warm
> resume, scale-to-zero billing.

### Railway — confirmed: standard Linux containers (NOT microVMs/gVisor)

- Every Railway service is a **standard Linux container**: you give source or a Docker
  image, Railway builds an **OCI image** and deploys it onto managed infra (reported as
  GCP VMs with Kubernetes-like orchestration), with traffic routed via Cloudflare.
- **Isolation is standard containers — shared host kernel.** Multiple independent
  write-ups are explicit that Railway is *not* microVM- or gVisor-based, and that a
  kernel exploit in hostile code could in principle escape the container. Railway is not
  built as a session-scoped untrusted-sandbox platform (slow cold starts for that
  pattern, no sandbox SDK).

> Takeaway: Railway is **not** a model for untrusted multi-tenant isolation. It assumes
> the deployed code is the customer's *own* code in their *own* project boundary — a
> trust posture closer to AstroAdmin's *near-term* "first-party code" phase than its
> SaaS untrusted-build phase. Do not cite Railway as evidence that "containers are
> enough" for the untrusted phase.

**Sourcing note / staleness:** Railway does not publish a detailed isolation
architecture page the way Fly does; the "standard containers" claim is corroborated
across several 2026 third-party analyses but not from a single Railway primary doc. If
this distinction becomes load-bearing, confirm directly with Railway. Fly's claims are
all from Fly's own docs/blog and are high-confidence.

---

## 2. Firecracker on NixOS — maturity and how you actually run it

### `microvm.nix` — the NixOS-native answer

`microvm.nix` (github.com/microvm-nix/microvm.nix, originally `astro/microvm.nix`) is a
Nix flake to define and run lightweight NixOS microVMs. It is the obvious fit for this
operator. Key facts (from the project README/docs and Cyberus Technology's write-up):

- **Hypervisor choice (8 backends):** QEMU, **Cloud Hypervisor**, **Firecracker**,
  crosvm, kvmtool, stratovirt, alioth, and vfkit (macOS). You pick per-microVM. This
  matters: you can prototype on QEMU, harden on Firecracker/CLH, behind one config.
- **Declarative guest images via Nix:** the guest is a NixOS config; its root FS is a
  **read-only erofs (faster) or squashfs (smaller)** image containing *only* the closure
  the guest needs. `/nix/store` can be isolated to exactly the guest's requirements, or
  the host store shared in. Writable state via overlays, block devices, 9p, or virtiofs.
  This is the reproducibility win — the guest image is a pure Nix derivation.
- **Runs as declarative systemd services** on the host (or imperatively via a `microvm`
  command, or like a Nix package via `nix run microvm#firecracker-example`). Fits a
  NixOS host's configuration directly — no external orchestrator required.
- **Networking:** zero or more **tap** interfaces per microVM; you bridge/route them on
  the host yourself (standard tap+bridge). **vhost-net** acceleration is supported for
  throughput (QEMU ~1.5→~10 Gbps). vfkit (macOS) has no tap/bridge — Linux host required
  for real networking. So on a NixOS server: tap devices + a host bridge + your firewall
  rules; this is manual but well-trodden.
- **Shares caveat (important for builds):** **Firecracker and Cloud Hypervisor lack
  9p/virtiofs share support in microvm.nix.** That is the device that makes
  host→guest file sharing (e.g. an npm/`/nix/store` cache) easy. QEMU/CLH have richer
  device models. (Reports here are slightly inconsistent: the hypervisor-restrictions
  table flags both Firecracker and CLH as lacking 9p/virtiofs, while CLH upstream does
  support virtiofs — **verify in a spike** which share mechanisms actually work per
  backend in the current microvm.nix release.) This pushes cache-restore toward
  **block-device images or a writable store overlay** rather than live shares.
- **Jailer / seccomp:** these are **Firecracker's own** defense-in-depth, not invented by
  microvm.nix. The **jailer** wraps the VMM in chroot + PID/net namespaces + cgroups +
  privilege drop + a `--resource-limit` fd/file-size cap; each Firecracker thread (API,
  VMM, vCPU) runs under a **custom BPF seccomp filter**; KVM provides the hardware
  boundary. You must wire the jailer in for any real multi-tenant deployment — confirm
  microvm.nix's current jailer integration in the spike (it exposes a configurable
  firecracker package + extra-args, and a NixOS "hardened profile" toggles some
  defaults).
- **Snapshotting:** Firecracker has first-class full snapshots (all CPU
  micro-architectures); diff snapshots are still developer-preview pending `guest_memfd`
  work. This is the primitive behind warm pools / fast resume (same one Fly uses for
  suspend/resume). microvm.nix exposes Firecracker config but verify the snapshot
  workflow you want (warm-pool restore) is reachable through it vs. driving Firecracker
  directly.
- **Boot times:** Firecracker boots in the **~100–200ms** range (config-dependent);
  industry numbers put Firecracker fastest among VM options. microvm.nix doesn't change
  the VMM's boot characteristics; your image size and init do.

### Maturity assessment

- **Production-viable, with caveats.** microvm.nix is actively maintained, has a
  changelog, real adopters, and a commercial backer-adjacent ecosystem (Cyberus
  Technology promotes/supports it and offers NixOS LTS). The README makes **no explicit
  stability/production guarantee** — treat it as a capable, community/solo-maintained
  project, not a vendor-SLA product. For a NixOS-comfortable solo dev this is a good
  fit; for a team wanting a supported product it is thinner than a managed offering.
- **nixpkgs packaging:** Firecracker, Cloud Hypervisor, QEMU, and **gVisor (`runsc`,
  with `containerd-shim-runsc-v1`)** are all packaged in nixpkgs. (Could not pin exact
  current version numbers from search; verify with `nix search nixpkgs firecracker` /
  `gvisor` on the target channel. The NixOS Discourse "Firecracker or Kata on NixOS"
  thread is the community reference.)
- **Fresh risk signal (2026):** **CVE-2026-1386 — arbitrary host file overwrite via
  symlink in the Firecracker jailer** (AWS security bulletin). This is exactly the class
  of risk self-hosting carries: the jailer (your *defense* layer) itself needs patching.
  It is a concrete argument for either (a) the managed-offload route, or (b) a disciplined
  patch pipeline if self-hosting. Verify your Firecracker/jailer version is patched.

---

## 3. Alternatives and tradeoffs for untrusted Node/Astro builds

Consensus from multiple 2025–2026 comparisons (Northflank, Edera, emirb.github.io "State
of MicroVM Isolation in 2026", onidel, gVisor's own docs):

| Dimension | **Firecracker** | **Cloud Hypervisor** | **Kata Containers** | **gVisor (`runsc`)** |
|---|---|---|---|---|
| Isolation mechanism | KVM hardware virt, minimal device model | KVM hardware virt, richer device model | KVM hardware virt via a pluggable VMM (can *use* Firecracker/CLH/QEMU) + K8s/OCI integration | Userspace "application kernel" (Sentry) intercepting syscalls; **no hardware VM** |
| Isolation strength (untrusted/adversarial) | **Strongest tier** (gold standard) | **Strongest tier** | **Strongest tier** (inherits its VMM) | **Moderate** — software-enforced; bugs in Sentry are exploitable; documented escapes exist |
| Boot latency | ~100–200ms (fastest) | ~150–250ms (close) | ~150–300ms (orchestration overhead) | **milliseconds** (no VM boot) |
| Density / overhead | Very low per-VM memory; near-native CPU/IO | Low; near-native | Low–moderate (+ agent/orchestration) | Lowest memory; **but I/O & syscall-heavy workloads 10–30% slower** (hurts `npm ci`/build IO) |
| Snapshot / warm pool | **Mature full snapshots** (warm resume) | Snapshot support, less battle-tested | Via underlying VMM | No VM snapshot; restart is already cheap |
| Networking | tap/bridge you manage; minimal model | tap/bridge; richer | CNI-integrated (K8s-native) | Inherits container netns; netstack in userspace |
| File sharing (build cache!) | **No virtiofs/9p in microvm.nix** → block-device/overlay only | virtiofs/9p (richer) — **verify in microvm.nix** | virtiofs typical | Normal container mounts (easy) |
| Operational complexity (NixOS solo dev) | Medium-high: tap/bridge, jailer, snapshots, kernel/microcode/VMM patch treadmill | Medium-high (similar) | **High** — really wants Kubernetes; heavy for a solo dev | **Low** — OCI runtime swap; nixpkgs-packaged; no VM lifecycle |
| Fit on a plain NixOS host (no K8s) | **Good** (microvm.nix) | **Good** (microvm.nix) | **Poor** (K8s-shaped) | **Good** (containerd runtimeclass) |

**Reading the table for this operator:**

- **Kata Containers is the wrong shape.** It is an orchestration framework that plugs
  VMMs into Kubernetes. The isolation strength is identical to Firecracker (it can *be*
  Firecracker underneath), but it imports a Kubernetes dependency this solo/NixOS,
  non-K8s control plane doesn't have. Skip unless you adopt K8s anyway.
- **gVisor is the right *first hardening step*, and explicitly not the end-state.** It is
  a syscall-sandbox, not a VM; a Sentry bug is a host risk, and it does not give you
  multi-job isolation within one sandbox. Its I/O overhead is a real (if modest) tax on
  build-heavy workloads. But the operational cost is near-zero (OCI runtime swap), it's
  in nixpkgs, and it meaningfully shrinks the host-kernel attack surface vs a plain
  container. Use it as the interim gate for the first untrusted builds.
- **Firecracker vs Cloud Hypervisor is the real end-state decision.** Same isolation
  tier. Firecracker = minimal attack surface, mature snapshots, proven at Lambda/Fly
  scale, the default. Cloud Hypervisor = richer device model (notably virtiofs), which
  directly eases the build-cache/store-sharing problem. **Prototype both in microvm.nix**;
  let the cache-restore ergonomics and snapshot/warm-pool behavior decide.

**Pragmatic first hardening step beyond plain containers:** **gVisor `runsc`.**
**Production end-state:** **per-job Firecracker microVM** (or Cloud Hypervisor), warm
pool from snapshots.

---

## 4. Managed vs self-hosted — offload isolation to Fly?

**Yes, this is viable and probably the right first production form for a solo operator.**
The architecture cleanly separates: *control plane* (site registry, auth, content-commit,
release records — your code, your NixOS host) vs *untrusted build execution* (the thing
that needs isolation). You can keep the former and rent the latter.

**Fly.io Machines API as the untrusted-build backend:**

- **What you'd do:** package the build job as an **OCI image** (npm ci + astro build +
  artifact egress to your object storage). Your control plane calls the Machines API to
  create an **ephemeral** machine per build (hundreds of ms to boot), passes a
  short-lived read-only repo token, streams logs/result back through your narrow
  job-result API, then destroys/stops the machine. This is precisely the pattern Fly
  documents (per-user dev environments, ephemeral sandboxes) and now sells via
  `sprites.dev`.
- **Pros:**
  - Firecracker-grade isolation **without** you owning tap/bridge, jailer, seccomp,
    snapshots, or the **kernel/microcode/VMM patch treadmill** (cf. CVE-2026-1386 — that
    becomes Fly's problem).
  - **Per-second billing, scale-to-zero:** a shared-CPU 256MB machine is ~$0.0027/hr;
    you pay only while building; stopped/suspended machines cost only rootfs storage
    ($0.15/GB-month). Build workloads are bursty → cost shape is excellent (pay per
    build-minute, near-zero idle).
    *(2025–2026: Fly moved to pure pay-as-you-go; reserved compute gives ~40% off for
    committed capacity if volume grows.)*
  - Proven untrusted-code posture (Fly explicitly supports "sketchy/LLM-generated code").
  - Regions/edge if you later want geo-distributed builds.
- **Cons / lock-in:**
  - **Dependency on a third party** for a core security boundary — their incidents,
    pricing changes, region availability become yours.
  - **Lock-in is moderate, not severe:** inputs are standard **OCI images**, the
    interface is a **REST API**. Porting to self-hosted `microvm.nix` later means
    re-implementing machine lifecycle/networking/log-streaming against the same
    `WorkerRuntime` contract the plan already mandates — non-trivial but bounded (the
    plan already says runtime swaps are real work, not a config flip).
  - Egress/data-residency and "who can see tenant source during build" become a
    third-party trust question for your customers.
  - Less control over snapshot/warm-pool tuning and kernel specifics than self-hosting.
- **Alternatives in the same managed niche** (for comparison, all Firecracker/microVM
  sandbox-as-a-service): **E2B**, **Northflank** sandboxes, Fly **`sprites.dev`**. These
  optimize for the AI-code-sandbox use case and could equally back a build worker.

**Recommendation for Q4:** Use managed Firecracker (Fly Machines) as **production
isolation v1**. It collapses the hardest, most security-sensitive operational burden
(host hardening + patch pipeline) onto a vendor whose entire business is doing it well,
and the cost shape suits bursty builds. Keep the `WorkerRuntime` boundary clean so
**self-hosting `microvm.nix` is a later cost/control optimization**, not a launch
blocker. Self-host when (a) build volume makes Fly's margin material, (b) data-residency
/ trust requirements demand it, or (c) you want control over warm-pool/snapshot tuning.

---

## 5. Concrete recommendation for THIS operator

A NixOS-comfortable solo dev building toward untrusted multi-tenant Astro builds. The
existing plan's container→gVisor→microVM tiering is right; here is the named, phased path
with the managed-offload option folded in.

**Phase 0 — now (trusted only).**
Plain **container** (podman/Docker) or **`systemd-nspawn`** on a worker host that holds
**no platform secrets**, behind the `WorkerRuntime` contract. This is process separation,
**not** a security boundary. **Hard gate: it must never build an untrusted/third-party
repo.** (Already the plan's position — preserve it.)

**Phase 1 — first untrusted repo build (the first real hardening step).**
**gVisor `runsc`** under containerd on a *separate* untrusted-worker node: strict seccomp,
no host/platform secrets, blocked cloud-metadata endpoint, read-only short-lived repo
token only, outbound network restricted. nixpkgs-packaged (`gvisor` +
`containerd-shim-runsc-v1`); a `RuntimeClass`/`--runtime` swap, not a new VM stack.
Accept the I/O overhead and the "software-enforced, not hardware" caveat — it's the
interim, not the destination.

**Phase 2 — production isolation, recommended first form: managed Firecracker.**
Run untrusted builds on **Fly.io Machines API** (ephemeral OCI machine per build), control
plane stays on your NixOS host. Offloads host hardening + the kernel/jailer/VMM patch
treadmill; per-second billing fits bursty builds; isolation is real Firecracker. This is
the lowest-risk way for a solo operator to reach a defensible untrusted-multi-tenant
posture. *(Evaluate E2B / Northflank / Fly `sprites.dev` as equivalents.)*

**Phase 2′ — self-hosted end-state (when control/scale/margin demand it).**
**`microvm.nix` + Firecracker** (prototype **Cloud Hypervisor** in parallel) on a
dedicated NixOS untrusted-worker host, separate from the control plane:
- guest = a pure-Nix NixOS image (erofs root, minimal closure);
- jailer + seccomp + cgroups wired in; KVM boundary;
- tap devices + host bridge + firewall; block metadata endpoints;
- **snapshot-based warm pool** of a generic Node/Astro guest for sub-second build start;
- build cache via block-device/overlay (or virtiofs if CLH path proves it);
- aggressive **patch pipeline**: host kernel, guest kernel, microcode,
  Firecracker/jailer (cf. **CVE-2026-1386**).

Same `WorkerRuntime` contract throughout, so 2→2′ is a backend swap, not a redesign.

### Specific tools / versions to pin in the spike
- `microvm.nix` (microvm-nix/microvm.nix), current `main`/release — check CHANGELOG.
- Firecracker + jailer — **patched against CVE-2026-1386** (verify version on your channel).
- Cloud Hypervisor — current nixpkgs.
- gVisor `runsc` + `containerd-shim-runsc-v1` — current nixpkgs.
- Fly.io Machines API (managed option) — and note `sprites.dev` (launched Jan 2026).

---

## Open questions / spike needed

1. **Build-cache strategy into the guest.** Firecracker (and possibly CLH) lack
   9p/virtiofs shares in microvm.nix → how do npm cache and `/nix/store` reuse get into
   the microVM? Block-device image vs writable store overlay vs CLH+virtiofs. **Verify
   which share mechanisms actually work per backend in the current microvm.nix release**
   (sources conflicted on CLH virtiofs). This is the single biggest ergonomics unknown.
2. **Warm-pool boot latency for a real Astro build.** Measure cold boot + `npm ci` +
   `astro build` vs snapshot-resume warm start, for both self-hosted Firecracker and Fly
   Machines. Confirms whether snapshots are worth the complexity for build (vs interactive
   preview) workloads.
3. **microvm.nix jailer integration depth.** Confirm the project wires jailer
   (chroot/namespaces/cgroups/seccomp/`--resource-limit`) by default or whether you must
   drive Firecracker's jailer yourself. Security-critical for multi-tenant.
4. **Snapshot reachability via microvm.nix** vs driving Firecracker directly for the
   warm-pool workflow you want.
5. **Networking/egress policy** on a NixOS host: tap+bridge + firewall to block
   cloud-metadata endpoints, restrict outbound, per-job netns. Straightforward but must
   be got right for untrusted code.
6. **Patch-pipeline cost (self-hosted).** Realistic ongoing effort to keep host kernel,
   guest kernel, microcode, Firecracker/jailer patched. CVE-2026-1386 shows the *defense*
   layer itself needs patching. This is the main argument for the managed route — quantify
   it before choosing 2 vs 2′.
7. **Railway isolation confirmation.** "Standard containers" is corroborated by multiple
   2026 third-party analyses but not a single Railway primary doc — confirm with Railway
   if the comparison ever becomes load-bearing.
8. **Cloud Hypervisor vs Firecracker decision.** Resolve in the spike on the basis of
   cache ergonomics (virtiofs) vs attack-surface/snapshot-maturity. Don't assume
   Firecracker by default just because Fly uses it.
9. **Schema extraction = untrusted execution too.** The plan already flags this: zod-form
   generation imports the site's schema code. It needs the **same** isolation tier as the
   build worker — fold it into whichever substrate you pick; it is not a separate, lighter
   problem.

---

## References (accessed 2026-06-08)

**Fly.io (primary):**
- The Fly.io Architecture — https://fly.io/docs/reference/architecture/
- What Is a Firecracker VM? — https://fly.io/learn/firecracker-vm/
- Fly Machines: an API for fast-booting VMs (blog) — https://fly.io/blog/fly-machines/
- Machine Suspend and Resume — https://fly.io/docs/reference/suspend-resume/
- Autostop/autostart Machines — https://fly.io/docs/launch/autostop-autostart/
- Machines API resource — https://fly.io/docs/machines/api/machines-resource/
- Per-User Dev Environments with Fly Machines — https://fly.io/docs/blueprints/per-user-dev-environments/
- Virtual Sandbox (Learn) — https://fly.io/learn/virtual-sandbox/
- Fly.io Resource Pricing — https://fly.io/docs/about/pricing/
- sprites.dev launch coverage — https://simonwillison.net/2026/Jan/9/sprites-dev/

**Railway / isolation comparisons:**
- Morph — Railway Containers (2026) — https://www.morphllm.com/railway-containers
- Northflank — Kata vs Firecracker vs gVisor — https://northflank.com/blog/kata-containers-vs-firecracker-vs-gvisor
- Northflank — Firecracker vs gVisor — https://northflank.com/blog/firecracker-vs-gvisor
- Northflank — Your containers aren't isolated — https://northflank.com/blog/your-containers-arent-isolated-heres-why-thats-a-problem-micro-vms-vmms-and-container-isolation
- Edera — Kata vs Firecracker vs gVisor — https://edera.dev/stories/kata-vs-firecracker-vs-gvisor-isolation-compared
- emirb — Your Container Is Not a Sandbox: State of MicroVM Isolation in 2026 — https://emirb.github.io/blog/microvm-2026/
- onidel — gVisor vs Kata vs Firecracker on VPS (2025) — https://onidel.com/blog/gvisor-kata-firecracker-2025

**microvm.nix / NixOS:**
- microvm.nix repo/README — https://github.com/microvm-nix/microvm.nix
- microvm.nix options reference — https://microvm-nix.github.io/microvm.nix/microvm-options.html
- microvm.nix intro — https://microvm-nix.github.io/microvm.nix/
- Cyberus Technology — microvm.nix: Declarative Virtualization for NixOS — https://cyberus-technology.de/en/articles/microvm-nix/
- kraftnix — What is microvm.nix and why you should use it — https://kraftnix.dev/blog/why-you-should-use-microvm-nix/
- NixOS Discourse — Firecracker or Kata on NixOS — https://discourse.nixos.org/t/firecracker-or-kata-on-nixos/11169

**Firecracker / gVisor (primary):**
- Firecracker jailer docs — https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md
- Firecracker prod-host-setup — https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md
- Firecracker snapshot support — https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
- Firecracker design — https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md
- AWS security bulletin — CVE-2026-1386 (Firecracker jailer symlink host-file overwrite) — https://aws.amazon.com/security/security-bulletins/rss/2026-003-aws/
- gVisor security model — https://gvisor.dev/docs/architecture_guide/security/
- gVisor security reporting — https://gvisor.dev/security/
- gVisor containerd quick start — https://gvisor.dev/docs/user_guide/containerd/quick_start/
- gvisor in nixpkgs (init PR) — https://github.com/NixOS/nixpkgs/pull/50218

**Staleness note:** This space moves fast. Fly's docs are current and authoritative for
Fly. The comparison blogs are 2025–2026 and broadly agree on the isolation tiering, but
boot-latency/overhead numbers are indicative, not benchmarks for *your* Astro build —
measure in the spike. CVE-2026-1386 is recent; confirm your Firecracker/jailer build is
patched. Railway's "standard containers" rests on third-party analysis, not a Railway
primary source.
