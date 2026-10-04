/**
 * TF040: a root that uses providers has no `.terraform.lock.hcl`.
 *
 * The lock file records the provider versions and hashes `terraform init`
 * selected. Without it, each `init` resolves `required_providers` constraints
 * afresh, so a provider release changes a plan with no diff. None of
 * TF001 to TF029 looks at it.
 *
 * "Committed" is decided by presence: the file sits beside the root's `.tf`
 * files in the source tree being parsed (`props.lockFile`, stamped by
 * `parseTerraformRootDir` and by the local audit path). Whether git tracks it
 * is not asked, so a lock file that is present but gitignored counts as
 * committed. A parse with no directory to look in (a fetched repository,
 * inline source) leaves `lockFile` unset and the rule reports nothing: not
 * determined, not clean.
 *
 * A root that implies no provider (no `provider` block and no resource or data
 * type) gets no lock file from `init`, so it is skipped, as is a live
 * choudoufu root, which runs no `init`. One diagnostic per root, anchored on
 * the first block that implies a provider.
 *
 * Off by default (`report-only` tier), since many estates run `init` in CI and
 * never commit the file.
 *
 * Scope: root modules only (#2112); a child module has no lock file of its own.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { LOCK_FILENAME } from "../../hcl/parse";
import { isRootScoped } from "./scope";
import { impliedProviders } from "./tf002";

export const tf040: PostSynthCheck = {
  id: "TF040",
  description: "Root has no committed .terraform.lock.hcl",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const missing = new Set<string>();

    for (const entity of ctx.entities.values()) {
      if (!isResourceDeclarable(entity) || !isRootScoped(entity)) continue;
      const props = entity.props as { root?: unknown; lockFile?: unknown; mode?: unknown };
      if (props.lockFile !== false || props.mode === "live" || typeof props.root !== "string") continue;
      missing.add(props.root);
    }

    for (const root of [...missing].sort()) {
      const implied = impliedProviders(ctx.entities, root);
      if (implied.size === 0) continue;
      const names = [...implied.keys()].sort();
      diagnostics.push({
        checkId: "TF040",
        severity: "warning",
        message:
          `Root module "${root}" uses ${names.length === 1 ? "provider" : "providers"} ${names.map((n) => `"${n}"`).join(", ")} ` +
          `but has no ${LOCK_FILENAME} beside its .tf files. Run \`terraform init\` and commit the file, ` +
          "so every init selects the same provider versions.",
        entity: implied.get(names[0]),
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
