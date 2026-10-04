/**
 * TF042: a Terragrunt `dependency` sets `skip_outputs = true` and
 * `mock_outputs`.
 *
 * With `skip_outputs = true` Terragrunt never reads the upstream unit's
 * outputs (`shouldGetOutputs` in `pkg/config/dependency.go`, v1.1.6), so the
 * only values the dependency can return are the mocks. Every plan and apply
 * the mocks are allowed for runs on them, however far the upstream unit has
 * been applied. The pair is sometimes meant, to break a cycle or to avoid
 * reading state, and then the mock values are the configuration; that is
 * worth writing as inputs, which a reader of the unit can see.
 *
 * Only a literal `skip_outputs = true` is reported. A `skip_outputs` built
 * from an expression is not determined.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { TERRAGRUNT_DEPENDENCY_TYPE } from "../../hcl/parse";
import { terragruntEntities } from "./terragrunt";

export const tf042: PostSynthCheck = {
  id: "TF042",
  description: "Terragrunt dependency sets skip_outputs together with mock_outputs",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const dep of terragruntEntities(ctx.entities, TERRAGRUNT_DEPENDENCY_TYPE)) {
      if (dep.body.skip_outputs !== true || dep.body.mock_outputs === undefined) continue;
      diagnostics.push({
        checkId: "TF042",
        severity: "warning",
        message:
          `Dependency "${dep.address.replace(/^dependency\./, "")}" in ${dep.file} sets \`skip_outputs = true\` with \`mock_outputs\`. ` +
          "Terragrunt then never reads the upstream unit's outputs, so every plan and apply runs on the mock values. " +
          "Drop `skip_outputs`, or pass the values as `inputs` so they are visible as configuration.",
        entity: dep.key,
        lexicon: "terraform",
      });
    }
    return diagnostics;
  },
};
