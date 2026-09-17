/**
 * TF029: a live root names its estate twice - once in `terraform.roots.<name>.estate`
 * and once in its own HCL, in a `live { }` block or an `estate.chdf.hcl` sidecar.
 *
 * The two are not equal in authority. A declaration is what choudoufu reads
 * for itself; `terraform.roots.<name>.estate` (#2479) is what this lexicon
 * would otherwise hand it as `-estate`. choudoufu refuses that flag beside a
 * declaration outright - "This configuration's live block is what names its
 * estate, and `-estate=...` would name a second one for this run only"
 * (`internal/command/live_plan.go`) - so this lexicon does not pass it, and
 * the config value is simply not used.
 *
 * That is the whole problem. A setting written down and silently ignored is
 * worse than one that errors: an author who moves an environment by editing
 * `roots.app.estate` gets a run against the old estate and no indication
 * anything was disregarded. Refusing the pair at build time turns a silent
 * wrong-estate run into a message naming both places.
 *
 * The fix is to pick one. A root whose directory is shared across
 * environments should declare no estate in HCL and name it per root here; a
 * root with its own `live` block already has an estate and needs nothing in
 * chant.config.
 *
 * One diagnostic per root, fired from the root's `Terraform::Live` entity -
 * the same entity TF024, TF025 and TF026 fire from.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { LIVE_TYPE } from "../../hcl/parse";

export const tf029: PostSynthCheck = {
  id: "TF029",
  description: "Live root names its estate both in chant.config and in its own HCL",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const flagged = new Set<string>();

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== LIVE_TYPE) continue;
      if (!isResourceDeclarable(entity)) continue;
      const props = entity.props as { root?: unknown; estate?: unknown; configEstate?: unknown };

      // Both halves must be present. A root with only a declaration is the
      // ordinary case; a root with only a config estate is exactly what
      // #2479 added and must stay silent, or the feature would refuse
      // itself.
      const declared = typeof props.estate === "string" ? props.estate : undefined;
      const configured = typeof props.configEstate === "string" ? props.configEstate : undefined;
      if (declared === undefined || configured === undefined) continue;

      const root = typeof props.root === "string" ? props.root : "";
      if (flagged.has(root)) continue;
      flagged.add(root);

      // Say both values even when they agree. Two settings that happen to
      // match today still means one of them is doing nothing, and the next
      // edit to the ignored one is the incident this rule exists to prevent.
      const sameNote =
        declared === configured
          ? " They name the same estate today, which makes this harmless until one of them is edited - at which point the edit to the config value would be silently ignored."
          : "";

      diagnostics.push({
        checkId: "TF029",
        severity: "error",
        message:
          `Root "${root}" names its estate twice: terraform.roots.${root}.estate = "${configured}" in chant.config, ` +
          `and "${declared}" in its own HCL. The declaration wins - choudoufu refuses \`-estate\` beside one, so ` +
          `this lexicon never passes the config value and it has no effect.${sameNote} ` +
          `Remove terraform.roots.${root}.estate, or remove the estate from the root's \`live\` block / ` +
          `\`estate.chdf.hcl\` sidecar so the root can be pointed at an estate per environment.`,
        entity: name,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
