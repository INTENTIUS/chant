/**
 * `argo-app` — the Argo CD deploy leaf for the component model (#1549
 * piece 2).
 *
 * GitOps inverts the flow kubectl-apply assumes: the controller deploys,
 * chant declares the controller's objects and observes convergence. This
 * capability is that inversion as one step — apply the declared
 * `Application` CR(s) through the SAME server-side apply `kubectl-apply`
 * uses (ownership stamping, marker-scoped prune, stack labels all
 * identical), then block until every applied Application reports
 * `health=Healthy && sync=Synced` via the existing `waitForArgoSync`
 * activity (#957).
 *
 * The deploy unit is the CR itself under its stack label — `stack` doubles
 * as ownership identity and deploy unit exactly as kubectl-apply's, so
 * `chant components status --live` observes the Application through the
 * same label sweep with zero new status walks (core
 * `components/deploy-units.ts`).
 *
 * The #1074 boundary applies: nothing exported from the lexicon entry point
 * may statically import the API-client chain, so both the applier and the
 * wait activity are reached by dynamic import inside `run()` and their
 * argument shapes are structural mirrors, checked against the real ones at
 * the call site.
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

interface ArgoWaiterArgs {
  appName: string;
  namespace?: string;
  server?: string;
  authToken?: string;
  insecure?: boolean;
  context?: string;
  intervalMs?: number;
}

type ArgoWaiter = (args: ArgoWaiterArgs) => Promise<{ health: string; sync: string }>;

/** One Application's final status, after the wait. */
export interface ArgoAppSynced {
  name: string;
  namespace: string;
  health: string;
  sync: string;
}

export interface ArgoAppOutcome extends ApplyOutcome {
  /** Every applied Application, Healthy+Synced, in wait order. */
  synced: ArgoAppSynced[];
}

export interface ArgoAppInput {
  /** Path to the Application CR manifest(s) — a file, or a directory of them. */
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
  /**
   * Argo CD API base URL. When set, sync status is read from the REST API
   * instead of the cluster — pass `authToken` with it (the `waitForArgoSync`
   * surface, #957).
   */
  server?: string;
  /** Bearer token for the Argo CD REST API (used with `server`). */
  authToken?: string;
  /** Skip TLS verification for the REST API (default false). */
  insecure?: boolean;
  /** Poll interval in ms (default 15000). */
  intervalMs?: number;
}

/** True when the ref is an Argo CD Application (any argoproj.io version). */
function isArgoApplication(ref: AppliedRef): boolean {
  return ref.kind === "Application" && /^argoproj\.io(\/|$)/.test(ref.apiVersion);
}

/** Factory with injectable applier + waiter, so tests assert the exact
 * delegation without a cluster — the kubectl-apply seam. Defaults resolve by
 * dynamic import on first run, keeping the API-client chain off the build
 * path (#1074). */
export function createArgoAppCapability(
  apply?: Applier,
  wait?: ArgoWaiter,
): Capability<ArgoAppInput, ArgoAppOutcome> {
  return {
    kind: "argo-app",
    // The apply half is a server-side apply with no native undo, and Argo
    // offers no declarative "un-sync" — same posture as kubectl-apply.
    rollbackPolicy: "needs-opt-out",
    async run(ctx: DeployContext, input: ArgoAppInput): Promise<ArgoAppOutcome> {
      const applier: Applier = apply ?? (await import("../op/activities/kubectl")).applyManifest;
      const outcome = await applier({
        manifest: input.manifest,
        environment: ctx.env,
        ...(input.stack !== undefined ? { stack: input.stack } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.delete !== undefined ? { deleteMode: input.delete } : {}),
      });

      // AppProject / ApplicationSet in the same manifest apply fine; the wait
      // gates only on Applications (an ApplicationSet's generated Applications
      // are the controller's, not declared here).
      const apps = outcome.applied.filter(isArgoApplication);
      if (apps.length === 0) {
        throw new Error(
          `argo-app: "${input.manifest}" applied no argoproj.io Application — nothing to sync on. ` +
            `A plain manifest belongs on kubectl-apply.`,
        );
      }

      const waiter: ArgoWaiter = wait ?? (await import("../op/activities/argo")).waitForArgoSync;
      const synced: ArgoAppSynced[] = [];
      for (const app of apps) {
        const namespace = app.namespace ?? "argocd";
        const status = await waiter({
          appName: app.name,
          namespace,
          ...(input.server !== undefined ? { server: input.server } : {}),
          ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
          ...(input.insecure !== undefined ? { insecure: input.insecure } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
          ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}),
        });
        synced.push({ name: app.name, namespace, health: status.health, sync: status.sync });
      }
      return { ...outcome, synced };
    },
  };
}

export const argoAppCapability = createArgoAppCapability();
