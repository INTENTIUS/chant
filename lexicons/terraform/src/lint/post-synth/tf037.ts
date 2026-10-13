/**
 * TF037: an ECR repository lets an image tag be repointed (chant #2288, epic
 * #2284).
 *
 * The Terraform counterpart of the aws lexicon's WAW054, written natively.
 *
 * Absence is insecure for this resource, and the rule reports it.
 * `aws_ecr_repository.image_tag_mutability` (provider
 * `internal/service/ecr/repository.go`, v6.67.0) is optional with
 * `Default: MUTABLE`, so a repository that does not set it lets anyone with
 * push access move a tag (`prod`, `v1.4.2`) to different image content after
 * it was deployed, scanned or signed.
 *
 * Provider v6 accepts four values (AWS added the two `_WITH_EXCLUSION` modes
 * in 2025), and the rule reads them as follows:
 *
 * - `IMMUTABLE`: secure.
 * - `IMMUTABLE_WITH_EXCLUSION`: secure. Tags matching an
 *   `image_tag_mutability_exclusion_filter` stay mutable, a written-down
 *   exception such as `latest`. A filter that is nothing but `*` excludes
 *   every tag, so it is a finding; a filter from an expression is not
 *   determined.
 * - `MUTABLE`, absent, and `MUTABLE_WITH_EXCLUSION` (every tag mutable except
 *   those the filters name): a finding.
 * - an expression: not determined.
 *
 * Scope: root and child modules alike (#2112).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { TerraformBlock } from "./blocks";
import { finding, nestedBodies, notDetermined, readString, resourcesOfType } from "./flat-attributes";

const ID = "TF037";

const FIX =
  'Set `image_tag_mutability = "IMMUTABLE"` and push a new tag for each build, or `"IMMUTABLE_WITH_EXCLUSION"` with ' +
  "an `image_tag_mutability_exclusion_filter` for the few moving tags (`latest`) that must stay mutable.";

const TAIL = "TF037 does not evaluate expressions, so it cannot tell whether this repository's tags are immutable.";

/** A diagnostic for an `IMMUTABLE_WITH_EXCLUSION` repository, or nothing. */
function checkExclusions(block: TerraformBlock): PostSynthDiagnostic | undefined {
  for (const [i, f] of nestedBodies(block.body, "image_tag_mutability_exclusion_filter").entries()) {
    const filter = readString(f, "filter");
    if (filter.kind === "unknown") {
      return notDetermined(ID, block, `exclusion filter ${i + 1}: ${filter.reason}`, TAIL);
    }
    if (filter.kind === "known" && /^\*+$/.test(filter.value)) {
      return finding(
        ID,
        "error",
        block,
        `is \`IMMUTABLE_WITH_EXCLUSION\`, but exclusion filter ${i + 1} is "${filter.value}", which matches every tag, ` +
          `so every tag stays mutable. ${FIX}`,
      );
    }
  }
  if (nestedBodies(block.body, "dynamic").some((d) => d.image_tag_mutability_exclusion_filter !== undefined)) {
    return notDetermined(ID, block, 'has a `dynamic "image_tag_mutability_exclusion_filter"` block', TAIL);
  }
  return undefined;
}

export const tf037: PostSynthCheck = {
  id: "TF037",
  description: "ECR repository allows mutable image tags",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const block of resourcesOfType(ctx, "aws_ecr_repository")) {
      const mode = readString(block.body, "image_tag_mutability");
      if (mode.kind === "unknown") {
        out.push(notDetermined(ID, block, mode.reason, TAIL));
        continue;
      }
      if (mode.kind === "known" && mode.value === "IMMUTABLE") continue;
      if (mode.kind === "known" && mode.value === "IMMUTABLE_WITH_EXCLUSION") {
        const d = checkExclusions(block);
        if (d) out.push(d);
        continue;
      }
      const how =
        mode.kind === "absent"
          ? "does not set `image_tag_mutability`, and the provider default is `MUTABLE`"
          : mode.value === "MUTABLE_WITH_EXCLUSION"
            ? "is `MUTABLE_WITH_EXCLUSION`, so every tag the exclusion filters do not name stays mutable"
            : `sets \`image_tag_mutability = "${mode.value}"\``;
      out.push(
        finding(
          ID,
          "error",
          block,
          `${how}: a pushed tag can later be repointed at different image content, so what was deployed, scanned or ` +
            `signed under that tag is no longer what it names. ${FIX}`,
        ),
      );
    }
    return out;
  },
};
