---
skill: chant-k8s-flux
description: Flux CD composites for GitOps reconciliation — FluxGitSource + FluxAppFor, the one-source-many-apps shape, dependsOn ordering, the FLUX rules, and the flux-reconcile deploy step
user-invocable: true
---

# Flux CD Composites

Chant authors typed infrastructure into manifests. Flux continuously reconciles those manifests into a cluster from git. These composites are the opt-in bridge — the k8s lexicon itself stays runtime-agnostic and only emits YAML; nothing here is implied unless you reach for it.

## The split

| Layer | Owns | In Chant |
|---|---|---|
| **Chant** | Authoring typed infra → manifests, committed to git | the lexicons |
| **Flux** | Continuously reconciling those manifests (source-controller fetches, kustomize-controller applies) | `FluxGitSource` / `FluxAppFor` |
| **Chant again** | Reading convergence back | `flux-reconcile` deploy step, `chant components status --live` |

Flux never learns Chant exists — it fetches a git path and applies what it finds there. Chant's job ends at emitting the manifests and the Flux CRs that point at them.

## Prerequisites

The Flux controllers must be installed in the target cluster before applying any Flux CRs:

```bash
kubectl apply -f https://github.com/fluxcd/flux2/releases/download/v2.9.1/install.yaml
kubectl -n flux-system wait deploy --all --for=condition=Available --timeout=180s
```

(Or `flux install` / `flux bootstrap` with the Flux CLI. `flux bootstrap` also creates a `flux-system` `GitRepository` — FLUX002 knows about it, see below.)

## When to use which

| Composite | Use case |
|---|---|
| `FluxGitSource` | Declare the git repo the source-controller fetches — **once per repo** |
| `FluxAppFor` | One `Kustomization` reconciling one path out of a declared source — once per app |

---

## FluxGitSource — declare the repo once

```typescript
import { FluxGitSource } from "@intentius/chant-lexicon-k8s";

export const source = FluxGitSource("home-chant", {
  url: "https://github.com/jhgaylor/home-chant",
  branch: "main",
});
```

`FluxGitSource(name, options)` returns `{ gitRepository }` — a single `K8s::Flux::GitRepository` in `flux-system`. Options:

- **`url`** (required) — the repo the source-controller fetches.
- **`branch`** — defaults to `"main"`. **`tag`** pins a tag instead and wins over `branch`.
- **`interval`** — fetch interval, default `"5m"`.
- **`secretRef`** — name of the Secret holding git credentials, for private repos.
- **`fluxNamespace`** — where the CR lives, default `"flux-system"`.

> **FLUX001** — a hand-written `GitRepository` whose spec has a `url` but no `ref` is flagged: an unset `spec.ref` falls back to the `master` branch, which on most repos no longer exists, so the source stalls with a checkout error and every Kustomization downstream stalls too. `FluxGitSource` always emits a `ref` (branch or tag), so composite output is FLUX001-clean by construction.

## FluxAppFor — one Kustomization per app

```typescript
import { FluxAppFor } from "@intentius/chant-lexicon-k8s";

export const hello = FluxAppFor("hello-chant", {
  source,                          // the FluxGitSource result above
  path: "./apps/hello-chant/k8s",
  targetNamespace: "default",
  dependsOn: ["cert-manager", "traefik"],
});
```

`FluxAppFor(target, options)` returns `{ kustomization }` — a single `K8s::Flux::Kustomization`. Defaults are taken from real Flux estates, not the docs:

- **`interval`** — `"10m"` (the source polls at 5m; reconcile less often than you fetch).
- **`prune: true`** — resources that disappear from the source are deleted.
- **`wait: true`** — the Kustomization reports Ready only when the reconciled resources are ready.
- **`targetNamespace`** — optional; sets `spec.targetNamespace` (kustomize-controller stamps it on every reconciled resource).
- **`timeout`**, **`suspend`**, **`serviceAccountName`** — pass-throughs for the matching spec fields.

### The source option

`source` accepts three shapes:

```typescript
FluxAppFor("app", { source,                         path: "./apps/app" });  // FluxGitSource result
FluxAppFor("app", { source: "flux-system",           path: "./apps/app" });  // name of an existing GitRepository
FluxAppFor("app", { source: { kind: "OCIRepository", name: "images" }, path: "./apps/app" });  // explicit ref
```

The first is the normal case. The second targets a source declared elsewhere — typically the bootstrap-created `flux-system` repo. The third covers `OCIRepository` / `Bucket` sources.

> **FLUX002** — every `Kustomization.spec.sourceRef` must name a source the build declares (`GitRepository`, `OCIRepository`, or `Bucket`), or the kustomize-controller waits forever on an artifact that never arrives. The bootstrap-created `flux-system` `GitRepository` is exempt — it always exists on a bootstrapped cluster, the Flux analogue of ARGO002's built-in `default` project.

### One source, many apps

The common estate shape is **one `GitRepository` shared by many `Kustomization`s** — a multi-app repo with one Kustomization per path. A `GitRepository` per app is the mistake the composite split makes hard: declare the source once, hand its result to every `FluxAppFor`.

```typescript
const source = FluxGitSource("infra", { url: "https://github.com/acme/infra" });

export const platform = FluxAppFor("platform", { source, path: "./dist/platform" });
export const api      = FluxAppFor("api",      { source, path: "./dist/apps/api", dependsOn: ["platform"] });
export const web      = FluxAppFor("web",      { source, path: "./dist/apps/web", dependsOn: ["platform", "api"] });
```

### dependsOn — ordering as a validated name list

`dependsOn` is a plain string list rendered to `spec.dependsOn`; the Kustomization stays pending until every named Kustomization is Ready. In raw YAML those names have no referential integrity — a typo, or an entry left behind after a rename, stalls the app silently.

> **FLUX003** — every `dependsOn` entry is joined against the Kustomizations the build actually declares. An entry naming nothing is a warning (not an error — estates legitimately split infra and apps across repos, so `cert-manager` may be declared by a build this one never sees). A self-referencing entry is always flagged: Flux can never satisfy it.

---

## Deploying — the flux-reconcile step

Applying `dist/flux.yaml` with `kubectl` works. For the component model, `fluxReconcile` is the typed deploy leaf (the sibling of `argo-app`):

```typescript
import { phase, type Component } from "@intentius/chant/components/component";
import { fluxReconcile } from "@intentius/chant-lexicon-k8s/components";

export const bootstrap: Component = {
  name: "flux-bootstrap",
  archetype: "service",
  dependsOn: [],
  deploy: [
    phase("Reconcile", [
      fluxReconcile({
        manifest: "dist/flux.yaml",
        stack: "my-estate",
        noRollback: "server-side apply keeps no previous object state; the declared source is the restore path",
      }),
    ]),
  ],
};
```

What it does:

1. **Applies** the Flux CRs through the same server-side apply `kubectl-apply` uses — ownership stamping, marker-scoped prune, stack labels all identical.
2. **Waits for Ready, sources first.** A Kustomization cannot become Ready before its GitRepository has an artifact, so gating on `source.toolkit.fluxcd.io` kinds first surfaces a wedged clone as the source's error rather than a reconciler timeout downstream. The generic `waitForReady` handles the rest of the toolkit (kstatus-conformant), with fail-fast on wedge reasons like `BuildFailed` or `UpgradeFailed` from the readiness registry.
3. **Refuses non-Flux manifests.** If the manifest applies no Flux CR at all, the step errors — a plain manifest belongs on `kubectl-apply`, and two things applying the same resources is the failure mode worth engineering against.

It is a `needs-opt-out` capability (COMP003): every step needs `noRollback: "<reason>"`, a component `rollback` phase, or a sibling safety step — same posture as `kubectl-apply`, and for the same reason.

## Reading convergence back

The build stamps `app.kubernetes.io/managed-by: chant` and (with `ownership` configured) `chant.intentius.io/stack: <stack>` labels on every resource. Flux applies the manifests, but the labels travel with them — so `chant components status --live` attributes the running workloads to the stack through the k8s lexicon's label-selector read, regardless of who did the applying. Flux prunes by its own labels; chant observes by its own labels; neither needs the other's.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Kustomization stuck, no artifact | Source stalled — unset `spec.ref` fell back to `master` | Pin a branch/tag (FLUX001); `FluxGitSource` does this by default |
| Kustomization waits forever | `sourceRef` names an undeclared source | Declare it with `FluxGitSource`, or point at the bootstrap `flux-system` repo (FLUX002) |
| App pending, dependencies "not ready" | `dependsOn` names a Kustomization that doesn't exist (typo/rename) | Fix the name (FLUX003), or confirm the other repo declares it |
| App pending forever, no error | `dependsOn` self-reference | Remove the self-edge (FLUX003 flags it) |
| Resources deleted unexpectedly | `prune: true` (the default) and the path stopped emitting them | Intended GitOps behavior; pass `prune: false` to opt out |
| `flux-reconcile` step errors immediately | Manifest contains no Flux CR | Use `kubectl-apply` for plain manifests |
