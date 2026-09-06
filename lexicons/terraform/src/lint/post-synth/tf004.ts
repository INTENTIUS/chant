/**
 * TF004: a registry-sourced `module` block has no `version`.
 *
 * "Registry-sourced" means `source` parses as a Terraform module registry
 * address (`classifyModuleSource`, `./module-source.ts`): a bare
 * `namespace/name/target-system`, or a hostname-prefixed
 * `host/namespace/name/target-system`. Without `version`, `terraform init`
 * always resolves to the newest release that satisfies no constraint at
 * all, so an upstream module release can change what a root provisions with
 * no local edit and no diff to review first.
 *
 * A local (`./`, `../`) or git/hg source is never flagged here: git/hg is
 * TF005's territory, and a local source cannot carry a registry version at
 * all. One diagnostic per module block.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { MODULE_TYPE, type BlockBody } from "../../hcl/parse";
import { classifyModuleSource } from "./module-source";

export const tf004: PostSynthCheck = {
  id: "TF004",
  description: "Registry-sourced module block has no version",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [key, entity] of ctx.entities) {
      if (entity.entityType !== MODULE_TYPE || !isResourceDeclarable(entity)) continue;
      const props = entity.props as { root?: unknown; address?: unknown; body?: unknown };
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const source = typeof body.source === "string" ? body.source : undefined;
      if (source === undefined) continue;
      if (classifyModuleSource(source).kind !== "registry") continue;

      const version = body.version;
      if (typeof version === "string" && version.trim() !== "") continue;

      const address = typeof props.address === "string" ? props.address : key;
      diagnostics.push({
        checkId: "TF004",
        severity: "warning",
        message:
          `Module "${address}" sources "${source}" from a registry with no \`version\`. ` +
          "`terraform init` resolves to the newest release with no constraint to hold it back. " +
          "Add a `version` constraint (e.g. `~> 5.0`).",
        entity: key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
