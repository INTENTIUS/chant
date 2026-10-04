/**
 * TF039: a registry module's `version` is a range, not an exact version.
 *
 * TF004 flags a registry module with no `version`; a `version` of `~> 1.4`,
 * `>= 1.4` or `>= 1.0, < 2.0` passes it, yet an upstream release inside the
 * range changes what the root provisions with no diff to review. This rule is
 * for projects that pin modules to one version (`1.4.0` or `= 1.4.0`).
 *
 * Off by default: it is a `report-only` catalog entry, so the `recommended`
 * preset leaves it out and `lint.presets: { terraform: "all" }` (or a
 * `lint.rules` entry for TF039) turns it on. Ranges are common and often
 * intended, so a default warning would be noise for most roots. It is a
 * separate rule from TF004 because a post-synth check receives no options
 * (`PostSynthCheck.check(ctx)`), while the preset mechanism already carries
 * exactly this on/off choice per rule id (#3190).
 *
 * A module that has no `version` is TF004's finding and is skipped here.
 *
 * Scope: root and child modules alike (#2112).
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { MODULE_TYPE, type BlockBody } from "../../hcl/parse";
import { classifyModuleSource, isExactVersionConstraint } from "./module-source";

export const tf039: PostSynthCheck = {
  id: "TF039",
  description: "Registry module version is a range, not an exact version",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [key, entity] of ctx.entities) {
      if (entity.entityType !== MODULE_TYPE || !isResourceDeclarable(entity)) continue;
      const props = entity.props as { address?: unknown; body?: unknown };
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const source = typeof body.source === "string" ? body.source : undefined;
      if (source === undefined || classifyModuleSource(source).kind !== "registry") continue;

      const version = body.version;
      if (typeof version !== "string" || version.trim() === "") continue;
      if (isExactVersionConstraint(version)) continue;

      const address = typeof props.address === "string" ? props.address : key;
      diagnostics.push({
        checkId: "TF039",
        severity: "warning",
        message:
          `Module "${address}" sources "${source}" with the version range "${version}". ` +
          "A release inside the range changes what the root provisions with no diff to review. " +
          'Pin an exact version (`version = "1.4.0"`).',
        entity: key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
