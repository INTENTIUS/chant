# argo-cd-gke — minimal Argo CD on-ramp

> **New to chant?** Start with the [golden teaching example](../getting-started/) — synthesis → lint → Ops → the lifecycle dial over one set of declarations — then come back here for a production-shaped deployment.

A single GKE cluster, Argo CD installed via Helm/manifests, and **one
Chant-authored workload reconciled by Argo CD** through a `K8s::Argo::Application`
declared in TypeScript with `ArgoAppFor`.

This is the smallest example of the three-layer split:

| Layer | Owns | Here |
|---|---|---|
| **Chant** | Authoring typed infra → manifests | `src/app` (the workload), `src/bootstrap` (the Application) |
| **Argo CD** | Continuously reconciling the manifests | watches `dist/app/` in git, syncs into the cluster |
| **Temporal** | Procedural steps Argo can't express | *not needed for this example* |

The key idea: **the k8s lexicon stays runtime-agnostic.** `src/app` is plain
Chant k8s — it knows nothing about Argo. Argo is **opt-in**, added by one
`ArgoAppFor` call in `src/bootstrap`. Nothing about the workload changes whether
you apply it with `kubectl` or hand it to Argo.

## Layout

```
src/
  config.ts              # repo URL, paths, namespaces, the demo image
  app/web.ts             # the workload — WebApp (Deployment + Service)
  bootstrap/application.ts  # ArgoAppFor → the Argo Application that syncs src/app
```

Two build outputs:

- `dist/app/manifests.yaml` — the workload. **Commit this to the git repo Argo
  watches** (`ARGO_REPO` / `ARGO_APP_PATH`).
- `dist/argo.yaml` — the Argo `Application`. **Apply this once** to bootstrap the
  GitOps loop; thereafter Argo reconciles the workload from git.

## Prerequisites

- `gcloud` and `kubectl` authenticated; `GCP_PROJECT_ID` set.
- A git repo Argo can read. Set `ARGO_REPO` (and `ARGO_APP_PATH`, default
  `dist/app`) to where you'll push the built workload manifests.

## Walkthrough

### 1. Build the manifests

```bash
npm install
npm run build           # → dist/app/manifests.yaml + dist/argo.yaml
```

`dist/argo.yaml` is the whole Argo integration — ~20 lines of `Application` YAML
from one `ArgoAppFor` call:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: web
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/your-org/argo-cd-gke-demo
    path: dist/app
    targetRevision: HEAD
  destination:
    server: https://kubernetes.default.svc
    namespace: demo
  syncPolicy:
    automated: { prune: false, selfHeal: true }
    syncOptions: ["CreateNamespace=true"]
```

The default sync policy is **automated, non-pruning, self-healing** — safe for a
first on-ramp. (`prune: false` keeps it ARGO001-clean; flip it on per the rule's
guidance once you trust the loop.)

### 2. Push the workload to git

Commit `dist/app/` to the repo referenced by `ARGO_REPO` so Argo has something
to sync:

```bash
# in your demo repo
cp -r dist/app <repo>/dist/app && git -C <repo> add dist/app && git -C <repo> commit -m "workload" && git -C <repo> push
```

### 3. Create the cluster and install Argo CD

```bash
npm run cluster           # GKE Autopilot cluster (idempotent)
npm run configure-kubectl
npm run install-argocd    # Argo CD v2.13.3 into namespace argocd
```

### 4. Bootstrap the Application

```bash
npm run bootstrap         # kubectl apply dist/argo.yaml
npm run wait              # block until the Application is Healthy
npm run status
```

### 5. (optional) Open the Argo UI

```bash
npm run ui                # port-forward → https://localhost:8080
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

`npm run deploy` runs steps 1, 3, and 4 end to end (you still push to git in
step 2 first).

## What success looks like

```
$ npm run status
NAME   SYNC STATUS   HEALTH STATUS
web    Synced        Healthy
```

The `web` Deployment and Service exist in the `demo` namespace, created by Argo —
not by `kubectl apply` of the workload. Change `src/app`, rebuild, push to git,
and Argo reconciles the diff on its own.

## Next steps

- Scope the Application to a real `AppProject` (`project:` option) for RBAC.
- Fan out across regional clusters with `ArgoAppSetForRegions`.
- Gate procedural steps (cert generation, `init` RPCs) on Argo finishing with
  the temporal lexicon's `waitForArgoSync` activity — see the
  `temporal-crdb-deploy` example.
