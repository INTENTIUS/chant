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
import type { Capability, DeployContext } from "@intentius/chant/components/capability";

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
}

interface ApplierArgs {
  manifest: string;
  environment?: string;
  stack?: string;
  context?: string;
  deleteMode?: "never" | "owned-only" | "gated";
}

type Applier = (args: ApplierArgs) => Promise<KubectlApplyOutcome>;

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
): Capability<KubectlApplyInput, KubectlApplyOutcome> {
  return {
    kind: "kubectl-apply",
    // A server-side apply has no native undo (the previous object state is not
    // kept by the API server), so COMP003 requires the component to acknowledge
    // the compensation gap — the same posture as s3-sync/run-migration.
    rollbackPolicy: "needs-opt-out",
    async run(ctx: DeployContext, input: KubectlApplyInput): Promise<KubectlApplyOutcome> {
      const applier: Applier = apply ?? (await import("../op/activities/kubectl")).applyManifest;
      return applier({
        manifest: input.manifest,
        environment: ctx.env,
        ...(input.stack !== undefined ? { stack: input.stack } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.delete !== undefined ? { deleteMode: input.delete } : {}),
      });
    },
  };
}

export const kubectlApplyCapability = createKubectlApplyCapability();
