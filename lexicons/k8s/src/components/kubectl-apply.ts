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
 */
import type { Capability, CapabilityPlan, DeployContext } from "@intentius/chant/components/capability";
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
}

/** Factory with an injectable applier, so tests assert the delegation without
 * a cluster — the same seam `createGenerateSbomCapability` uses. The default
 * applier is resolved by dynamic import on first run, keeping the API-client
 * chain off the build path (#1074). */
export function createKubectlApplyCapability(
  apply?: Applier,
  read?: ManifestReader,
  dryRun?: Planner,
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
  return {
    kind: "kubectl-apply",
    // A server-side apply has no native undo (the previous object state is not
    // kept by the API server), so COMP003 requires the component to acknowledge
    // the compensation gap — the same posture as s3-sync/run-migration.
    rollbackPolicy: "needs-opt-out",
    /**
     * Dry-run the manifest against the cluster (#3998): the documents `run`
     * would apply, release attributes set, server-side applied with
     * `dryRun=All` as the same field manager, each compared with its live
     * object. The member is the step's `stack`, or the component.
     */
    async plan(ctx: DeployContext, input: KubectlApplyInput): Promise<CapabilityPlan> {
      const member = input.stack ?? ctx.component;
      const documents = (read ?? (await activities()).readManifestDocuments)(input.manifest);
      const suffix = releaseAttributesSuffix(ctx.release);
      if (suffix !== "") annotateRelease(documents, suffix);
      const { result, planDigest } = await dryRunOf(ctx, input, member, documents);
      const artifact: KubectlApplyPlanArtifact = { kind: "kubectl-apply-plan", planDigest, documents };
      return { member, planDigest, artifact, changeSet: changeSetPartOf(member, planDigest, result) };
    },
    async run(ctx: DeployContext, input: KubectlApplyInput): Promise<KubectlApplyOutcome> {
      const member = input.stack ?? ctx.component;
      const approved = ctx.plans?.[member];
      if (isPlanArtifact(approved)) {
        // Apply the documents the approver saw, and only while a fresh dry
        // run of them still says what the approved one said.
        const { planDigest } = await dryRunOf(ctx, input, member, approved.documents);
        if (planDigest !== approved.planDigest) throw new KubectlApplyPlanMovedError(member, approved.planDigest, planDigest);
        const applier: Applier = apply ?? (await activities()).applyManifest;
        return applier({ manifest: input.manifest, documents: approved.documents, ...target(ctx, input) });
      }
      const loaded = apply && read ? undefined : await activities();
      const applier: Applier = apply ?? loaded!.applyManifest;
      // A release run (#3061, ws-081) sets the release attributes on the pod template of each
      // workload the build stamped, in what it applies; the committed manifest is not touched.
      const suffix = releaseAttributesSuffix(ctx.release);
      let documents: Record<string, unknown>[] | undefined;
      if (suffix !== "") {
        documents = (read ?? loaded!.readManifestDocuments)(input.manifest);
        if (annotateRelease(documents, suffix) === 0) documents = undefined;
      }
      return applier({ manifest: input.manifest, ...(documents ? { documents } : {}), ...target(ctx, input) });
    },
  };
}

export const kubectlApplyCapability = createKubectlApplyCapability();
