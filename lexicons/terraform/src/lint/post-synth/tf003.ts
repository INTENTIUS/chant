/**
 * TF003: a root's `terraform` block has no `required_version`.
 *
 * Sits on the same `terraform` block TF001 already walks. Without
 * `required_version`, a root can be applied by whatever Terraform binary
 * happens to be on the runner's `PATH`, and a binary upgrade that changes
 * behavior (a provider protocol bump, a changed default) surfaces as a
 * surprise plan diff instead of a version-check failure before anything runs.
 *
 * One diagnostic per root, fired once even if the root spreads its
 * `terraform` block across several files (a legacy-config split into
 * `terraform.tf` and `versions.tf`, say). A root with no `terraform` block
 * at all is out of scope, same as TF001 and TF002: the missing block is
 * their finding, not this one's.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { TERRAFORM_TYPE, type BlockBody } from "../../hcl/parse";

function hasRequiredVersion(body: BlockBody): boolean {
  return typeof body.required_version === "string" && body.required_version.trim() !== "";
}

export const tf003: PostSynthCheck = {
  id: "TF003",
  description: "Root module's terraform block has no required_version",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    /** Root name to the entity key of its first `terraform` block, and whether any block for it declares `required_version`. */
    const seen = new Map<string, { anchor: string; hasVersion: boolean }>();

    for (const [key, entity] of ctx.entities) {
      if (entity.entityType !== TERRAFORM_TYPE || !isResourceDeclarable(entity)) continue;
      const props = entity.props as { root?: unknown; body?: unknown };
      const root = typeof props.root === "string" ? props.root : "";
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;

      const existing = seen.get(root);
      const hasVersion = (existing?.hasVersion ?? false) || hasRequiredVersion(body);
      seen.set(root, { anchor: existing?.anchor ?? key, hasVersion });
    }

    for (const [root, { anchor, hasVersion }] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
      if (hasVersion) continue;
      diagnostics.push({
        checkId: "TF003",
        severity: "warning",
        message:
          `Root module "${root}"'s terraform block has no \`required_version\`. Without it, ` +
          "an upgraded Terraform binary can change behavior with no version-check failure to " +
          "flag it first. Add `required_version = \">= <lowest supported version>\"`.",
        entity: anchor,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
