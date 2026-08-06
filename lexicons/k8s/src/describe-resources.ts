/**
 * Live introspection of a Kubernetes cluster — implements the
 * LexiconPlugin.describeResources() contract for the k8s lexicon.
 *
 * ## What changed, and why it matters (chant #1074)
 *
 * This used to run `kubectl get <kind> <name> -o json` once per declared
 * entity, serially, resolved through a hardcoded twenty-entry
 * `KUBECTL_RESOURCE` map. Every CRD and every uncommon type fell off the end
 * of that map and came back as a hole. Coverage, concurrency and error quality
 * were all capped by it, and `lifecycle diff --live`, `lifecycle plan` and
 * behold's overlay inherited the cap.
 *
 * Now:
 *
 * - **Coverage.** An entity type becomes an API address through the generated
 *   operation surface (`./api/operation-surface.ts`), which the same codegen
 *   pass that emits the declarable classes writes — 184 types rather than 20,
 *   CRDs included. The address is then confirmed against the cluster's *own*
 *   discovery, which is what knows the plural and the scope for the version
 *   that cluster actually serves.
 * - **Concurrency.** Reads run through the client's bounded pool. A hundred
 *   entities are a hundred concurrent HTTP GETs sharing one connection and one
 *   cached credential, not a hundred serial process spawns.
 * - **Error quality.** Failures arrive as typed errors carrying the API
 *   server's own `code` and `reason`, so the tri-state verdict is read off a
 *   field instead of matched against English on stderr.
 *
 * ## What did not change
 *
 * The observation tri-state (chant #1089) and the cluster binding (chant
 * #1100/#1155) are the same contracts they were. A genuine `NotFound` — and a
 * kind the cluster's discovery does not serve, where no instance can exist —
 * is an absence, and only an absence becomes a `create`. Everything else is
 * NOT-OBSERVED with a reason. A declared `k8s.profiles.<env>.context` that
 * disagrees with the ambient one still refuses before a single resource is
 * touched, via the same `resolveClusterTarget` the GCP lexicon shares.
 *
 * ## Runtime children (chant #1077)
 *
 * A Pod a declared Deployment's controller created is live and undeclared —
 * exactly the shape `lifecycle diff --live` has always classified `orphan`.
 * On Kubernetes that is wrong: it is expected runtime, not drift, and will be
 * recreated the moment it is deleted. After the declared-entity reads above
 * resolve, this scans Pods in the namespaces they actually live in and walks
 * each one's `ownerReferences` chain (`./api/owner-chain.ts`) against the
 * entities this very call resolved. A chain reaching one of them is reported
 * with `ownerChain: { root: "declared", ... }`; core's diff/change-set engine
 * reads that as `runtime` instead of `orphan`. Deliberately scoped to Pods —
 * the concrete case the issue and its acceptance criteria name — and to the
 * namespaces this observation already touched, not a cluster-wide sweep;
 * widening to other controller-spawned kinds is the same walk repeated.
 */

import type { ObservationResult, ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import { observation, unobservedAll } from "@intentius/chant/observation";
import { hasOwnershipMarker, classifyOwnership, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import type { K8sClient, K8sObject } from "@intentius/chant-k8s-client";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import {
  classifyApiFailure,
  isMissingClientPackage,
  isWholeLexiconFailure,
  MISSING_CLIENT_DETAIL,
} from "./api/classify";
import { operationFor } from "./api/operation-surface";
import { resolveK8sOwnerChain } from "./api/owner-chain";
import { gvkToTypeName } from "./spec/parse";

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Collapse a live object to one status word. Unchanged from the kubectl path
 * — the shape of the response is the same JSON either way.
 */
export function statusFromObject(obj: K8sObject): string {
  const status = obj.status;

  // The most specific FAILING signal wins over the outermost one (#1397).
  //
  // A Pod's phase is `Running` from the moment the kubelet admits it and one
  // container starts — so a crashlooping Pod reported `Running`, which every
  // consumer classifying that word read as healthy. The failure lives one level
  // down, in `containerStatuses[].state.waiting.reason`, and never reached the
  // wire, so nothing downstream could recover it.
  const waiting = failingContainerReason(status);
  if (waiting) return waiting;

  // Scheduling failure is a condition, not a phase: an unschedulable Pod is
  // `Pending`, which is true and useless next to `Unschedulable`.
  const blocked = failingConditionReason(status);
  if (blocked) return blocked;

  const phase = status?.phase;
  if (typeof phase === "string") return phase;
  if (status && typeof status.readyReplicas === "number" && typeof status.replicas === "number") {
    return status.readyReplicas === status.replicas
      ? "READY"
      : `PROGRESSING(${status.readyReplicas}/${status.replicas})`;
  }
  return "PRESENT";
}

/**
 * The reason a container is stuck, if one is — `CrashLoopBackOff`,
 * `ImagePullBackOff`, `CreateContainerConfigError`.
 *
 * Only a WAITING container counts. A terminated one may have exited cleanly as
 * part of a Job, and a running one is not stuck; neither should outrank the
 * phase.
 */
function failingContainerReason(status: K8sObject["status"]): string | undefined {
  const containers = (status as { containerStatuses?: unknown } | undefined)?.containerStatuses;
  if (!Array.isArray(containers)) return undefined;
  for (const c of containers) {
    const reason = (c as { state?: { waiting?: { reason?: unknown } } })?.state?.waiting?.reason;
    // `ContainerCreating` and `PodInitializing` are ordinary startup, not
    // failure — they already classify as progressing, and promoting them over
    // the phase would just be noisier.
    if (typeof reason === "string" && reason.length > 0 && reason !== "ContainerCreating" && reason !== "PodInitializing") {
      return reason;
    }
  }
  return undefined;
}

/**
 * The reason a blocking condition is False — `Unschedulable` and the like.
 *
 * Only conditions whose truth means "this object is usable"; a False `Ready` on
 * its own is already visible through the phase and the container states above.
 */
function failingConditionReason(status: K8sObject["status"]): string | undefined {
  const conditions = (status as { conditions?: unknown } | undefined)?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  for (const c of conditions) {
    const cond = c as { type?: unknown; status?: unknown; reason?: unknown };
    if (cond.type !== "PodScheduled") continue;
    if (cond.status !== "False") continue;
    if (typeof cond.reason === "string" && cond.reason.length > 0) return cond.reason;
  }
  return undefined;
}


/**
 * The unhappy conditions on a live object, as `Type=Reason: message` (#1401).
 *
 * #1397 made the status WORD honest — a crashlooping Pod reports
 * `CrashLoopBackOff` rather than `Running`. This carries the part that says
 * what to do about it: `Unschedulable` is the reason, and
 * `0/3 nodes are available: 1 node(s) had untolerated taint` is the answer, and
 * only the first reached the wire.
 *
 * Only conditions that are NOT in their happy state are reported. A `Ready=True`
 * says nothing an operator needs and would bury the one line that does — and a
 * condition's happy polarity is per type: `Ready`/`Available`/`PodScheduled`
 * are good when True, while `Unschedulable`-style and the standard
 * `*Pressure`/`NetworkUnavailable` node conditions are good when False.
 *
 * Absent when everything is happy, so a consumer can treat presence as "this
 * object has something to say".
 */
const CONDITIONS_GOOD_WHEN_FALSE = /pressure$|^networkunavailable$|^unschedulable$|failed/i;

export function unhappyConditions(obj: K8sObject): string[] | undefined {
  const conditions = (obj.status as { conditions?: unknown } | undefined)?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  const out: string[] = [];
  for (const c of conditions) {
    const cond = c as { type?: unknown; status?: unknown; reason?: unknown; message?: unknown };
    if (typeof cond.type !== "string" || typeof cond.status !== "string") continue;
    const goodWhenFalse = CONDITIONS_GOOD_WHEN_FALSE.test(cond.type);
    const happy = goodWhenFalse ? cond.status === "False" : cond.status === "True";
    if (happy) continue;
    const reason = typeof cond.reason === "string" && cond.reason ? `=${cond.reason}` : "";
    const message = typeof cond.message === "string" && cond.message ? `: ${cond.message}` : "";
    out.push(`${cond.type}${reason}${message}`);
  }
  return out.length > 0 ? out : undefined;
}

interface Declared {
  entityName: string;
  entityType: string;
  props: Record<string, unknown>;
}

export interface DescribeResourcesOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  owned?: boolean;
  /** Directory whose `chant.config.ts` carries the cluster binding. Defaults to cwd. */
  cwd?: string;
}

export async function describeResources(
  options: DescribeResourcesOptions,
  connect: K8sConnector = defaultK8sConnector,
): Promise<ObservationResult> {
  const resources: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  const declared: Declared[] = [...options.entities].map(([entityName, entity]) => ({
    entityName,
    entityType: entity.entityType,
    props: entity.props,
  }));

  // Connect first. The binding check lives here, so a bound-but-mismatched
  // context throws before any resource is read — core turns that into
  // NOT-OBSERVED for every declared entity rather than an empty result.
  let client;
  try {
    ({ client } = await connect({ environment: options.environment, cwd: options.cwd }));
  } catch (err) {
    if (isMissingClientPackage(err)) {
      return observation(
        {},
        unobservedAll(
          declared.map((d) => d.entityName),
          "read-failed",
          MISSING_CLIENT_DETAIL,
          options.entities,
        ),
      );
    }
    if (isWholeLexiconFailure(err)) {
      const outcome = classifyApiFailure(err);
      return observation(
        {},
        unobservedAll(
          declared.map((d) => d.entityName),
          outcome.kind === "unobserved" ? outcome.reason : "read-failed",
          outcome.kind === "unobserved" ? outcome.detail : undefined,
          options.entities,
        ),
      );
    }
    // A cluster-binding mismatch (chant #1100) belongs here: it is a loud
    // refusal, and core's whole-lexicon handling is what turns it into an
    // honest hole per entity.
    throw err;
  }

  await client.concurrently(declared, async ({ entityName, entityType, props }) => {
    const operation = operationFor(entityType);
    if (!operation) {
      // chant knows no API address for this type at all — not even its group.
      // The object may well exist, so this is a hole, never an absence.
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `no generated operation surface for ${entityType} — run \`chant generate\` in the k8s lexicon, or declare the CRD as a codegen source`,
      };
      return;
    }

    const metadata = props.metadata as { name?: string; namespace?: string } | undefined;
    const name = metadata?.name;
    if (!name) {
      // Nothing to query by. Not an absence — chant never issued a read.
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: "declared entity has no metadata.name to query by",
      };
      return;
    }

    try {
      const obj = await client.read({
        apiVersion: operation.apiVersion,
        kind: operation.kind,
        name,
        ...(metadata?.namespace ? { namespace: metadata.namespace } : {}),
      });

      // owned filter: withhold resources not carrying chant's marker label.
      // Withheld is not absent (chant #1089) — this object exists, it just
      // isn't chant's, and dropping it silently is how `--owned` used to turn a
      // declared-but-foreign resource into a proposed `create`.
      if (options.owned && !hasOwnershipMarker(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: "live object carries no chant ownership marker and --owned was requested",
        };
        return;
      }

      resources[entityName] = {
        type: entityType,
        physicalId: obj.metadata?.uid,
        status: statusFromObject(obj),
        lastUpdated: obj.metadata?.creationTimestamp,
        ownership: classifyOwnership(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        attributes: pruneUndefined({
          namespace: obj.metadata?.namespace,
          labels: obj.metadata?.labels,
          resourceVersion: obj.metadata?.resourceVersion,
          // What the object's own controller says is wrong with it (#1401).
          conditions: unhappyConditions(obj),
        }),
      };
    } catch (err) {
      const outcome = classifyApiFailure(err);
      if (outcome.kind === "unobserved") {
        unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
      }
      // `absent` deliberately records nothing: in neither map is how the
      // contract spells "asked, and it is not there".
    }
  });

  // chant #1517 — the API groups this estate's own declarations use. A
  // controller's children usually live in its controller's group (a
  // MicroVMReplicaSet makes MicroVMs), so the runtime scan sweeps those
  // groupVersions' kinds besides Pods. Core (`v1`) is excluded from the group
  // sweep — Pods represent it; sweeping every core kind would walk endpoints
  // and events for nothing.
  const runtimeGroupVersions = new Set<string>();
  for (const { entityType } of declared) {
    const op = operationFor(entityType);
    if (op && op.apiVersion.includes("/")) runtimeGroupVersions.add(op.apiVersion);
  }

  await addRuntimeChildren(client, resources, options.owned, runtimeGroupVersions);

  return observation(resources, unobserved);
}

/**
 * Scan runtime-child candidates in the namespaces of entities this call just
 * resolved, and classify each one's owner-reference chain (#1077). Mutates
 * `resources` in place, adding an entry per object whose chain was worth
 * reporting.
 *
 * Two candidate pools:
 *  - **Pods** — the built-in workload leaf, always scanned.
 *  - **The estate's own API groups** (#1517) — every namespaced, listable
 *    kind in each `groupVersions` entry, from the cluster's own discovery.
 *    An operator estate's interesting children are custom resources its
 *    controllers made (a MicroVMReplicaSet's MicroVMs), which no kind table
 *    could anticipate — the same open-world inversion behold#74 made for
 *    declared CRDs, applied to the runtime axis. Bounded by what the estate
 *    declares, never a cluster-wide sweep.
 *
 * Best-effort and additive: a namespace or kind this scan cannot list (RBAC
 * denial, a transient error) is simply skipped rather than failing the
 * observation — these are not declared entities, so there is no NOT-OBSERVED
 * axis for them to report against, the same way an out-of-band AWS child
 * resource has none either.
 */
async function addRuntimeChildren(
  client: K8sClient,
  resources: Record<string, ResourceMetadata>,
  owned: boolean | undefined,
  groupVersions: ReadonlySet<string> = new Set(),
): Promise<void> {
  const declaredByUid = new Map<string, string>();
  for (const [entityName, meta] of Object.entries(resources)) {
    if (meta.physicalId) declaredByUid.set(meta.physicalId, entityName);
  }

  const namespaces = new Set<string>();
  for (const meta of Object.values(resources)) {
    const namespace = (meta.attributes as { namespace?: string } | undefined)?.namespace;
    if (namespace) namespaces.add(namespace);
  }
  if (namespaces.size === 0) return;

  // The kinds to scan: Pods, plus each declared groupVersion's namespaced,
  // listable kinds from discovery (#1517). A groupVersion the cluster does
  // not serve contributes nothing — an answer, not a failure.
  const kinds: Array<{ apiVersion: string; kind: string; typeName: string }> = [
    { apiVersion: "v1", kind: "Pod", typeName: "K8s::Core::Pod" },
  ];
  for (const gv of [...groupVersions].sort()) {
    let infos;
    try {
      infos = await client.resources(gv);
    } catch {
      continue; // best-effort — see the function doc
    }
    const [group, version] = [gv.slice(0, gv.indexOf("/")), gv.slice(gv.indexOf("/") + 1)];
    for (const info of infos) {
      if (!info.namespaced || !info.verbs.includes("list")) continue;
      kinds.push({ apiVersion: gv, kind: info.kind, typeName: gvkToTypeName({ group, version, kind: info.kind }) });
    }
  }

  await client.concurrently([...namespaces], async (namespace) => {
    for (const { apiVersion, kind, typeName } of kinds) {
      let objects: K8sObject[];
      try {
        objects = await client.list({ apiVersion, kind }, { namespace });
      } catch {
        continue; // best-effort — see the function doc
      }

      await client.concurrently(objects, async (obj) => {
        const uid = obj.metadata?.uid;
        const name = obj.metadata?.name;
        if (!uid || !name || declaredByUid.has(uid)) return; // declared directly, or unaddressable
        if (resources[`${namespace}/${name}`]) return; // already reported by an earlier kind

        const ownerChain = await resolveK8sOwnerChain(obj, { declaredByUid, reader: client, namespace });

        // `--owned`: withhold an object that is neither a runtime child of a
        // declared entity nor carrying chant's own marker — the same rule the
        // declared-entity read above applies, extended to the undeclared axis
        // this scan introduces.
        const marker = hasOwnershipMarker(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS);
        if (owned && ownerChain.root !== "declared" && !marker) return;

        // An undeclared object with NO owner chain at all is not a runtime
        // child — reporting every loose object a group serves would turn the
        // scan into an inventory. Pods keep their pre-#1517 reporting (their
        // chain verdicts, including foreign, were already part of #1077's
        // contract); swept group kinds only report when the chain reaches a
        // declared entity.
        if (kind !== "Pod" && ownerChain.root !== "declared") return;

        resources[`${namespace}/${name}`] = {
          type: typeName,
          physicalId: uid,
          status: statusFromObject(obj),
          lastUpdated: obj.metadata?.creationTimestamp,
          ownership: classifyOwnership(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS),
          ownerChain,
          attributes: pruneUndefined({
            namespace,
            labels: obj.metadata?.labels,
            resourceVersion: obj.metadata?.resourceVersion,
            conditions: unhappyConditions(obj),
          }),
        };
      });
    }
  });
}
