---
skill: chant-k8s-argo
description: Argo CD composites for GitOps reconciliation — ArgoAppFor, ArgoAppSetForRegions, AppProject scoping, cluster registration, and how a deploy splits between Argo and a chant Op
user-invocable: true
---

# Argo CD Composites

Chant authors typed infrastructure into manifests. Argo CD continuously reconciles those manifests into a cluster. These composites are the opt-in bridge — the k8s lexicon itself stays runtime-agnostic and only emits YAML; nothing here is implied unless you reach for it.

## The three-layer model

| Layer | Owns | In Chant |
|---|---|---|
| **Chant** | Authoring typed infra → manifests | the lexicons |
| **Argo CD** | Continuously reconciling declarative manifests (the apply layer) | `ArgoAppFor` / `ArgoAppSetForRegions` |
| **A chant Op** | Procedural steps Argo can't express: ordering, human gates, one-shot RPCs | an `Op` in the project, plus this lexicon's `waitForArgoSync` |

Rule of thumb: **if it's declarative and converges, let Argo reconcile it. If it's a procedure with ordering, gates, or out-of-band steps, write it as a chant Op and run it from CI or a steward.** Prefer Argo CD over Argo Workflows; the procedural layer stays an Op.

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

## Splitting a deploy between Argo and an Op

When a deploy has both declarative and procedural parts, let each layer own what it's good at. Example, the multi-region CockroachDB deploy:

| Step | Owner | Why |
|---|---|---|
| Apply shared + regional infra | **Argo** | Declarative, converges — Argo reconciles it |
| Install ESO / operators (Helm) | **Argo** | Declarative Helm source |
| Apply per-cluster K8s manifests | **Argo** (`ApplicationSet`) | One App per workload cluster |
| Wait for workloads Healthy | **Argo** (`Health=Healthy`) | Subsumed by Application health |
| Wait for DNS delegation | **an Op** | Out of band, and a human confirms it |
| Generate + push TLS certs | **an Op** | One-shot procedure, secrets not in git |
| `cockroach init`, configure regions | **an Op** | Ordered one-shot RPCs |

Argo owns the sync. The Op owns the ordering and the gates: its phases run in
sequence in one process (`packages/core/src/op/local-executor.ts`), and a `gate`
step reads the gate ledger, so a run that reaches a gate nobody has approved
records the pending fact, ends with status `gated` and exits 3. Someone runs
`chant approve <op> <gate>`, the next run reads the resolution and walks
through. CI is what runs the Op, on whatever cadence the Op's `schedule`
names.

To make a step wait on Argo, use this lexicon's `waitForArgoSync` activity. It is
exported from `lexicons/k8s/src/op/activities/index.ts`, and the core activity
registry resolves it by export name once `k8s` is in the project's `lexicons`.
Give the step core's `argoSync` profile
(`packages/core/src/op/activity-profiles.ts`): a 30m timeout, five attempts
backing off from 10s, and `ArgoSyncFailedError` marked non-retryable so a
terminally unhealthy Application fails fast instead of polling to the cap.

```typescript
// In an Op phase:
activity("waitForArgoSync", { appName: "east-crdb", namespace: "argocd" }, "argoSync"),
// Later steps in the phase run once the workloads are Healthy.
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
