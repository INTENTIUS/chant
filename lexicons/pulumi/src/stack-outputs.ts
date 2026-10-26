/**
 * A Pulumi stack's outputs (#4453), the seam C5 (#4455) reads to feed chant
 * parameters from a Pulumi member.
 *
 * A stack's outputs are the outputs of its root `pulumi:pulumi:Stack`
 * resource. Deployed values come from a `pulumi stack export`
 * (`deployment.resources[]`), planned ones from a `pulumi preview --json`
 * step on the stack (`newState.outputs`), where a value known only after
 * apply is Pulumi's unknown sentinel. Each output says which: a known value,
 * `unknown: true`, or `secret: true` with no value. C5 holds a dependent
 * back on an unknown output, as chant holds back roots waiting on unknown
 * terraform outputs.
 *
 * Recorded against the plunge corpus (#4475): `pulumi preview --json` (3.272.0)
 * prints the stack's step with no `outputs` at all, so a real preview plans
 * no stack outputs. {@link pulumiPlannedStackOutputs} reads `newState.outputs`
 * when a step carries them and is undefined when it does not, which
 * `member-outputs` turns into the exported outputs (nothing to apply) or
 * every output unknown (a change planned).
 */
import { PULUMI_STACK_TYPE } from "@intentius/chant/pulumi-urn";
import { pulumiSteps } from "./change-set";
import { holdsSecret, holdsUnknown, isObject, propertyKeys, type Json } from "./values";

/** One stack output. */
export interface PulumiStackOutput {
  name: string;
  /** The value, when known and not secret. */
  value?: unknown;
  /** Known only after apply. */
  unknown?: true;
  /** A secret: the value is not carried. */
  secret?: true;
}

function outputsOf(map: Json | undefined): PulumiStackOutput[] {
  return propertyKeys(map)
    .sort()
    .map((name) => {
      const v = map![name];
      if (holdsSecret(v)) return { name, secret: true as const };
      if (holdsUnknown(v)) return { name, unknown: true as const };
      return { name, value: v };
    });
}

/** The outputs a `pulumi stack export` records for the stack: what the last apply produced. */
export function pulumiExportedStackOutputs(exported: unknown): PulumiStackOutput[] {
  const deployment = isObject(exported) && isObject(exported.deployment) ? exported.deployment : {};
  const resources = Array.isArray(deployment.resources) ? deployment.resources : [];
  const stack = resources.find((r) => isObject(r) && r.type === PULUMI_STACK_TYPE) as Json | undefined;
  return outputsOf(isObject(stack?.outputs) ? (stack!.outputs as Json) : undefined);
}

/**
 * The outputs a `pulumi preview --json` plans for the stack, unknowns marked. Undefined when the preview has no
 * stack step, or a stack step that carries no outputs, which is what a real preview prints.
 */
export function pulumiPlannedStackOutputs(preview: unknown): PulumiStackOutput[] | undefined {
  const step = (pulumiSteps(preview) ?? []).find((s) => (s.newState?.type ?? s.oldState?.type) === PULUMI_STACK_TYPE);
  // Only the new state plans: a `same` stack step's old state holds the last deployment's outputs, which a change
  // elsewhere in the stack can move (recorded, #4475: a replaced VPC's id).
  const outputs = step?.newState?.outputs;
  if (!step || !isObject(outputs)) return undefined;
  return outputsOf(outputs);
}
