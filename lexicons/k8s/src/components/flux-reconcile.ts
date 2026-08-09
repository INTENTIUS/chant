/**
 * `flux-reconcile` — the Flux deploy leaf for the component model (#1549
 * piece 2).
 *
 * The sibling of `argo-app` for the Flux toolkit: apply the declared Flux
 * CRs (`GitRepository`, `Kustomization`, `HelmRelease`, `OCIRepository`, …)
 * through the SAME server-side apply `kubectl-apply` uses — ownership
 * stamping, marker-scoped prune, stack labels all identical — then block
 * until every applied Flux CR reports `Ready=True` via the generic
 * `waitForReady`. The readiness registry's Flux entries (#1554,
 * `ConditionReasonMatch`) make that wait honest: a wedge reason like
 * `BuildFailed` or `UpgradeFailed` fails fast instead of polling out the
 * timeout.
 *
 * Sources are waited first (`source.toolkit.fluxcd.io` before the rest,
 * applied order within each half): a Kustomization cannot become Ready
 * before its GitRepository has an artifact, so gating on the source first
 * surfaces a wedged clone as the source's error, not as a reconciler
 * timeout downstream of it.
 *
 * The deploy unit is the CR itself under its stack label — one name, both
 * jobs, exactly as kubectl-apply (core `components/deploy-units.ts`).
 *
 * The #1074 boundary applies: the applier and the wait activity are reached
 * by dynamic import inside `run()`; their argument shapes are structural
 * mirrors, checked against the real ones at the call site.
 */
import type { Capability, DeployContext } from "@intentius/chant/components/capability";

/** Structural mirrors of the activity modules' shapes (see the module doc). */
interface AppliedRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

interface ApplyOutcome {
  fieldManager: string;
  applied: AppliedRef[];
  pruned: AppliedRef[];
}

interface ApplierArgs {
  manifest: string;
  environment?: string;
  stack?: string;
  context?: string;
  deleteMode?: "never" | "owned-only" | "gated";
}

type Applier = (args: ApplierArgs) => Promise<ApplyOutcome>;

interface ReadyWaiterArgs {
  kind: string;
  name: string;
  namespace?: string;
  group?: string;
  environment?: string;
  context?: string;
  intervalMs?: number;
}

type ReadyWaiter = (args: ReadyWaiterArgs) => Promise<Record<string, unknown>>;

export interface FluxReconcileOutcome extends ApplyOutcome {
  /** The Flux CRs that reached Ready, in wait order (sources first). */
  ready: AppliedRef[];
}

export interface FluxReconcileInput {
  /** Path to the Flux CR manifest(s) — a file, or a directory of them. */
  manifest: string;
  /**
   * The deploy unit / ownership stack — same double duty as kubectl-apply's.
   * Omitted derives from the project's `ownership.stack`, but then the unit
   * is invisible to `components status --live`. Name it.
   */
  stack?: string;
  /** kubectl context. Omitted resolves `k8s.profiles.<ctx.env>.context`. */
  context?: string;
  /** Same delete vocabulary as kubectl-apply; default `never`. */
  delete?: "never" | "owned-only";
  /** Poll interval in ms (default 15000). */
  intervalMs?: number;
}

/** The API group of a ref, "" for the core group. */
function groupOf(ref: AppliedRef): string {
  const slash = ref.apiVersion.indexOf("/");
  return slash === -1 ? "" : ref.apiVersion.slice(0, slash);
}

/**
 * True for any Flux CR: the toolkit groups (`source.` / `kustomize.` /
 * `helm.` / `image.` / `notification.toolkit.fluxcd.io`) plus the flux-operator
 * group (`fluxcd.controlplane.io`, `FluxInstance`). Kinds without a registry
 * entry still wait correctly — the toolkit is kstatus-conformant, so the
 * generic `Ready=True` default covers them; the #1554 entries add fail-fast.
 */
function isFluxRef(ref: AppliedRef): boolean {
  const group = groupOf(ref);
  return /(^|\.)toolkit\.fluxcd\.io$/.test(group) || group === "fluxcd.controlplane.io";
}

/** Factory with injectable applier + waiter — the argo-app seam. Defaults
 * resolve by dynamic import on first run (#1074). */
export function createFluxReconcileCapability(
  apply?: Applier,
  wait?: ReadyWaiter,
): Capability<FluxReconcileInput, FluxReconcileOutcome> {
  return {
    kind: "flux-reconcile",
    // Server-side apply keeps no previous object state, and the controller
    // reconciles forward only — same posture as kubectl-apply.
    rollbackPolicy: "needs-opt-out",
    async run(ctx: DeployContext, input: FluxReconcileInput): Promise<FluxReconcileOutcome> {
      const applier: Applier = apply ?? (await import("../op/activities/kubectl")).applyManifest;
      const outcome = await applier({
        manifest: input.manifest,
        environment: ctx.env,
        ...(input.stack !== undefined ? { stack: input.stack } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.delete !== undefined ? { deleteMode: input.delete } : {}),
      });

      // Namespaces/ConfigMaps alongside the CRs apply fine; the wait gates
      // only on the Flux objects. Sources first — see the module doc.
      const flux = outcome.applied.filter(isFluxRef);
      if (flux.length === 0) {
        throw new Error(
          `flux-reconcile: "${input.manifest}" applied no Flux CR (toolkit.fluxcd.io / fluxcd.controlplane.io) — ` +
            `nothing to reconcile on. A plain manifest belongs on kubectl-apply.`,
        );
      }
      const sources = flux.filter((r) => groupOf(r) === "source.toolkit.fluxcd.io");
      const rest = flux.filter((r) => groupOf(r) !== "source.toolkit.fluxcd.io");

      const waiter: ReadyWaiter =
        wait ?? ((await import("../op/activities/wait-for-ready")).waitForReady as unknown as ReadyWaiter);
      const ready: AppliedRef[] = [];
      for (const ref of [...sources, ...rest]) {
        await waiter({
          kind: ref.kind,
          name: ref.name,
          group: groupOf(ref),
          environment: ctx.env,
          ...(ref.namespace !== undefined ? { namespace: ref.namespace } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
          ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}),
        });
        ready.push(ref);
      }
      return { ...outcome, ready };
    },
  };
}

export const fluxReconcileCapability = createFluxReconcileCapability();
