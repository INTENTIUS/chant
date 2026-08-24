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
 * resolve, this sweeps candidate kinds in the namespaces they actually live in
 * and walks each object's `ownerReferences` chain (`./api/owner-chain.ts`)
 * against the entities this very call resolved. A chain reaching one of them
 * is reported with `ownerChain: { root: "declared", ... }`; core's
 * diff/change-set engine reads that as `runtime` instead of `orphan`.
 *
 * Which kinds are candidates is the cluster's own API discovery's answer
 * (#1517): every listable kind it serves, one version per group. The sweep's
 * bound is the namespaces the declared estate touches, never a kind table —
 * see `addRuntimeChildren`.
 */

import type { ObservationResult, ResourceMetadata, UnobservedEntity, UnobservedReason } from "@intentius/chant/lexicon";
import { observation, unobservedAll } from "@intentius/chant/observation";
import { hasOwnershipMarker, classifyOwnership, readOwnership, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
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

  // The kstatus rung (#1549): an object with NO phase and NO replica counts —
  // a Flux Kustomization/HelmRelease, cert-manager, any conditions-first CRD —
  // used to fall straight to PRESENT, so a wedged reconciler read exactly like
  // a healthy one. `Ready` is the contract those objects speak: False → its
  // reason (`BuildFailed`, `UpgradeFailed`, …), True → READY. Deliberately
  // BELOW the phase/replica rungs so no Pod or workload word changes — for
  // those objects a False Ready is already visible through the rungs above.
  const ready = readyConditionWord(status);
  if (ready) return ready;

  // Argo's Application speaks health/sync, not a Ready condition (the same
  // split the readiness registry encodes) — `Degraded` / `OutOfSync` beats
  // PRESENT for the one object whose whole job is convergence.
  const argo = argoStatusWord(status);
  if (argo) return argo;

  return "PRESENT";
}

/** The `Ready` condition rendered as a status word: False → its reason (or
 * NOT-READY when the controller gave none), True → READY, absent → nothing. */
function readyConditionWord(status: K8sObject["status"]): string | undefined {
  const conditions = (status as { conditions?: unknown } | undefined)?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  for (const c of conditions) {
    const cond = c as { type?: unknown; status?: unknown; reason?: unknown };
    if (cond.type !== "Ready") continue;
    if (cond.status === "True") return "READY";
    if (cond.status === "False") {
      return typeof cond.reason === "string" && cond.reason.length > 0 ? cond.reason : "NOT-READY";
    }
  }
  return undefined;
}

/** Argo Application health/sync as a status word: anything but the happy pair
 * surfaces the unhappy half; Healthy+Synced reads as READY. */
function argoStatusWord(status: K8sObject["status"]): string | undefined {
  const s = status as { health?: { status?: unknown }; sync?: { status?: unknown } } | undefined;
  const health = typeof s?.health?.status === "string" ? s.health.status : undefined;
  const sync = typeof s?.sync?.status === "string" ? s.sync.status : undefined;
  if (!health && !sync) return undefined;
  if (health && health !== "Healthy") return health;
  if (sync && sync !== "Synced") return sync;
  return "READY";
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
    if (typeof cond.type !== "string") continue;
    if (typeof cond.status === "string") {
      const goodWhenFalse = CONDITIONS_GOOD_WHEN_FALSE.test(cond.type);
      const happy = goodWhenFalse ? cond.status === "False" : cond.status === "True";
      if (happy) continue;
    } else if (!(typeof cond.message === "string" && cond.message)) {
      // No status, no message: nothing to say. But a status-less condition
      // WITH a message is an object speaking — Argo's ApplicationCondition is
      // `{type, message, lastTransitionTime}`, written only for problems, and
      // the polarity test above has nothing to read on it (#1644).
      continue;
    }
    const reason = typeof cond.reason === "string" && cond.reason ? `=${cond.reason}` : "";
    const message = typeof cond.message === "string" && cond.message ? `: ${cond.message}` : "";
    out.push(`${cond.type}${reason}${message}`);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The revisions a GitOps controller writes onto its own object (#1632).
 *
 * Conditions lag. A Flux Kustomization mid-rollout still reports the previous
 * reconcile's `Ready=True` for as long as the new one takes, so a consumer
 * reading only conditions calls a half-applied estate converged. The
 * controller's own definition of converged is a revision comparison:
 * `lastAppliedRevision` against `lastAttemptedRevision` on the same object
 * (attempted-but-not-applied is in flight), and a Kustomization's
 * `lastAppliedRevision` against its source's `artifact.revision` (the
 * cross-object half, which a consumer joins once both ends are on the wire).
 * None of the three reached an observed entity's attributes before this.
 *
 * Read by path rather than by kind, which is the module's standing rule
 * everywhere else: `status.lastAppliedRevision` / `status.lastAttemptedRevision`
 * are what kustomize-controller and helm-controller write, and
 * `status.artifact.revision` is what every source kind (GitRepository,
 * OCIRepository, Bucket, HelmChart) writes. An object that has none of them —
 * every non-GitOps kind — contributes nothing, so no kind table has to name
 * which kinds those are, and a CRD speaking the same convention is carried for
 * free. `artifactRevision` flattens the one nested path so every revision on
 * the wire is a plain string next to the others.
 */
export function revisionAttributes(obj: K8sObject): {
  lastAppliedRevision?: string;
  lastAttemptedRevision?: string;
  artifactRevision?: string;
} {
  const status = obj.status as
    | { lastAppliedRevision?: unknown; lastAttemptedRevision?: unknown; artifact?: { revision?: unknown } }
    | undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    lastAppliedRevision: str(status?.lastAppliedRevision),
    lastAttemptedRevision: str(status?.lastAttemptedRevision),
    artifactRevision: str(status?.artifact?.revision),
  };
}

/**
 * The declared repository protocol of a Flux HelmRepository (behold#298).
 *
 * A HelmRepository with `spec.type: oci` is never reconciled by
 * source-controller — no conditions, no artifact, by design — so a consumer
 * classifying health off conditions reads a healthy OCI repository exactly
 * like one whose controller has not shown up. `spec.type` is the field that
 * separates the two, and no spec field reached the wire before this. It rides
 * the attributes flattened, as `type`, the same way `artifactRevision`
 * flattens `status.artifact.revision`: every scalar on the wire is a plain
 * key next to the others, and the wire stays lean — one field, not the spec.
 *
 * Kind-gated, unlike the module's usual read-by-path rule, because the PATH
 * is not distinctive: a core Service's `spec.type` is
 * `ClusterIP`/`LoadBalancer`, and forwarding that would change the wire shape
 * of a kind this was never about. Only source.toolkit.fluxcd.io's
 * HelmRepository speaks this meaning of the field.
 */
export function helmRepositoryTypeAttribute(
  gvk: { apiVersion: string; kind: string },
  obj: K8sObject,
): string | undefined {
  if (gvk.kind !== "HelmRepository" || !gvk.apiVersion.startsWith("source.toolkit.fluxcd.io/")) return undefined;
  const type = (obj.spec as { type?: unknown } | undefined)?.type;
  return typeof type === "string" && type.length > 0 ? type : undefined;
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
  /**
   * Namespace to read a namespaced entity from when it declares none (#1629).
   *
   * A GitOps estate splits the binding from the objects: the control-plane
   * project declares a Kustomization with `spec.targetNamespace: app-b`, the
   * app project declares bare Deployments and Services with no
   * `metadata.namespace` at all — the controller stamps it at apply time. The
   * live read of the app project had no way to be told that, so it fell
   * through to the client's `default` and reported an estate that is running
   * as entirely absent (#1620's `queried` line is what made that visible).
   *
   * A DEFAULT, never a rewrite: an entity with an explicit
   * `metadata.namespace` reads from the namespace it declares, override or
   * not — that declaration is the estate's own statement of where the object
   * lives, and overruling it would make the option a way to read the wrong
   * object rather than the right one. Cluster-scoped kinds are untouched:
   * they have no namespace to default.
   */
  namespace?: string;
}

export async function describeResources(
  options: DescribeResourcesOptions,
  connect: K8sConnector = defaultK8sConnector,
): Promise<ObservationResult> {
  const resources: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  // The resolved query address per declared entity (#1620) — the exact request
  // path each read was issued against, with the namespace the client actually
  // defaulted to when the declaration carries none. This is what lets an
  // absence explain itself: a Flux-deployed object declaring no
  // metadata.namespace reads from `default`, correctly comes back 404, and
  // without the address the report says "not there" when the truth is "not
  // looked for where it lives".
  const queried: Record<string, string> = {};

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

    // The declared namespace wins; the caller's override only fills the hole a
    // declaration left, and only for a kind that HAS a namespace (#1629). With
    // neither, the client defaults to `default` exactly as it did.
    const namespace =
      metadata?.namespace ?? (operation.scope === "Namespaced" ? options.namespace : undefined);

    const ref = {
      apiVersion: operation.apiVersion,
      kind: operation.kind,
      name,
      ...(namespace ? { namespace } : {}),
    };

    // Resolve the address BEFORE the read, so every verdict below — present,
    // absent, filtered, read-failed — carries the same record of what was
    // asked. Resolution rides the client's cached discovery; a kind discovery
    // does not serve has no path, and a resolution failure classifies through
    // the read below, never here.
    try {
      const address = typeof client.pathFor === "function" ? await client.pathFor(ref) : undefined;
      if (address) queried[entityName] = address;
    } catch {
      // The read below hits the same resolution and classifies its failure.
    }

    try {
      const obj = await client.read(ref);

      // owned filter: withhold resources not carrying chant's marker label.
      // Withheld is not absent (chant #1089) — this object exists, it just
      // isn't chant's, and dropping it silently is how `--owned` used to turn a
      // declared-but-foreign resource into a proposed `create`.
      if (options.owned && !hasOwnershipMarker(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: "live object carries no chant ownership marker and --owned was requested",
          ...(queried[entityName] ? { queried: queried[entityName] } : {}),
        };
        return;
      }

      resources[entityName] = {
        type: entityType,
        physicalId: obj.metadata?.uid,
        status: statusFromObject(obj),
        lastUpdated: obj.metadata?.creationTimestamp,
        ownership: classifyOwnership(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        // Marker identity (#1222): the stack/env labels stamped at synthesis,
        // read back verbatim. Undefined when the managed-by label is absent.
        marker: readOwnership(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        attributes: pruneUndefined({
          namespace: obj.metadata?.namespace,
          labels: obj.metadata?.labels,
          resourceVersion: obj.metadata?.resourceVersion,
          // What the object's own controller says is wrong with it (#1401).
          conditions: unhappyConditions(obj),
          // What a GitOps controller says it has applied and is applying
          // (#1632) — the convergence signal conditions cannot carry.
          ...revisionAttributes(obj),
          // A HelmRepository's spec.type — `oci` means "no conditions is
          // healthy", and only this field can say so (behold#298).
          type: helmRepositoryTypeAttribute(operation, obj),
        }),
      };
    } catch (err) {
      const outcome = classifyApiFailure(err);
      if (outcome.kind === "unobserved") {
        unobserved[entityName] = {
          type: entityType,
          reason: outcome.reason,
          detail: outcome.detail,
          ...(queried[entityName] ? { queried: queried[entityName] } : {}),
        };
      }
      // `absent` deliberately records nothing: in neither map is how the
      // contract spells "asked, and it is not there". Its address stays in
      // `queried` (#1620), which is the only record an absence gets.
    }
  });

  await addRuntimeChildren(client, resources, unobserved, options.owned, declared);

  return observation(resources, unobserved, queried);
}

/**
 * Sweep runtime-child candidates in the namespaces of entities this call just
 * resolved, and classify each one's owner-reference chain (#1077). Mutates
 * `resources` in place, adding an entry per object whose chain was worth
 * reporting, and `unobserved` for the parts of the sweep that could not look.
 *
 * The candidate kinds are the cluster's own API discovery's answer (#1517):
 * every listable kind it serves, one version per group (the group's
 * preferredVersion, so nothing is listed twice at a second served version).
 * The first cut scoped this to Pods, the second to the estate's own declared
 * API groups — and both missed exactly where the runtime tier says the most:
 * an operator's children are whatever kinds its controllers make (a
 * MicroVMReplicaSet's MicroVMs, a CR's Deployments in a group the estate
 * never declares), which no kind table can anticipate. The same open-world
 * inversion behold#74 made for declared CRDs, applied to the runtime axis.
 *
 * What bounds the sweep is not a kind list but reach:
 *  - **Namespaced kinds** are listed only in the namespaces the declared
 *    estate touches (where its entities resolved, plus the namespaces its
 *    GitOps CRs target) — owner references cannot cross a namespace, so a
 *    child elsewhere could never chain to this estate anyway.
 *  - **Cluster-scoped kinds** are listed only when the estate resolved a
 *    cluster-scoped entity — a cluster-scoped object's owners are themselves
 *    cluster-scoped (Kubernetes' own GC rule), so without one declared there
 *    is nothing such a chain could reach.
 *  - **It is not an inventory**: outside Pods (whose chain verdicts, foreign
 *    included, are #1077's original contract), a swept object is only
 *    reported when its chain resolves to a declared entity.
 *
 * Tri-state honesty (#1089, extended to the sweep): a kind discovery names
 * but the sweep cannot list — RBAC denial, a flaking apiserver — becomes a
 * `runtime-sweep:*` entry in `unobserved`, never a silent gap. Silence would
 * read as "no runtime children there", which the failed list never proved.
 * A list 404 (the kind vanished between discovery and the list) stays an
 * absence, per `classifyApiFailure`'s standing rule. Declared-entity
 * resolution is never failed by the sweep.
 */
/** The declared GitOps CRs, indexed the way their controllers' labels can be
 * resolved (#1549). `byRef` keys are `type\0namespace\0name` (Flux — exact);
 * `argoByName` maps an Application's name to its declared entity, or null
 * when two declared Applications share the name (ambiguous → no claim). */
interface GitopsIndex {
  present: boolean;
  byRef: Map<string, string>;
  argoByName: Map<string, string | null>;
  targetNamespaces: Set<string>;
}

function gitopsIndex(declared: readonly Declared[]): GitopsIndex {
  const byRef = new Map<string, string>();
  const argoByName = new Map<string, string | null>();
  const targetNamespaces = new Set<string>();
  let present = false;
  for (const { entityName, entityType, props } of declared) {
    const isArgo = entityType === "K8s::Argo::Application";
    const isFlux = entityType === "K8s::Flux::Kustomization" || entityType === "K8s::Flux::HelmRelease";
    if (!isArgo && !isFlux) continue;
    present = true;
    const meta = props.metadata as { name?: string; namespace?: string } | undefined;
    const spec = props.spec as { targetNamespace?: unknown; destination?: { namespace?: unknown } } | undefined;
    const name = meta?.name;
    if (!name) continue;
    if (isFlux) {
      byRef.set(`${entityType}\0${meta?.namespace ?? "default"}\0${name}`, entityName);
      if (typeof spec?.targetNamespace === "string") targetNamespaces.add(spec.targetNamespace);
    } else {
      argoByName.set(name, argoByName.has(name) ? null : entityName);
      if (typeof spec?.destination?.namespace === "string") targetNamespaces.add(spec.destination.namespace);
    }
  }
  return { present, byRef, argoByName, targetNamespaces };
}

/** The declared GitOps CR a swept object's controller labels resolve to, or
 * undefined. Flux's label pairs are exact; Argo's bare instance label claims
 * only a UNIQUE declared Application. */
function gitopsOwner(labels: Record<string, string> | undefined, gitops: GitopsIndex): string | undefined {
  if (!labels || !gitops.present) return undefined;
  const ksName = labels["kustomize.toolkit.fluxcd.io/name"];
  const ksNs = labels["kustomize.toolkit.fluxcd.io/namespace"];
  if (ksName && ksNs) {
    const hit = gitops.byRef.get(`K8s::Flux::Kustomization\0${ksNs}\0${ksName}`);
    if (hit) return hit;
  }
  const hrName = labels["helm.toolkit.fluxcd.io/name"];
  const hrNs = labels["helm.toolkit.fluxcd.io/namespace"];
  if (hrName && hrNs) {
    const hit = gitops.byRef.get(`K8s::Flux::HelmRelease\0${hrNs}\0${hrName}`);
    if (hit) return hit;
  }
  const instance = labels["app.kubernetes.io/instance"];
  if (instance) {
    const hit = gitops.argoByName.get(instance);
    if (hit) return hit; // null (ambiguous) and undefined both decline
  }
  return undefined;
}

/** One candidate kind of the discovery-driven sweep. */
interface SweptKind {
  apiVersion: string;
  kind: string;
  typeName: string;
}

/**
 * Kinds the sweep skips even though discovery serves them. Not a kind table
 * creeping back in: each entry is a kind that CANNOT attribute to a declared
 * owner — an Event names its subject via `involvedObject`, never
 * `ownerReferences` — and churns by the thousands in any active namespace,
 * so listing it can only cost and never attach.
 */
function isSweepNoise(info: { kind: string; group: string }): boolean {
  return info.kind === "Event" && (info.group === "" || info.group === "events.k8s.io");
}

async function addRuntimeChildren(
  client: K8sClient,
  resources: Record<string, ResourceMetadata>,
  unobserved: Record<string, UnobservedEntity>,
  owned: boolean | undefined,
  declared: readonly Declared[] = [],
): Promise<void> {
  const declaredByUid = new Map<string, string>();
  for (const [entityName, meta] of Object.entries(resources)) {
    if (meta.physicalId) declaredByUid.set(meta.physicalId, entityName);
  }

  // GitOps attribution (#1549): Argo and Flux stamp their managed objects with
  // labels, not ownerReferences, so the chain walk never reaches a declared
  // entity for them. The label channel resolves against the DECLARED CRs by
  // (type, namespace, name) — exact for Flux (its labels carry both halves) —
  // and by unique name for Argo (its instance label carries no namespace, and
  // it doubles as a generic Helm label, so anything ambiguous resolves to
  // nothing: the module's standing conservatism).
  const gitops = gitopsIndex(declared);

  const namespaces = new Set<string>();
  let clusterScopedDeclared = false;
  for (const meta of Object.values(resources)) {
    const namespace = (meta.attributes as { namespace?: string } | undefined)?.namespace;
    if (namespace) namespaces.add(namespace);
    else clusterScopedDeclared = true;
  }
  // The namespaces a declared GitOps CR TARGETS are declared literals too
  // (Argo `spec.destination.namespace`, Flux `spec.targetNamespace`) — the
  // controller puts the workloads there, so the scan must look there, and
  // reading it off the declaration keeps this bounded by the estate, never a
  // cluster-wide sweep.
  for (const ns of gitops.targetNamespaces) namespaces.add(ns);
  if (namespaces.size === 0 && !clusterScopedDeclared) return;

  // Every kind the cluster serves, from its own discovery (#1517): one
  // groupVersion per group, every listable kind, split by scope. Failing to
  // enumerate is a hole the observation must admit — silently sweeping
  // nothing would read as "no runtime children", which was never established.
  let groupVersions: string[];
  try {
    groupVersions = await client.preferredGroupVersions();
  } catch (err) {
    const outcome = classifyApiFailure(err);
    unobserved["runtime-sweep"] = {
      reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
      detail:
        "cluster API discovery failed, so runtime children were not swept" +
        (outcome.kind === "unobserved" ? `: ${outcome.detail}` : ""),
    };
    return;
  }

  const perGroup = await client.concurrently(groupVersions, async (gv) => {
    try {
      return await client.resources(gv);
    } catch (err) {
      const outcome = classifyApiFailure(err);
      if (outcome.kind === "unobserved") {
        unobserved[`runtime-sweep:${gv}`] = {
          reason: outcome.reason,
          detail: `discovery for ${gv} failed, so its kinds were not swept: ${outcome.detail}`,
        };
      }
      return [];
    }
  });

  const namespacedKinds: SweptKind[] = [];
  const clusterKinds: SweptKind[] = [];
  for (const infos of perGroup) {
    for (const info of infos) {
      if (!info.verbs.includes("list") || isSweepNoise(info)) continue;
      const swept: SweptKind = {
        apiVersion: info.apiVersion,
        kind: info.kind,
        typeName: gvkToTypeName({ group: info.group, version: info.version, kind: info.kind }),
      };
      (info.namespaced ? namespacedKinds : clusterKinds).push(swept);
    }
  }

  // A failed list is recorded once per kind, naming every scope it failed in,
  // rather than once per (kind, namespace) — one RBAC rule denying a kind
  // across N namespaces is one hole, not N.
  const listFailures = new Map<
    string,
    { typeName: string; reason: UnobservedReason; scopes: string[]; detail: string }
  >();

  const sweep = async (swept: SweptKind, namespace: string | undefined): Promise<void> => {
    let objects: K8sObject[];
    try {
      objects = await client.list(
        { apiVersion: swept.apiVersion, kind: swept.kind },
        namespace ? { namespace } : {},
      );
    } catch (err) {
      const outcome = classifyApiFailure(err);
      // `absent` (a list 404: the kind vanished between discovery and now)
      // proves no instance exists — nothing to record.
      if (outcome.kind === "unobserved") {
        const key = `runtime-sweep:${swept.apiVersion}/${swept.kind}`;
        const scope = namespace ? `namespace ${namespace}` : "cluster scope";
        const failure = listFailures.get(key);
        if (failure) failure.scopes.push(scope);
        else listFailures.set(key, { typeName: swept.typeName, reason: outcome.reason, scopes: [scope], detail: outcome.detail });
      }
      return;
    }

    await client.concurrently(objects, async (obj) => {
      const uid = obj.metadata?.uid;
      const name = obj.metadata?.name;
      if (!uid || !name || declaredByUid.has(uid)) return; // declared directly, or unaddressable
      // The kind is part of the identity: a Deployment, Service and Endpoints
      // all named `app-a` in namespace `app-a` are three objects, and a
      // kind-less key reported only whichever kind swept first (#1643).
      const key = namespace ? `${swept.kind}/${namespace}/${name}` : `cluster:${swept.kind}/${name}`;
      if (resources[key]) return; // re-swept object, not a new report

      let ownerChain = await resolveK8sOwnerChain(obj, { declaredByUid, reader: client, namespace });
      // The label channel (#1549) — only when the chain itself said nothing:
      // a verdict the walk DID reach is never overridden.
      if (ownerChain.root !== "declared") {
        const entity = gitopsOwner(obj.metadata?.labels, gitops);
        if (entity) ownerChain = { root: "declared", entity };
      }

      // `--owned`: withhold an object that is neither a runtime child of a
      // declared entity nor carrying chant's own marker — the same rule the
      // declared-entity read above applies, extended to the undeclared axis
      // this scan introduces.
      const marker = hasOwnershipMarker(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS);
      if (owned && ownerChain.root !== "declared" && !marker) return;

      // An undeclared object with NO owner chain at all is not a runtime
      // child — reporting every loose object the cluster serves would turn
      // the sweep into an inventory. Pods keep their pre-#1517 reporting
      // (their chain verdicts, including foreign, were already part of
      // #1077's contract); every other swept kind only reports when the
      // chain reaches a declared entity.
      if (swept.kind !== "Pod" && ownerChain.root !== "declared") return;

      resources[key] = {
        type: swept.typeName,
        physicalId: uid,
        status: statusFromObject(obj),
        lastUpdated: obj.metadata?.creationTimestamp,
        ownership: classifyOwnership(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        // Marker identity (#1222), same rule as the declared-entity read above.
        marker: readOwnership(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        ownerChain,
        attributes: pruneUndefined({
          namespace,
          labels: obj.metadata?.labels,
          resourceVersion: obj.metadata?.resourceVersion,
          conditions: unhappyConditions(obj),
          // The same one spec field the declared read forwards (behold#298):
          // a swept HelmRepository (Flux's own bootstrap manages them through
          // a Kustomization) must not read differently from a declared one.
          type: helmRepositoryTypeAttribute(swept, obj),
        }),
      };
    });
  };

  await client.concurrently([...namespaces], async (namespace) => {
    for (const swept of namespacedKinds) await sweep(swept, namespace);
  });

  // Cluster-scoped kinds are swept once (their lists are cluster-wide by
  // nature), and only when a declared cluster-scoped entity exists for a
  // chain to reach — a cluster-scoped object's owners are cluster-scoped.
  if (clusterScopedDeclared) {
    await client.concurrently(clusterKinds, async (swept) => sweep(swept, undefined));
  }

  for (const [key, failure] of listFailures) {
    unobserved[key] = {
      type: failure.typeName,
      reason: failure.reason,
      detail: `the runtime-children sweep could not list this kind in ${failure.scopes.join(", ")}: ${failure.detail}`,
    };
  }
}
