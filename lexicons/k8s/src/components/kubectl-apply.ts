/**
 * `kubectl-apply` — the Kubernetes apply leaf for the component model
 * (#1495 piece 2).
 *
 * The apply itself already exists: chant's server-side apply as the field
 * manager `chant:<stack>` with the marker-scoped owned-only prune (#1075),
 * reachable from Ops and from `ApplyOp({ target: "kubectl" })`. What was
 * missing is a *capability*, so a component whose deploy is a Kubernetes
 * manifest had nothing to compose but a `shell` step — and, downstream, no
 * deploy unit for `chant components status --live` to observe (the walk asks
 * the step's `stack`, and a shell step has none to name).
 *
 * `stack` doubles as both the ownership identity the apply stamps
 * (`chant:<stack>`, the prune selector) and the deploy unit the status walk
 * reads (core `components/deploy-units.ts`) — one name, both jobs, the same
 * pairing `cfn-deploy` has with its stack.
 *
 * ## Outputs (#3999)
 *
 * A manifest has no outputs of its own, so a step names the ones a
 * dependent reads: `outputs: { host: { object: "Service/prod/web", field:
 * "status.loadBalancer.ingress.0.hostname" } }`, each a field of an object
 * the manifest declares. `run` returns them as `outputs` once it applied,
 * which is what a dependent's `stackOutput()` reads, and `outputs` reads
 * them from the cluster without applying anything. A plan knows a field the
 * manifest sets, since the apply writes that value, and any field of an
 * object the plan leaves as it is; every other one is known only after
 * apply.
 */
import type { Capability, CapabilityPlan, DeployContext, PlannedOutputs } from "@intentius/chant/components/capability";
import type { ChangeSetAttribute, ChangeSetEntry, ChangeSetHole, ChangeSetPart } from "@intentius/chant/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { releaseAttributesSuffix } from "@intentius/chant/telemetry-attribution";
import { annotateRelease } from "../telemetry-release";
import { diffFields, normalizeServerObject } from "../op/activities/apply-diff";

/**
 * Structural mirrors of the activity module's argument/result shapes.
 *
 * Deliberately NOT imported from ../op/activities/kubectl — not even as
 * `import type`: the #1074 boundary test walks type-only imports too, and a
 * static reference here would put the API-client chain on the build path this
 * module is loaded from (the lexicon entry point). The applier is reached by
 * dynamic import inside run(), the same mechanism plugin.ts and the kube verb
 * modules use; TypeScript checks these shapes against the real ones at the
 * call site, so drift is a compile error there, not a silent mismatch.
 */
interface AppliedRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

/** What the apply did — the activity's own result shape. */
export interface KubectlApplyOutcome {
  /** The field manager every object was applied as. */
  fieldManager: string;
  applied: AppliedRef[];
  /** Objects deleted because they carried chant's marker and are no longer declared. */
  pruned: AppliedRef[];
  /**
   * Owned, undeclared, deliberately KEPT (#1830): generated-once Secrets never
   * enter the prunable set. Present whenever the prune ran.
   */
  retained?: AppliedRef[];
  /** The fields the step names as outputs (#3999), read once the apply landed. Absent when it names none. */
  outputs?: Record<string, unknown>;
}

interface ApplierArgs {
  manifest: string;
  /** The parsed documents to apply instead of reading `manifest`, when the step changed them in memory. */
  documents?: Record<string, unknown>[];
  environment?: string;
  stack?: string;
  context?: string;
  deleteMode?: "never" | "owned-only" | "gated";
}

type Applier = (args: ApplierArgs) => Promise<KubectlApplyOutcome>;
type ManifestReader = (path: string) => Record<string, unknown>[];

/** One field change, the mirror of `../op/activities/apply-diff.ts`'s `FieldChange`. */
interface FieldChangeShape {
  path: string;
  before?: unknown;
  after?: unknown;
}

/** The mirror of the activity's `PlannedObject`. */
interface PlannedObjectShape {
  ref: AppliedRef;
  action: "create" | "update" | "no-op";
  object?: Record<string, unknown>;
  changes: FieldChangeShape[];
  refused?: string;
}

/** What a dry run found: the mirror of the activity's `ManifestPlanResult` (#3998). */
export interface KubectlApplyDryRun {
  fieldManager: string;
  stack?: string;
  objects: PlannedObjectShape[];
  deletes: AppliedRef[];
  retained: AppliedRef[];
}

type Planner = (args: ApplierArgs) => Promise<KubectlApplyDryRun>;

/** The mirror of the activity's `ReadLiveObjectsArgs`. */
interface LiveReaderArgs {
  refs: AppliedRef[];
  environment?: string;
  context?: string;
}

/** Reads objects as the cluster holds them, `undefined` for one that does not exist (#3999). */
type LiveReader = (args: LiveReaderArgs) => Promise<Array<Record<string, unknown> | undefined>>;

/** What `plan` hands `run` through `DeployContext.plans` (#3998). */
export interface KubectlApplyPlanArtifact {
  kind: "kubectl-apply-plan";
  planDigest: string;
  /** The documents the plan dry-ran, release attributes set. `run` applies these. */
  documents: Record<string, unknown>[];
}

function isPlanArtifact(value: unknown): value is KubectlApplyPlanArtifact {
  const v = value as Partial<KubectlApplyPlanArtifact> | undefined;
  return !!v && v.kind === "kubectl-apply-plan" && typeof v.planDigest === "string" && Array.isArray(v.documents);
}

/**
 * `run` was handed an approved plan and a fresh dry run of the same
 * documents gives a different digest: the cluster moved since the plan, or
 * the plan was made against another one. Nothing is applied. `planMoved` is
 * core's mark for a moved plan (`isPlanMovedError`), so the command that
 * applied it exits 3. `exitCode` 3 says the same to a core that reads it.
 */
export class KubectlApplyPlanMovedError extends Error {
  readonly planMoved = true;
  readonly exitCode = 3;
  constructor(
    public readonly member: string,
    public readonly approved: string,
    public readonly fresh: string,
  ) {
    super(
      `kubectl-apply "${member}": the plan moved since it was approved (approved ${approved}, now ${fresh}); ` +
        `nothing was applied. Plan and approve again.`,
    );
    this.name = "KubectlApplyPlanMovedError";
  }
}

/** Kinds whose pod template change rolls their pods. */
const ROLLING_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"]);

/** `Deployment/prod/web`, or `ClusterRole/admin` for a cluster-scoped object. */
function addressOf(ref: AppliedRef): string {
  return ref.namespace ? `${ref.kind}/${ref.namespace}/${ref.name}` : `${ref.kind}/${ref.name}`;
}

const typeOf = (ref: AppliedRef): string => `${ref.apiVersion}/${ref.kind}`;

/** A Secret's `data` and `stringData` values are never carried into the change set. */
function isSensitive(ref: AppliedRef, path: string): boolean {
  return ref.kind === "Secret" && /^(data|stringData)\b/.test(path);
}

function attribute(ref: AppliedRef, change: FieldChangeShape): ChangeSetAttribute {
  if (isSensitive(ref, change.path)) return { path: change.path, sensitive: true };
  return {
    path: change.path,
    ...("before" in change ? { before: change.before } : {}),
    ...("after" in change ? { after: change.after } : {}),
  };
}

/**
 * The member's change-set part: one entry per declared object (`no-op`
 * included, as the terraform adapter reports them) and one `delete` per
 * object the prune would remove. A change the API server refuses as
 * immutable is an `update` with disruption `unknown`, plus a hole that says
 * the apply would fail.
 */
function changeSetPartOf(member: string, planDigest: string, dryRun: KubectlApplyDryRun): ChangeSetPart {
  const base = { member, lexicon: "k8s", planner: "chant" as const };
  const entries: ChangeSetEntry[] = [];
  const holes: ChangeSetHole[] = [];
  for (const o of dryRun.objects) {
    const head = { ...base, address: addressOf(o.ref), type: typeOf(o.ref), name: o.ref.name };
    if (o.refused !== undefined) {
      entries.push({ ...head, action: "update", disruption: "unknown", attributes: [] });
      holes.push({
        address: head.address,
        type: head.type,
        reason:
          `the API server refuses the change: ${o.refused}. The apply does not delete and recreate ` +
          `the object, so it fails the same way until the object is deleted`,
      });
      continue;
    }
    if (o.action === "create") {
      const declared = normalizeServerObject(o.object ?? {});
      delete declared.apiVersion;
      delete declared.kind;
      entries.push({ ...head, action: "create", attributes: diffFields({}, declared).map((c) => attribute(o.ref, c)) });
      continue;
    }
    if (o.action === "no-op") {
      entries.push({ ...head, action: "no-op", attributes: [] });
      continue;
    }
    const rolling = ROLLING_KINDS.has(o.ref.kind) && o.changes.some((c) => c.path.startsWith("spec.template"));
    entries.push({
      ...head,
      action: "update",
      disruption: rolling ? "rolling" : "in-place",
      attributes: o.changes.map((c) => attribute(o.ref, c)),
    });
  }
  for (const ref of dryRun.deletes) {
    entries.push({ ...base, address: addressOf(ref), type: typeOf(ref), name: ref.name, action: "delete", disruption: "destroy", attributes: [] });
  }
  return { member: { ...base, status: "planned", planDigest, holes }, entries };
}

/**
 * What a gate on this member binds: where it applies, as whom, the documents
 * sent, and what the dry run says each does. For an object it changes, the
 * changed paths and their new values, so a field another manager moves
 * between plan and apply refuses the apply only when it is one chant's
 * apply changes. Server bookkeeping never reaches it (`apply-diff.ts`).
 */
function dryRunDigest(
  ctx: DeployContext,
  member: string,
  input: KubectlApplyInput,
  documents: Record<string, unknown>[],
  dryRun: KubectlApplyDryRun,
): string {
  return computePlanDigest("kubectl-apply-plan", {
    env: ctx.env,
    member,
    context: input.context ?? null,
    delete: input.delete ?? "never",
    fieldManager: dryRun.fieldManager,
    documents,
    objects: dryRun.objects.map((o) => ({
      address: addressOf(o.ref),
      type: typeOf(o.ref),
      action: o.action,
      changes: o.changes.map((c) => ("after" in c ? { path: c.path, after: c.after } : { path: c.path, removed: true })),
      ...(o.refused !== undefined ? { refused: o.refused } : {}),
    })),
    deletes: dryRun.deletes.map((r) => `${typeOf(r)}/${r.namespace ?? ""}/${r.name}`).sort(),
  });
}

export interface KubectlApplyInput {
  /** Path to a manifest file, or a directory of them. */
  manifest: string;
  /**
   * The deploy unit / ownership stack. Optional: omitted derives the field
   * manager from the project's `ownership.stack` as the Op activity does —
   * but then the unit is invisible to `components status --live`, which only
   * reads a literal on the step. Name it.
   */
  stack?: string;
  /** kubectl context. Omitted resolves `k8s.profiles.<ctx.env>.context`. */
  context?: string;
  /**
   * What happens to chant-owned objects no longer in the manifest — the same
   * vocabulary the Op activity and `ApplyOp` use. Default `never`; the prune
   * is always marker-scoped, so an object chant did not stamp is never a
   * candidate.
   */
  delete?: "never" | "owned-only";
  /**
   * The outputs the step exposes (#3999), by name: each a field of an object
   * the manifest declares. A dependent reads them with `stackOutput()`.
   */
  outputs?: Record<string, KubectlApplyOutputField>;
}

/** One output of a `kubectl-apply` step (#3999). */
export interface KubectlApplyOutputField {
  /**
   * The object, named as the manifest declares it: `Kind/namespace/name`, or
   * `Kind/name` for a document with no namespace.
   */
  object: string;
  /** The field's dot path in the object; a list index is a number, `status.loadBalancer.ingress.0.hostname`. */
  field: string;
}

/** The value at a dot path, or `undefined`. */
function fieldAt(object: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), object);
}

/** The declared ref of each output's object, keyed by output name. Throws for an object the manifest does not declare. */
function outputRefs(member: string, input: KubectlApplyInput, documents: Record<string, unknown>[]): Map<string, AppliedRef> {
  const declared = new Map<string, AppliedRef>();
  for (const doc of documents) {
    const metadata = (doc.metadata ?? {}) as { name?: unknown; namespace?: unknown };
    const ref: AppliedRef = {
      apiVersion: String(doc.apiVersion ?? ""),
      kind: String(doc.kind ?? ""),
      name: String(metadata.name ?? ""),
      ...(metadata.namespace !== undefined ? { namespace: String(metadata.namespace) } : {}),
    };
    declared.set(addressOf(ref), ref);
  }
  const out = new Map<string, AppliedRef>();
  for (const [name, spec] of Object.entries(input.outputs ?? {})) {
    const ref = declared.get(spec.object);
    if (!ref) {
      throw new Error(`kubectl-apply "${member}": output "${name}" names ${spec.object}, which ${input.manifest} does not declare (it declares ${[...declared.keys()].join(", ") || "nothing"})`);
    }
    out.set(name, ref);
  }
  return out;
}

/** Each output's field as `objects` hold it, one object per distinct ref; an output with no value is left out. */
async function readOutputs(read: LiveReader, refs: Map<string, AppliedRef>, input: KubectlApplyInput, where: Omit<LiveReaderArgs, "refs">): Promise<Record<string, unknown>> {
  const distinct = [...new Map([...refs.values()].map((r) => [addressOf(r), r])).values()];
  const live = await read({ refs: distinct, ...where });
  const byAddress = new Map(distinct.map((r, i) => [addressOf(r), live[i]]));
  const out: Record<string, unknown> = {};
  for (const [name, ref] of refs) {
    const value = fieldAt(byAddress.get(addressOf(ref)), input.outputs![name]!.field);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The documents `targets` name (#4300), each `Kind/namespace/name` or
 * `Kind/name` as {@link addressOf} writes it, in manifest order. Throws for
 * a target the manifest does not declare.
 */
export function targetedDocuments(member: string, manifest: string, documents: Record<string, unknown>[], targets: readonly string[]): Record<string, unknown>[] {
  const addressOfDoc = (doc: Record<string, unknown>): string => {
    const metadata = (doc.metadata ?? {}) as { name?: unknown; namespace?: unknown };
    return addressOf({
      apiVersion: String(doc.apiVersion ?? ""),
      kind: String(doc.kind ?? ""),
      name: String(metadata.name ?? ""),
      ...(metadata.namespace !== undefined ? { namespace: String(metadata.namespace) } : {}),
    });
  };
  const declared = new Set(documents.map(addressOfDoc));
  const missing = targets.filter((t) => !declared.has(t));
  if (missing.length > 0) {
    throw new Error(
      `kubectl-apply "${member}": --target ${missing.join(", ")} names no object ${manifest} declares ` +
        `(it declares ${[...declared].join(", ") || "nothing"})`,
    );
  }
  const wanted = new Set(targets);
  return documents.filter((d) => wanted.has(addressOfDoc(d)));
}

/**
 * The input a targeted step plans and applies with (#4300): the same, with no
 * prune. A prune over a narrowed set would delete every owned object the
 * targets leave out.
 */
const narrowedInput = (ctx: DeployContext, input: KubectlApplyInput): KubectlApplyInput =>
  ctx.targets && ctx.targets.length > 0 ? { ...input, delete: "never" } : input;

/** Factory with an injectable applier, so tests assert the delegation without
 * a cluster — the same seam `createGenerateSbomCapability` uses. The default
 * applier is resolved by dynamic import on first run, keeping the API-client
 * chain off the build path (#1074). */
export function createKubectlApplyCapability(
  apply?: Applier,
  read?: ManifestReader,
  dryRun?: Planner,
  readLive?: LiveReader,
): Capability<KubectlApplyInput, KubectlApplyOutcome> {
  const activities = () => import("../op/activities/kubectl");
  const target = (ctx: DeployContext, input: KubectlApplyInput) => ({
    environment: ctx.env,
    ...(input.stack !== undefined ? { stack: input.stack } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.delete !== undefined ? { deleteMode: input.delete } : {}),
  });
  /** Dry-run `documents` and digest the result. */
  const dryRunOf = async (ctx: DeployContext, input: KubectlApplyInput, member: string, documents: Record<string, unknown>[]) => {
    const planner: Planner = dryRun ?? (await activities()).planManifest;
    const result = await planner({ manifest: input.manifest, documents, ...target(ctx, input) });
    return { result, planDigest: dryRunDigest(ctx, member, input, documents, result) };
  };
  const liveReader = async (): Promise<LiveReader> => readLive ?? (await activities()).readLiveObjects;
  const where = (ctx: DeployContext, input: KubectlApplyInput) => ({
    environment: ctx.env,
    ...(input.context !== undefined ? { context: input.context } : {}),
  });
  /** The outputs the step names, read from the cluster now. */
  const liveOutputs = async (ctx: DeployContext, input: KubectlApplyInput, documents: Record<string, unknown>[]) =>
    readOutputs(await liveReader(), outputRefs(input.stack ?? ctx.component, input, documents), input, where(ctx, input));
  /**
   * What the plan knows of each output: a field the manifest sets, and any
   * field of an object the dry run leaves unchanged, read from the cluster.
   */
  const plannedOutputs = async (ctx: DeployContext, input: KubectlApplyInput, member: string, documents: Record<string, unknown>[], dry: KubectlApplyDryRun): Promise<PlannedOutputs> => {
    const refs = outputRefs(member, input, documents);
    const declared = new Map(documents.map((d) => [addressOf({ apiVersion: "", kind: String(d.kind ?? ""), name: String((d.metadata as { name?: unknown } | undefined)?.name ?? ""), ...((d.metadata as { namespace?: unknown } | undefined)?.namespace !== undefined ? { namespace: String((d.metadata as { namespace: unknown }).namespace) } : {}) }), d]));
    const unchanged = new Set(dry.objects.filter((o) => o.action === "no-op").map((o) => addressOf(o.ref)));
    const fromLive = new Map([...refs].filter(([, ref]) => unchanged.has(addressOf(ref))));
    const live = fromLive.size > 0 ? await readOutputs(await liveReader(), fromLive, input, where(ctx, input)) : {};
    const known: Record<string, unknown> = {};
    const unknown: string[] = [];
    for (const [name, ref] of refs) {
      const set = fieldAt(declared.get(addressOf(ref)), input.outputs![name]!.field);
      if (set !== undefined) known[name] = set;
      else if (name in live) known[name] = live[name];
      else unknown.push(name);
    }
    return { known, unknown: unknown.sort() };
  };
  /**
   * {@link plannedOutputs} for a targeted plan (#4300): an output of a
   * targeted object as the plan says, and one of an object the targets leave
   * out as the cluster holds it now, since the apply leaves that object alone.
   */
  const targetedPlannedOutputs = async (
    ctx: DeployContext,
    input: KubectlApplyInput,
    member: string,
    documents: Record<string, unknown>[],
    dry: KubectlApplyDryRun,
    targets: readonly string[] | undefined,
    declared: Record<string, unknown>[],
  ): Promise<PlannedOutputs> => {
    if (!targets) return plannedOutputs(ctx, input, member, documents, dry);
    const wanted = new Set(targets);
    const all = Object.entries(input.outputs ?? {});
    const inside = Object.fromEntries(all.filter(([, spec]) => wanted.has(spec.object)));
    const outside = Object.fromEntries(all.filter(([, spec]) => !wanted.has(spec.object)));
    const planned = Object.keys(inside).length > 0 ? await plannedOutputs(ctx, { ...input, outputs: inside }, member, documents, dry) : { known: {}, unknown: [] };
    if (Object.keys(outside).length === 0) return planned;
    const rest = { ...input, outputs: outside };
    const live = await readOutputs(await liveReader(), outputRefs(member, rest, declared), rest, where(ctx, input));
    const known = { ...planned.known, ...live };
    const unknown = [...planned.unknown, ...Object.keys(outside).filter((n) => !(n in live))].sort();
    return { known, unknown };
  };
  return {
    kind: "kubectl-apply",
    // A server-side apply has no native undo (the previous object state is not
    // kept by the API server), so COMP003 requires the component to acknowledge
    // the compensation gap — the same posture as s3-sync/run-migration.
    rollbackPolicy: "needs-opt-out",
    // #4300: a target names one object, `Kind/namespace/name`; the plan and the apply send those alone.
    targets: "accept",
    /**
     * Dry-run the manifest against the cluster (#3998): the documents `run`
     * would apply, release attributes set, server-side applied with
     * `dryRun=All` as the same field manager, each compared with its live
     * object. The member is the step's `stack`, or the component.
     */
    async plan(ctx: DeployContext, stepInput: KubectlApplyInput): Promise<CapabilityPlan> {
      const input = narrowedInput(ctx, stepInput);
      const member = input.stack ?? ctx.component;
      const read_ = (read ?? (await activities()).readManifestDocuments)(input.manifest);
      const targets = ctx.targets && ctx.targets.length > 0 ? ctx.targets : undefined;
      const documents = targets ? targetedDocuments(member, input.manifest, read_, targets) : read_;
      const suffix = releaseAttributesSuffix(ctx.release);
      if (suffix !== "") annotateRelease(documents, suffix);
      const { result, planDigest } = await dryRunOf(ctx, input, member, documents);
      const artifact: KubectlApplyPlanArtifact = { kind: "kubectl-apply-plan", planDigest, documents };
      const outputs = input.outputs ? await targetedPlannedOutputs(ctx, input, member, documents, result, targets, read_) : undefined;
      return {
        member,
        planDigest,
        artifact,
        changeSet: changeSetPartOf(member, planDigest, result),
        ...(outputs ? { outputs } : {}),
        ...(targets ? { targets } : {}),
      };
    },
    /**
     * The fields the step names as outputs, as the cluster holds them now
     * (#3999). A step that names none has none; an object not made yet
     * leaves its outputs out.
     */
    async outputs(ctx: DeployContext, input: KubectlApplyInput): Promise<Record<string, unknown>> {
      if (!input.outputs || Object.keys(input.outputs).length === 0) return {};
      const documents = (read ?? (await activities()).readManifestDocuments)(input.manifest);
      return liveOutputs(ctx, input, documents);
    },
    async run(ctx: DeployContext, stepInput: KubectlApplyInput): Promise<KubectlApplyOutcome> {
      const input = narrowedInput(ctx, stepInput);
      const member = input.stack ?? ctx.component;
      const approved = ctx.plans?.[member];
      if (isPlanArtifact(approved)) {
        // Apply the documents the approver saw, and only while a fresh dry
        // run of them still says what the approved one said.
        const { planDigest } = await dryRunOf(ctx, input, member, approved.documents);
        if (planDigest !== approved.planDigest) throw new KubectlApplyPlanMovedError(member, approved.planDigest, planDigest);
        const applier: Applier = apply ?? (await activities()).applyManifest;
        const outcome = await applier({ manifest: input.manifest, documents: approved.documents, ...target(ctx, input) });
        return input.outputs ? { ...outcome, outputs: await liveOutputs(ctx, input, approved.documents) } : outcome;
      }
      const loaded = apply && read ? undefined : await activities();
      const applier: Applier = apply ?? loaded!.applyManifest;
      // A release run (#3061, ws-081) sets the release attributes on the pod template of each
      // workload the build stamped, in what it applies; the committed manifest is not touched.
      const suffix = releaseAttributesSuffix(ctx.release);
      let documents: Record<string, unknown>[] | undefined;
      if (ctx.targets && ctx.targets.length > 0) {
        // #4300: only the targeted objects, and no prune (`narrowedInput`).
        documents = targetedDocuments(member, input.manifest, (read ?? loaded!.readManifestDocuments)(input.manifest), ctx.targets);
        if (suffix !== "") annotateRelease(documents, suffix);
      } else if (suffix !== "") {
        documents = (read ?? loaded!.readManifestDocuments)(input.manifest);
        if (annotateRelease(documents, suffix) === 0) documents = undefined;
      }
      const outcome = await applier({ manifest: input.manifest, ...(documents ? { documents } : {}), ...target(ctx, input) });
      if (!input.outputs) return outcome;
      const declared = documents ?? (read ?? (await activities()).readManifestDocuments)(input.manifest);
      return { ...outcome, outputs: await liveOutputs(ctx, input, declared) };
    },
  };
}

export const kubectlApplyCapability = createKubectlApplyCapability();
