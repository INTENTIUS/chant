/**
 * TF043: a Terragrunt unit's `terraform.source` names no version.
 *
 * A git source with no `?ref=` follows the default branch, a `tfr://` source
 * with no `?version=` follows the registry's latest release, and an `oci://`
 * source with no tag or digest pulls `latest`. A push or a release changes
 * what the unit provisions with no diff to review. TF005 and TF038 do the same
 * for `module` blocks; a Terragrunt unit has no `module` block, its source is
 * the `source` argument of the `terraform` block.
 *
 * A local path and a source built from an expression (`${local.base}//x`) are
 * not determined and pass. A mutable `?ref=main` is not judged
 * here: the rule asks only whether a version is named.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { TERRAGRUNT_SOURCE_TYPE } from "../../hcl/parse";
import { classifyTerragruntSource, terragruntEntities } from "./terragrunt";

const FIX: Record<string, string> = {
  git: "Add `?ref=` with a tag or commit SHA.",
  tfr: "Add `?version=` with an exact version.",
  oci: "Add `?digest=sha256:...` or `?tag=` with an exact version tag.",
};

export const tf043: PostSynthCheck = {
  id: "TF043",
  description: "Terragrunt terraform.source names no version (git ref, tfr version or oci tag)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const block of terragruntEntities(ctx.entities, TERRAGRUNT_SOURCE_TYPE)) {
      const source = block.body.source;
      if (typeof source !== "string") continue;
      const classified = classifyTerragruntSource(source);
      if (classified.pinned !== false) continue;
      diagnostics.push({
        checkId: "TF043",
        severity: "warning",
        message:
          `The \`terraform\` block in ${block.file} sources "${source}" with no version, so a push or a release changes the unit with no diff to review. ` +
          FIX[classified.kind],
        entity: block.key,
        lexicon: "terraform",
      });
    }
    return diagnostics;
  },
};
