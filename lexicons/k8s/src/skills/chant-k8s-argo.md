---
skill: chant-k8s-argo
description: Argo CD composites for GitOps reconciliation — ArgoAppFor, ArgoAppSetForRegions, AppProject scoping, cluster registration, and the Argo-vs-Temporal split
user-invocable: true
---

# Argo CD Composites

Chant authors typed infrastructure into manifests. Argo CD continuously reconciles those manifests into a cluster. These composites are the opt-in bridge — the k8s lexicon itself stays runtime-agnostic and only emits YAML; nothing here is implied unless you reach for it.

## The three-layer model

| Layer | Owns | In Chant |
|---|---|---|
| **Chant** | Authoring typed infra → manifests | the lexicons |
| **Argo CD** | Continuously reconciling declarative manifests (the apply layer) | `ArgoAppFor` / `ArgoAppSetForRegions` |
| **Temporal** | Procedural steps Argo can't express — ordering, signals, human gates, one-shot RPCs | the temporal lexicon + `waitForArgoSync` |

Rule of thumb: **if it's declarative and converges, let Argo reconcile it. If it's a procedure with ordering, gates, or out-of-band steps, orchestrate it in Temporal.** Prefer Argo CD over Argo Workflows — the procedural layer stays Temporal.

## Prerequisites

Argo CD must be installed in the target cluster before applying any Argo CRs:

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.13.3/manifests/install.yaml
kubectl -n argocd wait deploy/argocd-server --for=condition=Available --timeout=180s
```

## When to use which composite

| Composite | Use case |
|---|---|
| `ArgoAppFor` | A single Chant build target reconciled by Argo |
| `ArgoAppSetForRegions` | The same app fanned out across regions/clusters from one declaration |
| `registerArgoCluster` | Teaching Argo about an external (non in-cluster) target |

---

## ArgoAppFor — one Application from a build target

```typescript
import { ArgoAppFor } from "@intentius/chant-lexicon-k8s";

export const api = ArgoAppFor("api", {
  repo: "https://github.com/acme/infra",
  path: "dist/api",
  destination: { server: "https://kubernetes.default.svc", namespace: "api" },
});
```

One call replaces ~30 lines of hand-written `Application` YAML. Defaults are production-friendly:

- **destination** — defaults to the in-cluster target (`https://kubernetes.default.svc`, namespace = target name) when omitted.
- **project** — defaults to `default`. Pass `project` to scope it to a declared `AppProject`.
- **syncPolicy** — defaults to **automated, non-pruning, self-healing** with `CreateNamespace=true`. Pass `syncPolicy: {}` for manual sync, or override fields explicitly.

```typescript
export const api = ArgoAppFor("api", {
  repo: "https://github.com/acme/infra",
  path: "dist/api",
  project: "payments",
  syncPolicy: { automated: { prune: false, selfHeal: true }, syncOptions: ["ServerSideApply=true"] },
});
```

> **ARGO001** — on a *production* Application (name / namespace / destination namespace contains `prod`), automated `prune` must be `false` unless you opt in with the `argocd.chant.dev/allow-prune` annotation. Pruning deletes live resources that vanish from git; on prod that's a foot-gun.

---

## ArgoAppSetForRegions — fan out across clusters

```typescript
import { ArgoAppSetForRegions } from "@intentius/chant-lexicon-k8s";

const clusterServers: Record<string, string> = {
  east: "https://east.example.com",
  central: "https://central.example.com",
  west: "https://west.example.com",
};

export const crdb = ArgoAppSetForRegions(
  ["east", "central", "west"],
  (region) => ({
    server: clusterServers[region],
    namespace: `crdb-${region}`,
    path: `dist/${region}`,
  }),
  { name: "crdb", repo: "https://github.com/acme/infra", project: "crdb" },
);
```

Emits **one `ApplicationSet`** with a list generator — Argo expands it into one synced `Application` per region (`east-crdb`, `central-crdb`, `west-crdb`). The mapper resolves per-region values (`server`, `namespace`, `path`, `targetRevision`); the template interpolates them (`{{server}}`, `{{namespace}}`, `{{path}}`).

> **ARGO004** — the template scopes to a **single static** `AppProject`. `ArgoAppSetForRegions` always sets a static `project`; never template it (`project: "{{...}}"`) or the set sprays Applications across projects and defeats the RBAC boundary.

---

## AppProject scoping

An `AppProject` is the RBAC and source/destination guardrail for a group of Applications. Declare one and reference it by name:

```typescript
import { AppProject } from "@intentius/chant-lexicon-k8s";

export const payments = new AppProject({
  metadata: { name: "payments", namespace: "argocd" },
  spec: {
    description: "Payments team applications",
    sourceRepos: ["https://github.com/acme/infra"],
    destinations: [{ server: "https://kubernetes.default.svc", namespace: "payments-*" }],
  },
});
```

> **ARGO002** — every `Application.spec.project` must reference a declared `AppProject` (the built-in `default` is exempt). Declaring the project in the same build keeps the reference honest.

---

## registerArgoCluster — external clusters

The in-cluster target needs no registration. For any other cluster, emit the registration Secret:

```typescript
import { registerArgoCluster } from "@intentius/chant-lexicon-k8s";

export const east = registerArgoCluster({
  name: "east",
  server: "https://east.example.com",
  config: { tlsClientConfig: { insecure: false }, bearerToken: process.env.EAST_TOKEN },
});
```

Produces a `Secret` labelled `argocd.argoproj.io/secret-type: cluster`. After this, Applications can target the cluster by `destination.server: "https://east.example.com"` or `destination.name: "east"`.

> **ARGO003** — every `Application.spec.destination` must reference a registered cluster (a cluster Secret) or the in-cluster target. Register external clusters before pointing Applications at them.

---

## The Argo-vs-Temporal split

When a deploy has both declarative and procedural parts, let each layer own what it's good at. Example — the multi-region CockroachDB deploy:

| Step | Owner | Why |
|---|---|---|
| Apply shared + regional infra | **Argo** | Declarative, converges — Argo reconciles it |
| Install ESO / operators (Helm) | **Argo** | Declarative Helm source |
| Apply per-cluster K8s manifests | **Argo** (`ApplicationSet`) | One App per workload cluster |
| Wait for workloads Healthy | **Argo** (`Health=Healthy`) | Subsumed by Application health |
| Wait for DNS delegation | **Temporal** | Signal/update/auto-poll race — out of band |
| Generate + push TLS certs | **Temporal** | One-shot procedure, secrets not in git |
| `cockroach init`, configure regions | **Temporal** | Ordered one-shot RPCs |

From a Temporal workflow, gate procedural steps on Argo finishing a declarative apply with the `waitForArgoSync` activity (temporal lexicon, `argoSync` profile):

```typescript
// In a Temporal Op workflow:
await waitForArgoSync({ appName: "east-crdb", namespace: "argocd" });
// ...now run the procedural steps that depend on the workloads being Healthy.
```

`waitForArgoSync` is dependency-free — it polls the Application's status (`health=Healthy && sync=Synced`) and never imports the Argo CRD types.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Application stuck `OutOfSync` | Manual sync policy, no auto-sync | Set `syncPolicy.automated`, or sync via `argocd app sync <name>` |
| Application `Healthy` but resources missing | Wrong `destination.namespace` or `source.path` | Check ARGO005 (path) / ARGO003 (destination) |
| `ComparisonError: project not found` | `spec.project` references an undeclared `AppProject` | Declare the project (ARGO002) |
| `cluster ... not found` at sync | Destination cluster not registered | `registerArgoCluster` before targeting it (ARGO003) |
| Prod resources unexpectedly deleted | Automated `prune: true` on prod | Set `prune: false` (ARGO001) |
| `ApplicationSet` generates apps in wrong projects | Templated `spec.project` | Pin to a single static project (ARGO004) |
