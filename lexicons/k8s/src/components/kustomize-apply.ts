/**
 * `kustomize-apply` — the kustomize leaf for the component model (#1548).
 *
 * Kustomize is a RENDERER, not a substrate: `kustomize build <dir>` emits
 * exactly the Kubernetes manifests the existing apply pipeline was built for.
 * So this capability is a render step in front of `kubectl-apply`'s machinery
 * — the rendered documents go straight to the same server-side applier
 * (inline, no temp file), which stamps the deploy-unit stack (#1539), prunes
 * marker-scoped, retakes chant's own field conflicts (#1541/#1542), and is
 * observed by the same `describeStackStatus` label sweep. An estate that
 * keeps its overlay tree gets components-status honesty without adopting a
 * single typed manifest.
 *
 * `stack` doubles as the ownership identity and the deploy unit, exactly as
 * `kubectl-apply` — one name, both jobs.
 *
 * Renderer resolution lives in `../kustomize/render.ts` (shared with the
 * build-root path, #1548 piece 3): `kustomize build`, falling back to
 * `kubectl kustomize` (the same renderer vendored into kubectl) when the
 * standalone binary is absent. Both run through an injectable runner so tests
 * assert the exact command without either binary installed.
 *
 * The #1074 boundary applies as it does to kubectl-apply: nothing exported
 * from the lexicon entry point may statically import the API-client chain, so
 * the applier is reached by dynamic import inside `run()` and its argument
 * shape is a structural mirror.
 */
import type { Capability, DeployContext } from "@intentius/chant/components/capability";
import {
  defaultKustomizeRunner,
  renderCommand,
  renderKustomizeDocuments,
  type KustomizeRunner,
} from "../kustomize/render";

export { renderCommand, type KustomizeRunner };

/** Structural mirrors of the activity module's shapes (see the module doc). */
interface AppliedRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

export interface KustomizeApplyOutcome {
  fieldManager: string;
  applied: AppliedRef[];
  pruned: AppliedRef[];
}

interface ApplierArgs {
  manifest: string;
  documents?: Array<Record<string, unknown>>;
  environment?: string;
  stack?: string;
  context?: string;
  deleteMode?: "never" | "owned-only" | "gated";
}

type Applier = (args: ApplierArgs) => Promise<KustomizeApplyOutcome>;

export interface KustomizeApplyInput {
  /** The kustomization directory (holds `kustomization.yaml`) — an overlay or a base. */
  dir: string;
  /**
   * The deploy unit / ownership stack — same double duty as kubectl-apply's.
   * Omitted derives from the project's `ownership.stack`, but then the unit is
   * invisible to `components status --live`. Name it.
   */
  stack?: string;
  /** kubectl context. Omitted resolves `k8s.profiles.<ctx.env>.context`. */
  context?: string;
  /** Same delete vocabulary as kubectl-apply; default `never`. */
  delete?: "never" | "owned-only";
}

/** Factory with injectable renderer + applier, so tests assert the render
 * command and the exact applier delegation without kustomize or a cluster. */
export function createKustomizeApplyCapability(
  run: KustomizeRunner = defaultKustomizeRunner,
  apply?: Applier,
): Capability<KustomizeApplyInput, KustomizeApplyOutcome> {
  return {
    kind: "kustomize-apply",
    // Server-side apply keeps no previous object state, and kustomize adds no
    // undo of its own — same posture as kubectl-apply.
    rollbackPolicy: "needs-opt-out",
    async run(ctx: DeployContext, input: KustomizeApplyInput): Promise<KustomizeApplyOutcome> {
      const documents = await renderKustomizeDocuments(input.dir, run);
      const applier: Applier = apply ?? ((await import("../op/activities/kubectl")).applyManifest as unknown as Applier);
      return applier({
        manifest: `kustomize:${input.dir}`,
        documents,
        environment: ctx.env,
        ...(input.stack !== undefined ? { stack: input.stack } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.delete !== undefined ? { deleteMode: input.delete } : {}),
      });
    },
  };
}

export const kustomizeApplyCapability = createKustomizeApplyCapability();
