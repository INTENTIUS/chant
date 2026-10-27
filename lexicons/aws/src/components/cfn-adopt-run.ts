/**
 * `cfn-deploy` under `chant run --components <name> --env <env> --adopt
 * <adoption-file>` (#4537): the step adopts the file's resources into its
 * stack with ./cfn-adopt.ts instead of deploying the template plainly.
 *
 * Core hands the step the adoption file, the index version it names and the
 * review on `DeployContext.adoption` (packages/core/src/components/adoption.ts).
 * This step plans the adoption against the step's built template and the
 * stack's resources now, then runs the IMPORT change set and the marker
 * UPDATE, each through that review. Everything the library refuses is
 * refused here, by name, before any change set is made, and the change set a
 * refusal or a declined review leaves is deleted.
 *
 * When the marker step stops after a good import, the resources are in the
 * stack, with the template's DeletionPolicy (Retain from `chant import
 * --index`) and without chant's markers. A plain deploy of the same template
 * writes them, and the outcome says so.
 */
import type { DeployContext } from "@intentius/chant/components/capability";
import type { AdoptionReviewRequest, DeployAdoption, DeployAdoptionOutcome } from "@intentius/chant/components/adoption";
import { cfnChangeEntry, flattenCfnInputs, type CfnDeployInput, type CfnDeployOutput } from "./apply";
import { adoptIntoStack, cfnImportReview, cfnMarkerReview, planCfnAdoption, type CfnAdoptionOutcome, type CfnAdoptionPlan, type CfnTemplate } from "./cfn-adopt";
import { readCfnTemplate } from "./cfn-imports";
import type { CloudExecutor } from "./cloud-executor";
import type { ImportabilityManifestEntry } from "../importable";

/** What to do when the marker step stops after a good import. */
export function markerStepHint(stack: string, component: string, env: string): string {
  return (
    `The resources are imported into ${stack} and carry no chant markers yet. ` +
    `A plain deploy of the same template writes them: chant run --components ${component} --env ${env}, without --adopt.`
  );
}

/** The outcome lines and status for one adoption result. */
export function adoptionOutcome(
  stack: string,
  ctx: Pick<DeployContext, "component" | "env">,
  plan: CfnAdoptionPlan | undefined,
  result: CfnAdoptionOutcome,
): DeployAdoptionOutcome {
  const member = stack;
  switch (result.status) {
    case "adopted":
      return {
        member,
        status: "adopted",
        lines: [
          ...(plan ? cfnImportReview(plan).map((l) => l.replace(/^import /, "imported ")) : []),
          ...(plan ? cfnMarkerReview(plan) : []),
          ...(result.markerChangeSet ? [] : ["the marker change set had nothing to write"]),
        ],
      };
    case "refused": {
      const after = result.step === "markers" ? [markerStepHint(stack, ctx.component, ctx.env)] : ["Nothing was imported."];
      return { member, status: "refused", step: result.step, lines: [...result.refusals.map((r) => `refused: ${r}`), ...after] };
    }
    case "declined":
      return {
        member,
        status: "declined",
        step: result.step,
        lines: [
          `the ${result.step === "import" ? "IMPORT" : "marker"} change set was not approved and was deleted`,
          result.step === "markers" ? markerStepHint(stack, ctx.component, ctx.env) : "Nothing was imported.",
        ],
      };
    case "failed":
      return {
        member,
        status: "failed",
        step: result.step,
        lines: [
          `the ${result.step === "import" ? "IMPORT" : "marker"} change set executed and the stack reached ${result.stackStatus}; read the stack events for the resource that failed`,
          ...(result.step === "markers" ? [markerStepHint(stack, ctx.component, ctx.env)] : []),
        ],
      };
  }
}

/** Run the adoption in place of the step's deploy, and report its outcome on `adoption.outcome`. Throws unless it adopted. */
export async function runCfnAdoption(
  executor: CloudExecutor,
  ctx: DeployContext,
  input: CfnDeployInput,
  adoption: DeployAdoption,
  opts: { manifest?: ReadonlyMap<string, ImportabilityManifestEntry>; waitOptions?: { intervalMs?: number; timeoutMs?: number } } = {},
): Promise<CfnDeployOutput> {
  const stack = input.stack ?? ctx.component;
  if (adoption.outcome) {
    throw new Error(`cfn-deploy "${stack}": the adoption is already taken by ${adoption.outcome.member}; --adopt adopts into one stack, so a component with two cfn-deploy steps cannot take it`);
  }
  const finish = (plan: CfnAdoptionPlan | undefined, result: CfnAdoptionOutcome): DeployAdoptionOutcome => {
    adoption.outcome = adoptionOutcome(stack, ctx, plan, result);
    return adoption.outcome;
  };
  const refuse = (refusals: string[]): never => {
    const outcome = finish(undefined, { status: "refused", step: "plan", refusals });
    throw new Error(`cfn-deploy "${stack}": adoption refused: ${outcome.lines.join(" ")}`);
  };

  const template = readCfnTemplate(input.template);
  if (!template || typeof template.Resources !== "object" || template.Resources === null) {
    refuse([`the template ${input.template} cannot be read here as a CloudFormation JSON template; adoption plans from the built template`]);
  }
  const cfn = executor.cloudformation;
  if (!cfn.listStackResources) refuse(["this CloudFormation client cannot list the stack's resources, so it cannot tell which are already in the stack"]);
  let existing: string[];
  try {
    existing = await cfn.listStackResources!(stack);
  } catch (err) {
    return refuse([`could not list the resources of ${stack}: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const plan = planCfnAdoption({ template: template as unknown as CfnTemplate, adoption: adoption.adoption, index: adoption.index, existing: new Set(existing), ...(opts.manifest ? { manifest: opts.manifest } : {}) });
  if (plan.refusals.length > 0) refuse(plan.refusals);

  const parameters = flattenCfnInputs(input);
  const result = await adoptIntoStack({
    cfn,
    stackName: stack,
    plan,
    ...(parameters ? { parameters } : {}),
    ...(opts.waitOptions ? { waitOptions: opts.waitOptions } : {}),
    review: (step, changeSet, lines) => {
      const request: AdoptionReviewRequest = {
        member: stack,
        step,
        changeSet: changeSet.changeSetName,
        entries: changeSet.changes.map((c) => cfnChangeEntry(stack, c)),
        lines,
      };
      return adoption.review(request);
    },
  });
  const outcome = finish(plan, result);
  if (result.status !== "adopted") {
    throw new Error(`cfn-deploy "${stack}": adoption ${outcome.status}${outcome.step ? ` at the ${outcome.step} step` : ""}: ${outcome.lines.join(" ")}`);
  }
  const { stackStatus, outputs } = await cfn.describeStack(stack);
  return { stackStatus, outputs };
}
