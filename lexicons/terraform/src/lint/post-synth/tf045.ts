/**
 * TF045: no Terragrunt config sets `terragrunt_version_constraint`.
 *
 * The attribute makes Terragrunt refuse to run on a release outside the range.
 * Without it each machine and each CI image runs whatever Terragrunt it
 * installed, and a behaviour change between releases reaches a plan with no
 * diff. It is usually set once, in the root config every unit includes.
 *
 * The rule looks at the whole set of configs in the scan and reports once. It
 * reports only when the set holds a config that includes no other file (the
 * root config, or a self-contained unit) and none of the configs sets the
 * attribute. A set made only of units that include a parent it did not read,
 * such as one unit directory passed alone, is not determined: the parent may
 * set it. The finding is anchored on `root.hcl` when the set has one.
 *
 * Off by default: the `report-only` tier keeps it out of the `recommended`
 * preset, since many repos pin Terragrunt in the toolchain (`.tool-versions`,
 * a CI image) rather than in config.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { TERRAGRUNT_CONFIG_TYPE } from "../../hcl/parse";
import { terragruntEntities } from "./terragrunt";

export const tf045: PostSynthCheck = {
  id: "TF045",
  description: "No Terragrunt config sets terragrunt_version_constraint",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const configs = terragruntEntities(ctx.entities, TERRAGRUNT_CONFIG_TYPE);
    if (configs.some((c) => c.body.terragrunt_version_constraint !== undefined)) return [];
    const tops = configs.filter((c) => Array.isArray(c.body.includes) && c.body.includes.length === 0);
    if (tops.length === 0) return [];
    const anchor = [...tops].sort((a, b) => Number(b.file === "root.hcl") - Number(a.file === "root.hcl") || a.key.localeCompare(b.key))[0];
    return [
      {
        checkId: "TF045",
        severity: "warning",
        message:
          `No Terragrunt config sets \`terragrunt_version_constraint\` (${anchor.file} is the top config read). ` +
          'Set it once in the root config, for example `terragrunt_version_constraint = ">= 1.1.0"`, so every machine runs a release the repo was tested with.',
        entity: anchor.key,
        lexicon: "terraform",
      },
    ];
  },
};
