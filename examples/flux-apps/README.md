# flux-apps — Flux CD on a self-hosted cluster

> **New to chant?** Start with the [golden teaching example](../getting-started/) — synthesis → lint → Ops → the lifecycle dial over one set of declarations — then come back here for a GitOps-shaped deployment.

A self-hosted Kubernetes cluster (k3s or any cluster with Flux installed), and
**a platform layer plus two Chant-authored workloads reconciled by Flux CD**
through one `GitRepository` and three `Kustomization`s declared in TypeScript
with `FluxGitSource` + `FluxAppFor`.

This is the Flux counterpart of [`argo-cd-gke`](../argo-cd-gke/), aimed at
where Flux users actually are: no cloud, no account — a homelab estate with
Traefik (k3s ships it) and cert-manager.

| Layer | Owns | Here |
|---|---|---|
| **Chant** | Authoring typed infra → manifests | `src/platform`, `src/apps` (workloads), `src/flux` (the Flux CRs) |
| **Flux** | Continuously reconciling the manifests | watches `dist/` in git, applies in dependency order |
| **Chant again** | Reading convergence back | `flux-reconcile` deploy step, `chant components status --live` |

The key idea: **the k8s lexicon stays runtime-agnostic.** `src/platform` and
`src/apps` are plain Chant k8s — they know nothing about Flux. Flux is
**opt-in**, added by four calls in `src/flux`. Nothing about the workloads
changes whether you apply them with `kubectl` or hand them to Flux.

## Layout

```
src/
  config.ts                # repo URL, namespaces, hosts, the demo images
  platform/platform.ts     # Namespace + self-signed ClusterIssuer
  apps/api/api.ts          # WebApp (Deployment + Service) — whoami
  apps/web/web.ts          # WebApp + Traefik IngressRoute + Certificate
  flux/apps.ts             # FluxGitSource + 3× FluxAppFor (the GitOps loop)
  deploy/flux.component.ts # flux-reconcile deploy leaf (chant run --components)
```

**12 resources** in the combined build: 2 platform + 2 api + 4 web + the
`GitRepository` and 3 `Kustomization`s. (`examples/examples.test.ts` asserts
this count — keep them in lockstep.)

Four build outputs:

- `dist/platform/manifests.yaml`, `dist/apps/api/manifests.yaml`,
  `dist/apps/web/manifests.yaml` — the workloads. **Commit these to the git
  repo Flux watches** (`FLUX_REPO`).
- `dist/flux.yaml` — the `GitRepository` + `Kustomization`s. **Apply this
  once** to bootstrap the GitOps loop; thereafter Flux reconciles from git.

## One source, many apps

`src/flux/apps.ts` declares the repo once and reconciles three paths out of
it, with ordering:

```typescript
const source = FluxGitSource("flux-apps", { url: config.repo, branch: config.branch });

export const platform = FluxAppFor("platform", { source, path: "./dist/platform" });
export const api = FluxAppFor("api", { source, path: "./dist/apps/api", dependsOn: ["platform"] });
export const web = FluxAppFor("web", { source, path: "./dist/apps/web", dependsOn: ["platform", "api"] });
```

The `dependsOn` entries are plain name lists — FLUX003 joins every entry
against the Kustomizations this build declares, so a typo fails at build time
instead of stalling the cluster silently. FLUX002 does the same for the
`sourceRef`, and the source always pins a ref (FLUX001 — an unset
`spec.ref` falls back to the `master` branch).

## Prerequisites

- A cluster with Traefik (k3s ships it; on other clusters install it or swap
  the `IngressRoute` for a vanilla `Ingress`).
- `kubectl` pointed at that cluster.
- A git repo Flux can read. Set `FLUX_REPO` (and optionally `FLUX_BRANCH`) to
  where you'll push the built manifests.
- Flux and cert-manager installed — `npm run install-flux` and
  `npm run install-cert-manager` do pinned installs.

Everything runs on hardware you already own; the only cost is the few minutes
of the two controller installs.

## Walkthrough

### 1. Build the manifests

```bash
npm install
npm run build     # → dist/platform/ + dist/apps/{api,web}/ + dist/flux.yaml
```

### 2. Push the workloads to git

Commit `dist/` to the repo referenced by `FLUX_REPO` so Flux has something to
reconcile:

```bash
cp -r dist <repo>/dist && git -C <repo> add dist && git -C <repo> commit -m "manifests" && git -C <repo> push
```

### 3. Install the controllers

```bash
npm run install-flux           # Flux v2.9.1 into flux-system (the CRD codegen pin)
npm run install-cert-manager   # cert-manager v1.16.2
```

### 4. Bootstrap the GitOps loop

```bash
npm run bootstrap   # kubectl apply dist/flux.yaml
npm run wait        # block until kustomization/web is Ready
npm run status
```

Or, as a component deploy with a convergence wait built in
(`src/deploy/flux.component.ts`, the `flux-reconcile` capability):

```bash
npm run deploy      # chant run --components flux-bootstrap --env home
```

`flux-reconcile` applies `dist/flux.yaml` through the same server-side apply
`kubectl-apply` uses, then waits for every applied Flux CR to report Ready —
sources first, so a wedged clone surfaces as the `GitRepository`'s error, not
a reconciler timeout downstream. Wedge reasons like `BuildFailed` fail fast
instead of polling out the timeout.

## What success looks like

```
$ npm run status
NAME                                     READY   STATUS
gitrepository.source.toolkit.fluxcd.io/flux-apps   True    stored artifact for revision 'main@sha1:...'

NAME                                     READY   STATUS
kustomization.kustomize.toolkit.fluxcd.io/platform   True    Applied revision: main@sha1:...
kustomization.kustomize.toolkit.fluxcd.io/api        True    Applied revision: main@sha1:...
kustomization.kustomize.toolkit.fluxcd.io/web        True    Applied revision: main@sha1:...
```

The workloads exist in the `demo` namespace, created by Flux in dependency
order — not by `kubectl apply` of the workloads. Change `src/apps`, rebuild,
push to git, and Flux reconciles the diff on its own.

Because `chant.config.ts` sets `ownership: { stack: "flux-apps" }`, the build
stamps `chant.intentius.io/stack` labels on every resource. Flux applies
them, the labels travel along, and

```bash
npm run status:components   # chant components status home --live
```

attributes the running workloads back to the stack through that label
selector — the labels channel — regardless of who did the applying.

## Next steps

- Point `FLUX_REPO` at a private repo and pass `secretRef` to
  `FluxGitSource`.
- Swap the self-signed `ClusterIssuer` for an ACME issuer once the cluster
  has a real domain.
- Split infra and apps across repos the way
  [jhgaylor/home-cloud](https://github.com/jhgaylor/home-cloud) does — FLUX003
  downgrades cross-repo `dependsOn` edges to warnings for exactly that shape.
