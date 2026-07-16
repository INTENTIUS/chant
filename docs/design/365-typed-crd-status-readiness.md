# #365 — Typed CRD status → generated readiness (design spike)

Research spike deliverable. No code ships from this doc; it answers the issue's research questions against the current tree and proposes a sequenced set of follow-up issues.

Investigated in a fresh clone at commit HEAD of `main`. Note two stale references in the issue body, corrected here:

- The bespoke waits are no longer in `lexicons/temporal/…`. Post-#809 they live in the k8s lexicon: `lexicons/k8s/src/op/activities/argo.ts` (`waitForArgoSync`) and `lexicons/temporal/src/op/activities/wait.ts` (`waitForStack`, still temporal-side, workload-only).
- `waitForArgoSync` already returns typed status (`ArgoAppStatus`) and is dependency-light by design — a constraint that shapes the whole solution (see §4).

## Summary of conclusions

1. Status is worth typing. A ground-truth audit of the baked-in CRDs shows status is richly and genuinely typed (not `preserve-unknown`) on every operator-backed workload kind, with `conditions` near-universal. See §2.
2. A default readiness predicate — `conditions[type=Ready]==True` plus `observedGeneration>=metadata.generation` — covers most kinds, but not all. Argo uses `health/sync`, not a Ready condition. So the model needs a default plus a per-resource override. See §3.
3. The readiness abstraction must be **data, not generated TypeScript**. The wait activity must not import generated CRD types (the `waitForArgoSync` dependency-light rule). So codegen emits a readiness *spec* (jsonpath predicates + terminal conditions) consumed by one generic `waitForReady` activity — it does not generate a per-CRD activity that imports the class. See §4.
4. Status passthrough into the synthesis graph is **not feasible** at build time. Chant synthesis is pure and stateless — no state file, no cluster read. Status only exists at Op-execution time, so it is a runtime value consumed imperatively inside an Op step (exactly like `waitForArgoSync`'s return), never a build-time dependency input. See §5.

## 1. Codegen: what it takes to stop dropping status

`lexicons/k8s/src/crd/parser.ts` drops status in two places:

- `extractProperties` (line 148): `skipProps = {apiVersion, kind, status}` — status never becomes a property.
- `extractPropertyTypes` (line 172): walks only `schema.properties?.spec`, so nested types are emitted for spec alone.

The `ParsedResource` shape (`spec/parse.ts`) already has the right channel for read-only output: `attributes: Array<{name, tsType}>`, today carrying `name`/`namespace`/`uid`. Status belongs here, not in `properties` (which is the writable authoring surface).

Minimal codegen change:

- Add a parallel `extractStatusType(schema)` that walks `schema.properties?.status` and emits a read-only property type (e.g. `RayCluster_Status` with nested `RayCluster_StatusHead` etc.), reusing the existing `uniqueName` dedup.
- Surface it as a single read-only `status` attribute on the resource whose `tsType` is the emitted status type, kept distinct from the writable spec.

Downstream impact to verify:

- Naming collisions. The existing `source`/`sources` collision handling in `extractPropertyTypes` must extend to status subtypes, and status type names must not collide with spec type names. A `Status`-segment prefix (`<Kind>_Status…`) keeps them disjoint.
- `resolveSchemaType` already maps `x-kubernetes-preserve-unknown-fields` → `Record<string, any>`, so opaque status degrades gracefully to an untyped record rather than breaking.
- `codegen/generate.ts` renders `attributes` as read-only — confirm a nested-object attribute type renders (today's attributes are all scalar). This is the one non-trivial generator change.

## 2. Status-richness audit (ground truth)

Fetched each CRD's live schema and inspected `properties.status`. None in the sample use `preserve-unknown` for status — it is genuinely typed.

| CRD | status props | `conditions`? | notable typed fields |
|---|---|---|---|
| cert-manager `Certificate` | 8 | yes | `notAfter`, `notBefore`, `renewalTime`, `revision` |
| cert-manager `Issuer`/`ClusterIssuer` | 2 | yes | `acme` |
| cert-manager `Order` | 7 | no (`state`) | `state`, `certificate`, `url` |
| cert-manager `Challenge` | 4 | no (`state`) | `state`, `presented`, `processing` |
| Gateway API `Gateway` | 3 | yes | `addresses`, `listeners` |
| Gateway API `HTTPRoute`/`GRPCRoute` | 1 | via `parents` | `parents[].conditions` |
| Gateway API `ReferenceGrant` | — | — | no status (config-only) |
| Argo `Application` | 13 | yes | `health`, `sync`, `operationState`, `resources`, `history` |
| Argo `ApplicationSet` | 3 | yes | `applicationStatus` |
| Argo `AppProject` | 1 | no | `jwtTokensByRole` (not readiness) |
| KubeRay `RayCluster` | 17 | yes | `state`, `head.serviceIP`, `endpoints`, `desiredWorkerReplicas` |
| Cockroach `CrdbCluster` | 6 | yes | `clusterStatus`, `sqlHost`, `version` |
| Prometheus `ServiceMonitor` | — | — | no status (config-only) |

Reading:

- Operator-backed workloads (Certificate, Gateway, Application, RayCluster, CrdbCluster) all carry rich typed status — the kinds people actually wait on. Typing status delivers real value here: `cert.status.notAfter`, `rayCluster.status.head.serviceIP`, `crdb.status.version` become typed outputs.
- Config-only CRDs (ServiceMonitor, ReferenceGrant, AppProject) have no meaningful status. Readiness generation should no-op for them, not emit a dead wait.

## 3. Readiness model

Prior art: kubernetes-sigs `kstatus` computes readiness generically from `conditions` + `observedGeneration`, and is the right conceptual base.

Default predicate (inferred, no per-CRD config):

```
ready  ==  conditions[type=Ready].status == "True"
       &&  (status.observedGeneration is absent OR >= metadata.generation)
```

Coverage against the audit: works directly for Certificate, Issuer, Gateway, GatewayClass, CrdbCluster, and RayCluster (all expose a `Ready`/top-level condition). It does **not** work for Argo `Application` (readiness is `health==Healthy && sync==Synced`, no Ready condition) or for state-machine kinds like cert-manager `Order`/`Challenge` (`state` enum).

Per-resource override (required, Argo proves it). A predicate over typed status, registered next to the CRD source:

```ts
// shape only — a readiness spec is data, see §4
readiness: {
  ready:    [{ path: "status.health.status", equals: "Healthy" },
             { path: "status.sync.status",   equals: "Synced" }],
  terminal: [{ path: "status.health.status", in: ["Degraded", "Missing"] }],
}
```

`terminal` is the second thing `waitForArgoSync` teaches — a state that will never become ready must fail fast, not poll to timeout. The default model needs a terminal notion too (e.g. `conditions[type=Ready].reason` in a known-failed set), or it waits the full 15m on a wedged resource.

## 4. Architecture — a generic activity, not generated activities

The decisive constraint is in `argo.ts`: the wait activity is "intentionally dependency-light … must not import the lexicon's generated Argo CRD types … its signature is primitives-only so a Temporal worker can load it without pulling in the declarable surface."

So the solution is **not** "generate a `waitForKeycloak` TS activity that imports the `Keycloak` class." It is:

1. Codegen emits, alongside each resource, a serializable **readiness spec** (the jsonpath `ready`/`terminal` rules from §3 — inferred default, or the registered override). This is plain data, no type imports.
2. One generic `waitForReady(gvk, readinessSpec, {namespace, context, server})` activity lives in `lexicons/k8s/src/op/activities/` — primitives + data only. It reads the resource via `kubectl get -o json` (the `describe-resources.ts` reader already does this), evaluates the spec's jsonpath predicates, heartbeats each poll, throws on `terminal`, returns the raw status. It generalizes both `waitForArgoSync` and the workload half of `waitForStack`.
3. `waitForArgoSync` becomes the migration test case — its exact behavior must be expressible as a readiness spec. If it is, the bespoke activity can be retired (or kept as a thin wrapper for the REST-API path, which `kubectl` can't cover).

This slots into the existing Op step model under the `k8sWait` profile (`config.ts`: 15m timeout, 60s heartbeat, 3 retries) with no new infrastructure — the profile, gates, `ReconcileOp`/`WatchOp`/`ApplyOp` all stay as-is.

The `describe-resources.ts` `statusFromKubectl` logic (phase, `readyReplicas==replicas`) is the untyped ancestor of this — the generic activity promotes that ad-hoc reading to a spec-driven one.

## 5. Status passthrough into the synthesis graph — not feasible

Question: can a typed status value feed the synthesis graph as a dependency input (resource B consumes A's `status.x`)?

No, and the reason is architectural, not a missing feature. Chant synthesis is pure and local — it emits manifests from TypeScript with no state file and no cluster read (this is a stated design property, and why `ReconcileOp` exists as a separate runtime concern). At build time, `status` does not exist; the resource has not been applied. A build-time `B.spec.host = A.status.loadBalancer.ip` cannot resolve.

Status is therefore a **runtime-only** value, available only inside an Op step after apply — exactly how `waitForArgoSync` returns `ArgoAppStatus` to its workflow. The typed status type improves the ergonomics of *consuming* that runtime value (typed `.status` on the activity return), but it never becomes a synthesis-graph edge. Any design that tries to thread status into `spec` at build time contradicts the stateless-synthesis invariant and should be rejected.

This bounds the feature cleanly: type status as a read-only output, generate a spec-driven wait, surface status on the wait's return. Do not attempt build-time status references.

## 6. Proposed sequenced follow-up issues

Scoped so each is independently shippable, smallest blast radius first.

1. **feat(k8s): emit read-only typed status from CRD schemas.** Add `extractStatusType`, surface a `status` attribute, extend collision handling, render nested-object attributes in `generate.ts`. Round-trip test asserting `Certificate.status.notAfter`, `RayCluster.status.head`, `Application.status.health` are typed. No runtime behavior change — pure codegen. (Largest generator risk lives here; ship it alone.)
2. **feat(k8s): readiness spec + generic `waitForReady` activity.** Define the readiness-spec data type, the inferred default (`conditions[type=Ready]` + `observedGeneration`), and the per-resource override registry. Implement the generic primitives-only activity under the `k8sWait` profile, with an injectable fetcher mirroring `argo.ts`. Positive/negative tests driving Ready/Progressing/terminal transitions.
3. **refactor(k8s): express `waitForArgoSync` as a readiness spec.** Prove the model on the one existing bespoke case. Keep the REST-API path if `kubectl` can't cover it; retire or thin-wrap the rest. This is the acceptance test for the whole design.
4. **docs(k8s): typed status + readiness in the Ops guide + crd-classes.mdx.** Document the default predicate, the override surface, and the "status is runtime-only, never a build-time reference" rule from §5.

Dependencies: 2 depends on 1 (needs the status types to validate specs against); 3 depends on 2; 4 trails. #365 itself closes when 1–3 are filed with acceptance criteria.

## Files touched (for the implementing issues)

- `lexicons/k8s/src/crd/parser.ts` — status extraction (§1)
- `lexicons/k8s/src/spec/parse.ts`, `lexicons/k8s/src/codegen/generate.ts` — read-only nested attribute rendering (§1)
- `lexicons/k8s/src/op/activities/` — generic `waitForReady`, alongside `argo.ts` (§4)
- `lexicons/k8s/src/describe-resources.ts` — the untyped status reader to generalize (§4)
- `lexicons/temporal/src/config.ts` — reuse `k8sWait`, no change (§4)
- `lexicons/temporal/src/op/activities/wait.ts` — `waitForStack` workload wait, generalized by §4
