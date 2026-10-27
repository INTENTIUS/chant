/**
 * `terraform-apply`'s engine facts for its span and op-wave run record
 * (INTENTIUS/chant#4555): the root, the binary that applied it, and whether
 * it applied the plan the wave decided. Core adds the plan's resource counts
 * by action, and writes every key under the CI product's prefix
 * (`terragucci.root`, `terragucci.binary`).
 */

import type { CapabilityTraceFacts } from "@intentius/chant/otlp";
import type { TerraformApplyStepInput, TerraformApplyStepOutput } from "./capability-plugin";

/** `traceFacts` for `terraform-apply` (#4555). `binary` is the config's `terraform.binary`, `terraform` when it names none. */
export function terraformTraceFacts(
  input: TerraformApplyStepInput,
  outcome: { output: TerraformApplyStepOutput } | { error: unknown },
  binary: string | undefined,
): CapabilityTraceFacts {
  const bin = (binary ?? "terraform").split(/[\\/]/).pop() || "terraform";
  return {
    attributes: {
      root: input.root,
      binary: bin,
      ...("output" in outcome && outcome.output ? { "apply.from_wave_plan": outcome.output.fromWavePlan, "apply.outputs": Object.keys(outcome.output.outputs ?? {}).length } : {}),
      ...(input.cone ? { "plan.cone": input.cone } : {}),
    },
  };
}
