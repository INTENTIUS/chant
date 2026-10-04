/**
 * TF041: a Terragrunt `dependency` has `mock_outputs` and lets them stand in
 * for `apply`.
 *
 * `mock_outputs` is what a dependency returns when it has no outputs yet.
 * `mock_outputs_allowed_terraform_commands` limits which commands may use
 * them. Terragrunt reads a missing list and an empty list the same way, as no
 * limit (`shouldReturnMockOutputs` in `pkg/config/dependency.go`, v1.1.6:
 * `nil || len == 0 || slices.Contains(list, command)`). So a dependency with
 * mocks and no list, or a list that names `apply`, can apply the mock values
 * to real state when the upstream unit has not been applied, and the apply
 * reports success. The usual list is `["validate", "plan"]`.
 *
 * A list that is an expression (`local.mock_commands`) is not determined and
 * passes. A dependency with `enabled = false` returns its mocks whatever the
 * list says; that is a different decision and is not reported here.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { TERRAGRUNT_DEPENDENCY_TYPE } from "../../hcl/parse";
import { isExpression, terragruntEntities } from "./terragrunt";

export const tf041: PostSynthCheck = {
  id: "TF041",
  description: "Terragrunt dependency lets mock_outputs stand in for apply",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const dep of terragruntEntities(ctx.entities, TERRAGRUNT_DEPENDENCY_TYPE)) {
      if (dep.body.mock_outputs === undefined) continue;
      const allowed = dep.body.mock_outputs_allowed_terraform_commands;
      if (isExpression(allowed)) continue;

      let problem: string | undefined;
      if (allowed === undefined || (Array.isArray(allowed) && allowed.length === 0)) {
        problem =
          "sets no `mock_outputs_allowed_terraform_commands`, and Terragrunt reads a missing or empty list as every command";
      } else if (Array.isArray(allowed) && allowed.includes("apply")) {
        problem = 'lists "apply" in `mock_outputs_allowed_terraform_commands`';
      }
      if (problem === undefined) continue;

      diagnostics.push({
        checkId: "TF041",
        severity: "warning",
        message:
          `Dependency "${dep.address.replace(/^dependency\./, "")}" in ${dep.file} sets \`mock_outputs\` and ${problem}. ` +
          "An apply that runs before the upstream unit is applied writes the mock values to real state. " +
          'Set `mock_outputs_allowed_terraform_commands = ["validate", "plan"]`.',
        entity: dep.key,
        lexicon: "terraform",
      });
    }
    return diagnostics;
  },
};
