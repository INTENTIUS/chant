/**
 * The plan a component gate approval is bound to (#2574).
 *
 * An Op gate binds the digest of the change set its Plan phase produced
 * (#2300). A component has no Plan phase: what it will do is its composition,
 * run against one environment. So the digest is taken over that, with the
 * same `computePlanDigest` Op gates use.
 *
 * ## What it covers
 *
 * - The environment. An approval for staging never answers prod.
 * - The composition as this run executes it: `deploy` and `rollback` phases
 *   with every step's authored input. A promote and a rollback run a
 *   transformed composition (`./promote.ts`), and a rollback's pins the
 *   recorded digest into it, so each differs from a plain deploy's.
 * - The release being deployed, when the caller names one. A promote checks
 *   its publish output against a recorded digest that is not in the
 *   composition, so it passes that digest here.
 * - `vars`, the environment config the caller resolved ahead of the run.
 * - The content digests of the local files the steps deploy from (#4155,
 *   ./deploy-inputs.ts): a chart, a manifest, a site's tree, a build step's
 *   sources. A file changed after review moves the digest. The key is left
 *   out when no step names an existing file, so a composition that deploys
 *   none keeps the digest it had before #4155.
 *
 * ## What it leaves out
 *
 * Anything decided during the run: outputs of earlier phases (a fresh build's
 * digest differs on every build that is not reproducible, and binding it
 * would make an approval unusable by the run that consumes it) and outputs of
 * upstream components. The run id and the time are left out for the reasons
 * `../lifecycle/plan-digest.ts` gives.
 */

import { computePlanDigest } from "../lifecycle/plan-digest";
import type { DeployInputDigest } from "./deploy-inputs";
import type { DriverComponent } from "./driver";

/** What a component gate's plan digest is taken over. */
export interface ComponentGatePlan {
  environment: string;
  component: DriverComponent;
  vars?: Record<string, unknown>;
  /** The recorded digest a promote or rollback deploys, when the caller has one. */
  release?: string;
  /** What the steps deploy from (`componentDeployInputs`), when the caller read it. */
  inputs?: readonly DeployInputDigest[];
}

/** The plan digest a component gate records and approves. */
export function componentPlanDigest(plan: ComponentGatePlan): string {
  const { component } = plan;
  return computePlanDigest("component-deploy", {
    environment: plan.environment,
    component: component.name,
    deploy: component.deploy,
    rollback: component.rollback ?? null,
    vars: plan.vars ?? null,
    release: plan.release ?? null,
    ...(plan.inputs && plan.inputs.length > 0 ? { inputs: plan.inputs } : {}),
  });
}
