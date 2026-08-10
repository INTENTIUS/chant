/**
 * `kubectlApply` — apply a rendered manifest to a cluster.
 *
 * chant #1074 moved this off `kubectl apply -f`. The activity contract is
 * unchanged (a manifest path, an optional context, `Promise<void>`, the
 * `longInfra` profile's 15s heartbeat) because Temporal workers register it by
 * that signature; what changed is underneath. The name is kept for the same
 * reason.
 *
 * chant #1075 finished the job on two axes:
 *
 * - **Identity.** The field manager is no longer the bare `chant` but
 *   `chant:<stack>`, derived from the project's `ownership.stack` — the same
 *   identity the ownership label already carries. See
 *   `@intentius/chant-k8s-client`'s `field-manager.ts`.
 * - **Deletes.** `nativeApply`'s kubectl branch used to shell
 *   `kubectl apply --prune --selector <marker>`; that branch now routes here,
 *   so the prune had to come with it. {@link applyManifest} implements it
 *   against the typed client, scoped to the ownership marker exactly as the
 *   shelled prune was, and never touching an object that does not carry it.
 *
 * Consequences worth knowing:
 *
 * - **A worker image needs no `kubectl` binary.** That was the point.
 * - **It is a server-side apply**, rather than the client-side three-way merge
 *   `kubectl apply` performs by default. A conflict with another field manager
 *   arrives as a `FieldManagerConflictError` naming the competing manager and
 *   the contested paths — never as a silent overwrite, and never force-resolved
 *   on chant's initiative.
 * - **Documents apply in file order**, as `kubectl apply -f` does, and a
 *   directory's files are read in sorted order.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";
import { safeHeartbeat } from "@intentius/chant/op";
import { loadChantConfig, resolveOwnershipMarker } from "@intentius/chant/config";
import {
  hasOwnershipMarker,
  LABEL_OWNERSHIP_KEYS,
  OWNERSHIP_MANAGED_BY_VALUE,
} from "@intentius/chant/ownership";
import type { K8sClient, K8sObject } from "@intentius/chant-k8s-client";
import { defaultK8sConnector, type K8sConnector } from "../../api/connect";
import { operationFor } from "../../api/operation-surface";
import { DEFAULT_IMPORT_TYPES } from "../../api/sweep-types";

/**
 * How the apply treats chant-owned objects that are no longer declared. The
 * same three values `nativeApply` has always taken; `gated` differs from
 * `owned-only` only in that the workflow pauses for approval first, which is
 * the composite's business, not this activity's.
 */
export type ApplyDeleteMode = "never" | "owned-only" | "gated";

export interface KubectlApplyArgs {
  /**
   * Path to a manifest file, or a directory of them. With `documents` given,
   * this becomes only the human-facing label the heartbeats and logs carry
   * (e.g. `kustomize:<dir>`), and nothing is read from disk.
   */
  manifest: string;
  /**
   * Already-parsed documents to apply INSTEAD of reading `manifest` (#1548):
   * a renderer that produced the objects in memory — kustomize-apply's
   * `kustomize build` — hands them straight in rather than round-tripping
   * through a temp file. Everything downstream (ownership stamping, the
   * marker-scoped prune, the self-conflict retake) is document-driven and
   * behaves identically.
   */
  documents?: K8sObject[];
  /**
   * kubectl context name. Uses the ambient context if omitted. To target the
   * same cluster the read path (`describeResources`) resolved for an
   * environment — chant #1100 — resolve it with `resolveClusterTarget` from
   * `./index.ts` and pass `.context` through.
   */
  context?: string;
  /**
   * chant environment, used to resolve `k8s.profiles.<env>.context` when no
   * explicit `context` is given. Optional and additive: omitting both keeps
   * the previous behavior of using whatever the kubeconfig selects.
   */
  environment?: string;
  /**
   * Field manager recorded on the applied fields. Omitted derives it from the
   * project's `ownership.stack` (chant #1075) — `chant:<stack>`, or the bare
   * `chant` when the project sets none.
   */
  fieldManager?: string;
  /**
   * Ownership stack, when the caller already knows it and would rather not
   * have the project config read. Ignored if `fieldManager` is set.
   */
  stack?: string;
  /**
   * Take ownership of fields another manager owns instead of failing with a
   * `FieldManagerConflictError`. **Never defaulted on** — see chant #1075.
   */
  force?: boolean;
  /**
   * Delete chant-owned objects that are no longer declared. Default `never`.
   * Deletes are scoped to the ownership marker, so an object chant did not
   * stamp is never a candidate.
   */
  deleteMode?: ApplyDeleteMode;
  /**
   * Server-side dry run — every document is validated and would-be-applied,
   * nothing is persisted, and pruning is skipped entirely (a prune candidate
   * list computed from a state that was never written would be misleading).
   * Optional and additive (chant #1079): `chant kube apply`'s confirmation
   * gate uses this to preview an apply before anything mutates the cluster;
   * Op callers keep the previous behavior by leaving it unset.
   */
  dryRun?: boolean;
  /** Project directory whose `chant.config.ts` carries `ownership`. Defaults to cwd. */
  cwd?: string;
}

/** One object the apply touched. */
export interface AppliedRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

/** What {@link applyManifest} did. */
export interface ApplyManifestResult {
  /** The field manager every object was applied as. */
  fieldManager: string;
  applied: AppliedRef[];
  /** Objects deleted because they carried chant's marker and are no longer declared. */
  pruned: AppliedRef[];
}

/** Read a manifest path — one file, or every YAML/JSON file in a directory. */
export function readManifestDocuments(path: string): Record<string, unknown>[] {
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => /\.(ya?ml|json)$/i.test(f))
        .sort()
        .map((f) => join(path, f))
    : [path];

  const documents: Record<string, unknown>[] = [];
  for (const file of files) {
    for (const doc of loadAll(readFileSync(file, "utf-8"))) {
      // Multi-document YAML files routinely carry empty documents between
      // separators; they are not objects to apply.
      if (doc && typeof doc === "object") documents.push(doc as Record<string, unknown>);
    }
  }
  return documents;
}

/**
 * The field manager to apply as: an explicit one, else `chant:<stack>` from a
 * caller-supplied stack, else `chant:<stack>` from the project's `ownership`
 * config, else the bare `chant`.
 *
 * A project config that cannot be read falls back to the bare `chant` with a
 * warning rather than failing the apply — an activity handed a manifest path
 * and nothing else is a supported way to call this, and its cwd need not be a
 * chant project at all. The warning is there because a *silent* downgrade
 * would change which fields chant owns without saying so.
 */
export async function resolveFieldManager(args: KubectlApplyArgs): Promise<string> {
  return (await resolveApplyIdentity(args)).fieldManager;
}

/**
 * The stack and the field manager together, resolved once. The prune needs the
 * stack for its selector and the apply needs the manager; reading the project
 * config twice for one apply would be silly, and could disagree with itself if
 * the file changed in between.
 */
async function resolveApplyIdentity(
  args: KubectlApplyArgs,
): Promise<{ fieldManager: string; stack?: string }> {
  const { fieldManagerFor, assertValidFieldManager } = await import("@intentius/chant-k8s-client");

  let stack = args.stack;
  if (stack === undefined) {
    try {
      const { config } = await loadChantConfig(args.cwd ?? process.cwd());
      stack = resolveOwnershipMarker(config)?.stack;
    } catch (err) {
      console.warn(
        `[k8s] could not read the project config to derive a field manager ` +
          `(${err instanceof Error ? err.message : String(err)}); applying as the unqualified "chant"`,
      );
    }
  }

  if (args.fieldManager !== undefined) {
    assertValidFieldManager(args.fieldManager);
    return { fieldManager: args.fieldManager, ...(stack !== undefined ? { stack } : {}) };
  }
  return {
    fieldManager: fieldManagerFor(stack !== undefined ? { stack } : undefined),
    ...(stack !== undefined ? { stack } : {}),
  };
}

/**
 * Structural mirror of the client's `FieldManagerConflictError` surface —
 * matched by `name` + shape, NOT `instanceof`, because a static value import
 * of `@intentius/chant-k8s-client` here would put the API-client chain on the
 * build path (the #1074 boundary; same reason the applier itself is reached
 * by dynamic import).
 */
interface ConflictErrorLike {
  name: string;
  conflicts?: Array<{ manager?: unknown; field?: unknown }>;
}

/** chant's reserved label channel — the `chant.intentius.io/*` keys the
 * ownership marker lives under, as a conflict-cause field-path prefix. */
const MARKER_FIELD_PREFIX = `.metadata.labels.${LABEL_OWNERSHIP_KEYS.stack.split("/")[0]}/`;

/**
 * Is this conflict one chant may retake without a human? Two shapes qualify,
 * per contested field:
 *
 * - the owning manager is chant itself (`chant` bare or `chant:<stack>`) —
 *   the ownership-stack → unit-stack migration, or a renamed deploy unit; or
 * - the field lives in chant's OWN reserved label channel
 *   (`chant.intentius.io/*`). A controller that reconciles whole objects
 *   echoes existing labels and becomes their SSA owner as a side effect
 *   (observed live: kubemicrovm's `microvmimagereconciler` owning
 *   `.metadata.labels.chant.intentius.io/stack`) — it never chose that value,
 *   and chant is the authority for its marker namespace no matter who last
 *   echoed it.
 *
 * Any contested field outside both shapes — a spec field, an app label —
 * keeps the presented refusal: that IS a dispute with another tool.
 */
function isChantSelfConflict(err: unknown): boolean {
  const e = err as ConflictErrorLike;
  if (!e || e.name !== "FieldManagerConflictError" || !Array.isArray(e.conflicts) || e.conflicts.length === 0) return false;
  return e.conflicts.every((c) => {
    const chantManager = typeof c.manager === "string" && (c.manager === "chant" || c.manager.startsWith("chant:"));
    const markerField = typeof c.field === "string" && c.field.startsWith(MARKER_FIELD_PREFIX);
    return chantManager || markerField;
  });
}

/**
 * Stamp the apply's own stack identity onto a document's labels.
 *
 * The serializer bakes `ownership.stack` — the *project* identity from
 * `chant.config.ts` — into every manifest it emits. But the apply's identity
 * is the *stack argument it resolved* (a component's `kubectl-apply` step
 * names its own deploy unit, e.g. `kmv-workload`), and that is the value both
 * consumers of the label query for: the owned-only prune's selector and
 * `describeStackStatus`'s presence sweep. Applying the manifest verbatim left
 * the label saying `kubemicrovm-ops` while both readers asked for
 * `kmv-workload` — the prune silently matched nothing and every kubectl-apply
 * unit read absent in `components status --live` (a green estate painted
 * dead). A manifest chant never serialized (upstream CRDs pinned into a
 * `crds` unit) carried no marker at all, with the same two failures.
 *
 * So the apply now re-stamps what it applies: `managed-by=chant` plus the
 * resolved stack. The ownership *verdict* keys on `managed-by` alone
 * (core/ownership.ts `hasOwnershipMarker`), so overlay classification is
 * unchanged; the env label is the serializer's to write and is left as-is.
 * No stack resolved (no explicit arg, no project ownership) applies verbatim,
 * exactly as before.
 */
function stampOwnership(document: K8sObject, stack: string | undefined): K8sObject {
  if (stack === undefined) return document;
  const metadata = (document.metadata ?? {}) as { labels?: Record<string, string> };
  return {
    ...document,
    metadata: {
      ...metadata,
      labels: {
        ...(metadata.labels ?? {}),
        [LABEL_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE,
        [LABEL_OWNERSHIP_KEYS.stack]: stack,
      },
    },
  } as K8sObject;
}

/**
 * Apply every document in `args.manifest`, then prune when asked.
 *
 * Returns what it did. `kubectlApply` is the registered activity and keeps its
 * `Promise<void>` contract; this is the function `nativeApply` calls, because a
 * dispatcher that reports "applied 12, pruned 2" is worth more than one that
 * reports the shell command it ran.
 */
export async function applyManifest(
  args: KubectlApplyArgs,
  signal?: AbortSignal,
  connect: K8sConnector = defaultK8sConnector,
): Promise<ApplyManifestResult> {
  const documents = args.documents ?? readManifestDocuments(args.manifest);
  const { fieldManager, stack } = await resolveApplyIdentity(args);
  const heartbeatInterval = setInterval(() => {
    safeHeartbeat({ step: "kubectl apply", manifest: args.manifest });
  }, 15_000);

  try {
    const { client } = await connect({
      ...(args.environment !== undefined ? { environment: args.environment } : {}),
      ...(args.context !== undefined ? { context: args.context } : {}),
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    });

    const applied: AppliedRef[] = [];
    for (const document of documents) {
      const stamped = stampOwnership(document as K8sObject, stack);
      let result: K8sObject;
      try {
        result = await client.apply(stamped, {
          fieldManager,
          force: args.force ?? false,
          dryRun: args.dryRun,
          signal,
        });
      } catch (err) {
        // "chant never forces a conflict on its own" is about taking fields
        // from ANOTHER tool. A conflict where every contested field is owned
        // by another `chant:*` manager is chant contesting itself — the
        // ownership-stack → unit-stack label migration, or a renamed deploy
        // unit — and refusing that forever would strand every estate applied
        // before the rename with no non-force path back. Retake those fields
        // deliberately, once, and only when no foreign manager is involved.
        if (!isChantSelfConflict(err)) throw err;
        result = await client.apply(stamped, { fieldManager, force: true, dryRun: args.dryRun, signal });
      }
      const ref: AppliedRef = {
        apiVersion: String(result.apiVersion ?? document.apiVersion ?? ""),
        kind: String(result.kind ?? document.kind ?? ""),
        name: String(result.metadata?.name ?? ""),
        ...(result.metadata?.namespace !== undefined
          ? { namespace: String(result.metadata.namespace) }
          : {}),
      };
      applied.push(ref);
      safeHeartbeat({
        step: "kubectl apply",
        manifest: args.manifest,
        applied: `${ref.kind}/${ref.name}`,
      });
      console.log(`${ref.apiVersion} ${ref.kind}/${ref.name} applied${args.dryRun ? " (dry run — nothing persisted)" : ""}`);
    }

    const deleteMode = args.deleteMode ?? "never";
    const pruned =
      deleteMode === "never" || args.dryRun
        ? []
        : await pruneOrphans(client, applied, {
            ...(stack !== undefined ? { stack } : {}),
            signal,
          });

    return { fieldManager, applied, pruned };
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/**
 * Apply every document in `args.manifest`.
 * Uses longInfra profile — 20m timeout, heartbeat every 15s.
 */
export async function kubectlApply(
  args: KubectlApplyArgs,
  signal?: AbortSignal,
  connect: K8sConnector = defaultK8sConnector,
): Promise<void> {
  await applyManifest(args, signal, connect);
}

/**
 * Delete chant-owned objects that the apply set no longer declares.
 *
 * This replaces `kubectl apply --prune --selector <marker>=chant`, and keeps
 * its two safety properties exactly:
 *
 * - **Marker-scoped.** Only objects carrying chant's managed-by label are
 *   candidates; the label selector is sent to the server, and the marker is
 *   re-checked on every object before it is deleted. An unmarked resource is
 *   never a candidate, so a hand-made object in the same namespace is safe.
 * - **Namespace-scoped to the apply.** Namespaced kinds are swept only in the
 *   namespaces the apply set touched (the context's default namespace when it
 *   named none), which is what kubectl's prune does. A manifest that mentions
 *   `prod` never reaches into `staging`. Whether a kind *is* namespaced comes
 *   from the cluster's own discovery, never from whether a document happened
 *   to name a namespace — guessing that wrong is the one way this could widen
 *   into a cluster-wide sweep.
 *
 * Which *kinds* get swept is the union of the kinds the apply set contains and
 * chant's default sweep set (`DEFAULT_IMPORT_TYPES` — the same list `chant
 * import` uses when nothing narrows it). The union matters: a kind removed
 * from source entirely appears nowhere in the apply set, and pruning only what
 * is still declared would leave it behind forever. Per-namespace lists rather
 * than one cluster-wide list per kind, so a namespace-scoped service account
 * can still prune.
 */
async function pruneOrphans(
  client: K8sClient,
  applied: readonly AppliedRef[],
  options: { stack?: string; signal?: AbortSignal },
): Promise<AppliedRef[]> {
  const stack = options.stack;
  const selector = [
    `${LABEL_OWNERSHIP_KEYS.managedBy}=${OWNERSHIP_MANAGED_BY_VALUE}`,
    ...(stack ? [`${LABEL_OWNERSHIP_KEYS.stack}=${stack}`] : []),
  ].join(",");

  const namespaces = [...new Set(applied.map((a) => a.namespace).filter((n): n is string => !!n))];
  if (namespaces.length === 0 && applied.length > 0) namespaces.push(client.defaultNamespace);
  const declared = new Set(applied.map(refKey));

  // Every kind that could hold an orphan: the apply set's own, plus the
  // default sweep set so a kind deleted from source entirely is still reached.
  const sweeps = new Map<string, { apiVersion: string; kind: string }>();
  for (const entityType of DEFAULT_IMPORT_TYPES) {
    const operation = operationFor(entityType);
    if (!operation) continue;
    sweeps.set(`${operation.apiVersion}/${operation.kind}`, {
      apiVersion: operation.apiVersion,
      kind: operation.kind,
    });
  }
  for (const ref of applied) {
    if (!ref.apiVersion || !ref.kind) continue;
    sweeps.set(`${ref.apiVersion}/${ref.kind}`, { apiVersion: ref.apiVersion, kind: ref.kind });
  }

  // (kind, namespace) pairs to list. Scope comes from the cluster's discovery,
  // which is the only thing that knows it for the version this cluster serves;
  // a kind discovery does not report is dropped rather than swept blindly.
  const resolved = await client.concurrently([...sweeps.values()], async (sweep) => {
    const info = await client
      .resolve({ apiVersion: sweep.apiVersion, kind: sweep.kind }, options.signal)
      .catch(() => undefined);
    return info ? { ...sweep, namespaced: info.namespaced } : undefined;
  });

  const targets: Array<{ apiVersion: string; kind: string; namespace?: string }> = [];
  for (const sweep of resolved) {
    if (!sweep) continue;
    if (!sweep.namespaced) {
      targets.push({ apiVersion: sweep.apiVersion, kind: sweep.kind });
      continue;
    }
    for (const namespace of namespaces) {
      targets.push({ apiVersion: sweep.apiVersion, kind: sweep.kind, namespace });
    }
  }

  const found = await client.concurrently(targets, async (target) => {
    try {
      const items = await client.list(
        { apiVersion: target.apiVersion, kind: target.kind },
        {
          labelSelector: selector,
          ...(target.namespace !== undefined ? { namespace: target.namespace } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      return items.map((item) => ({ target, item }));
    } catch {
      // Kind not served here, or the read was denied. Neither is evidence that
      // something should be deleted, so the sweep skips it rather than failing
      // the apply that already succeeded.
      return [];
    }
  });

  const candidates: AppliedRef[] = [];
  const seen = new Set<string>();
  for (const { target, item } of found.flat()) {
    const name = item.metadata?.name;
    if (!name) continue;
    // The server filtered by label already; this re-check is the one that
    // matters, because a delete is not undoable.
    if (!hasOwnershipMarker(item.metadata?.labels, LABEL_OWNERSHIP_KEYS)) continue;
    // Already terminating — deleting again is noise, not progress.
    if (item.metadata?.deletionTimestamp !== undefined) continue;
    const ref: AppliedRef = {
      apiVersion: target.apiVersion,
      kind: target.kind,
      name,
      ...(item.metadata?.namespace !== undefined ? { namespace: item.metadata.namespace } : {}),
    };
    const key = refKey(ref);
    if (declared.has(key) || seen.has(key)) continue;
    seen.add(key);
    candidates.push(ref);
  }

  const pruned: AppliedRef[] = [];
  for (const ref of candidates) {
    await client.delete(ref, { ...(options.signal ? { signal: options.signal } : {}) });
    pruned.push(ref);
    safeHeartbeat({ step: "prune", pruned: `${ref.kind}/${ref.name}` });
    console.log(`${ref.apiVersion} ${ref.kind}/${ref.name} pruned (chant-owned, no longer declared)`);
  }
  return pruned;
}

function refKey(ref: AppliedRef): string {
  return `${ref.apiVersion}/${ref.kind}/${ref.namespace ?? ""}/${ref.name}`;
}
