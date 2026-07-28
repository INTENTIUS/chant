/**
 * The k8s lexicon's *static* deep-observation noise rules (#1076, epic #1073).
 *
 * Split out from `./deep-observe.ts` for one reason: this file must be safe
 * to import from `plugin.ts` at module load time, because
 * `LexiconPlugin.deepNormalizationHooks` is plain data core reads to
 * normalize the *declared* tree — the half of the contract that runs whether
 * or not a cluster is ever touched (`lifecycle diff` without `--live`,
 * `chant build`, tests that only exercise normalization). `./deep-observe.ts`
 * itself imports `@intentius/chant-k8s-client` for the live read, and chant
 * #1074 made that package's reachability from the build path a structural
 * property (`examples/k8s-client-boundary.test.ts`) rather than a lint rule —
 * so nothing this file exports may pull that package in, directly or
 * transitively. It imports nothing but the core contract's own types.
 *
 * What lives here is deliberately the *entityType-keyed, resource-agnostic*
 * half of the rules: which fields the API server always populates regardless
 * of what a manager wrote (`status`, `metadata.uid`, …), which fields
 * Kubernetes defaults when a manifest is silent about them, and which arrays
 * are sets addressed by a well-known identity (containers by name, ports by
 * containerPort+protocol). None of that needs a live object in hand.
 *
 * What does *not* live here is the managed-fields prune — whether one
 * specific field on one specific live object is chant-owned, foreign-owned,
 * or contested. That is inherently per-object (it depends on *that* object's
 * `metadata.managedFields`, which the declared tree never carries and which
 * differs between two Deployments of the same type), so it cannot be
 * expressed as a fixed rule keyed only by entity type and path — the shape
 * every other hook in this file takes. `./deep-observe.ts` computes it once
 * per resource and layers it on top of the rules below.
 */

import type { DeepArrayElement, DeepNode, DeepNormalizationHooks } from "@intentius/chant/lexicon";

/**
 * Paths pruned unconditionally, on both sides, matched on the exact
 * index-erased pattern (there is exactly one `status`, one
 * `metadata.managedFields`, per object — no per-type variation the way AWS's
 * `Arn`/`RoleId` repeat at every nesting depth).
 *
 * - `status` — the whole subtree is server-computed; chant never declares it.
 * - `metadata.uid`/`resourceVersion`/`generation`/`creationTimestamp` — minted
 *   and incremented by the API server, never authored.
 * - `metadata.managedFields` — the bookkeeping this very row reads to decide
 *   everything else. Left in the tree it would report as permanent drift
 *   (a timestamp changes on every write) and would recurse into the encoded
 *   `fieldsV1` structure as if it were ordinary properties.
 * - `metadata.selfLink` — deprecated API-server bookkeeping some clusters
 *   still echo; never a declared field.
 */
const K8S_UNCONDITIONAL_PRUNE_PATTERNS: ReadonlySet<string> = new Set([
  "status",
  "metadata.uid",
  "metadata.resourceVersion",
  "metadata.generation",
  "metadata.creationTimestamp",
  "metadata.managedFields",
  "metadata.selfLink",
]);

/**
 * Kubernetes-defaulted fields, per entity type, as index-erased property
 * paths. Subtracted only where source never declared the property
 * (`side === "live" && counterpart === "absent"`) — cdk-real-drift's default
 * subtraction, same convention as AWS/Azure/Temporal's tables.
 *
 * Sparse and evidence-based rather than derived from the generated schema:
 * the k8s OpenAPI spec this lexicon's codegen consumes
 * (`lexicons/k8s/src/spec/parse.ts`) does not carry a `default` value for
 * these fields the way ARM's schema sometimes does, so "per discovery" is not
 * actually expressible today. Widening this table is additive and needs no
 * contract change.
 *
 * `spec.strategy` is listed whole, not as `spec.strategy.type`, for the same
 * reason Temporal's `TEMPORAL_SCHEDULE_DEFAULTS` lists `state` whole: pruning
 * only the leaf would still recurse into the object, and a nested default the
 * table does not separately name (`rollingUpdate.maxSurge`/`maxUnavailable`,
 * both `"25%"` when `spec.strategy` is omitted entirely) would leave behind an
 * empty `strategy: {}` — a value distinct from no `strategy` key at all, and
 * itself a spurious "undeclared" finding. Matching the whole node first, before
 * its children are ever visited, drops the wrapper outright when every field
 * under it is exactly at its default.
 */
export const K8S_SERVICE_DEFAULTS: Record<string, Record<string, unknown>> = {
  "K8s::Apps::Deployment": {
    "spec.strategy": { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } },
    "spec.revisionHistoryLimit": 10,
    "spec.progressDeadlineSeconds": 600,
    "spec.template.spec.dnsPolicy": "ClusterFirst",
    "spec.template.spec.restartPolicy": "Always",
    "spec.template.spec.terminationGracePeriodSeconds": 30,
    "spec.template.spec.schedulerName": "default-scheduler",
  },
  "K8s::Core::Service": {
    "spec.sessionAffinity": "None",
    "spec.type": "ClusterIP",
  },
};

/** Stable JSON with sorted keys — the fallback ordering key for a set-like array without a natural identity field. */
function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    ) ?? ""
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The final segment of an index-erased pattern (`spec.template.spec.containers[].env[].name` → `name`'s *container*, i.e. `env`). */
function lastSegment(pattern: string): string {
  const withoutIndex = pattern.replace(/\[\]$/, "");
  const dot = withoutIndex.lastIndexOf(".");
  return dot === -1 ? withoutIndex : withoutIndex.slice(dot + 1);
}

/**
 * The k8s lexicon's static noise rules: server-populated fields (unconditional,
 * by pattern) and Kubernetes-defaulted fields (gated on `counterpart ===
 * "absent"`), plus the array orderings the acceptance criteria name —
 * `x-kubernetes-patch-merge-key`/`list-map-keys` conventions the generated
 * surface does not currently carry (see the module doc), so these are the
 * "else named-by-name conventions" the issue calls for: containers by `name`,
 * `env` by `name`, `volumes` by `name`, container/service `ports` by
 * `containerPort`/`port` + `protocol`.
 *
 * This is the object `k8sPlugin.deepNormalizationHooks` is. It is also what
 * `./deep-observe.ts` layers its per-resource managed-fields prune on top of,
 * so the two normalization passes (the reader's own, and core's later
 * re-normalization of both the declared and the already-normalized live tree
 * — see `packages/core/src/lifecycle/deep-observe.ts`) apply the identical
 * entityType-keyed rules either way.
 */
export const k8sDeepNormalizationHooks: DeepNormalizationHooks = {
  prune(node: DeepNode): boolean {
    if (K8S_UNCONDITIONAL_PRUNE_PATTERNS.has(node.pattern)) return true;

    if (node.side !== "live" || node.counterpart !== "absent") return false;
    const defaults = K8S_SERVICE_DEFAULTS[node.entityType];
    if (!defaults || !Object.prototype.hasOwnProperty.call(defaults, node.pattern)) return false;
    return canonicalJson(defaults[node.pattern]) === canonicalJson(node.value);
  },

  /**
   * `name` is the element's own identity for containers/volumes/env — the
   * same field Kubernetes' strategic-merge-patch keys on for these lists.
   * Container ports key on `containerPort`+`protocol`, and Service ports key
   * on `port`+`protocol` (Kubernetes' own SSA list-map-keys for each), so both
   * are handled under one `ports` branch by checking which field is present.
   */
  orderKey(element: DeepArrayElement): string | undefined {
    const name = lastSegment(element.pattern);
    const el = element.element;

    if (name === "containers" || name === "initContainers" || name === "ephemeralContainers") {
      return isRecord(el) && typeof el.name === "string" ? el.name : canonicalJson(el);
    }
    if (name === "env" || name === "volumes") {
      return isRecord(el) && typeof el.name === "string" ? el.name : canonicalJson(el);
    }
    if (name === "ports") {
      if (isRecord(el)) {
        const protocol = typeof el.protocol === "string" ? el.protocol : "TCP";
        // Zero-padded so the sort key orders numerically, not lexicographically
        // ("443" would otherwise sort before "80") — cosmetic, since either
        // order canonicalizes the two sides identically, but a stable,
        // human-sensible order is free to have here.
        if (typeof el.containerPort === "number") return `${String(el.containerPort).padStart(5, "0")}/${protocol}`;
        if (typeof el.port === "number") return `${String(el.port).padStart(5, "0")}/${protocol}`;
      }
      return canonicalJson(el);
    }

    return undefined;
  },
};
