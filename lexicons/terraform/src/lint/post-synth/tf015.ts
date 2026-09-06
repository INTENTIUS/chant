/**
 * TF015: a `backend` or `cloud` block inside a child module.
 *
 * Scope: child modules only. This is TF001's mirror image. TF001 wants a root
 * module to declare a backend, because a root without one keeps its state on
 * local disk. A child module must declare neither: state belongs to the root,
 * one state per root however many modules it calls, and Terraform says so
 * directly, "A backend block can only appear in the root module" and the
 * same for `cloud`. Depending on the version, the block is ignored with a
 * warning or the root refuses to initialize, and either way the block is a
 * claim about where state lives that the module does not get to make.
 *
 * The usual cause is a directory that used to be a root module and became a
 * child when someone factored it out, with its `terraform` block carried
 * along. The rest of that block is fine to keep: `required_version` and
 * `required_providers` are meaningful in a child module and are not reported
 * here.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { TERRAFORM_TYPE, type BlockBody, type TerraformEntity } from "../../hcl/parse";
import { hasBlock } from "./tf001";
import { isChildScoped } from "./scope";

export const tf015: PostSynthCheck = {
  id: "TF015",
  description: "Child module declares a backend or cloud block",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [key, entity] of ctx.entities) {
      if (entity.entityType !== TERRAFORM_TYPE || !isResourceDeclarable(entity)) continue;
      if (!isChildScoped(entity)) continue;

      const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const backend = hasBlock(body, "backend");
      const cloud = hasBlock(body, "cloud");
      if (!backend && !cloud) continue;

      const blockKind = backend ? "backend" : "cloud";
      diagnostics.push({
        checkId: "TF015",
        severity: "warning",
        message:
          `A child module's terraform block declares a ${blockKind} block. Only a root module may: ` +
          "state belongs to the root, one state file for every module it calls, so this block is either " +
          `ignored with a warning or refused at init. Delete the ${blockKind} block and leave the state ` +
          "configuration to the root module that calls this one.",
        entity: key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
