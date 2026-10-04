/**
 * TF038: an `oci://` module source names no tag and no digest, or a mutable
 * tag.
 *
 * OpenTofu resolves an OCI module source with no `tag` to the `latest` tag
 * (https://opentofu.org/docs/language/modules/sources/), so an unpinned source
 * and `?tag=latest` are the same thing: a push to the registry changes what
 * the root provisions with no diff to review. A digest, or an exact version
 * tag, holds it. `classifyModuleSource` (`./module-source.ts`) reads the tag
 * and digest from either spelling.
 *
 * A warning rather than an error: a registry can make a version tag
 * immutable, and a source that names `?tag=1.4.0` is read as pinned here
 * whether or not the registry enforces that. A digest is the only pin the
 * registry cannot move, which the message says. A source that names a digest
 * is never flagged, whatever tag sits beside it.
 *
 * Scope: root and child modules alike (#2112), same as TF004 and TF005.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { MODULE_TYPE, type BlockBody } from "../../hcl/parse";
import { classifyModuleSource, isMutableOciTag } from "./module-source";

export const tf038: PostSynthCheck = {
  id: "TF038",
  description: "OCI module source has no tag or digest, or a mutable tag",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [key, entity] of ctx.entities) {
      if (entity.entityType !== MODULE_TYPE || !isResourceDeclarable(entity)) continue;
      const props = entity.props as { address?: unknown; body?: unknown };
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const source = typeof body.source === "string" ? body.source : undefined;
      if (source === undefined) continue;

      const classified = classifyModuleSource(source);
      if (classified.kind !== "oci" || classified.digest) continue;

      const address = typeof props.address === "string" ? props.address : key;
      let message: string | undefined;
      if (!classified.tag) {
        message =
          `Module "${address}" sources "${source}" with no tag or digest, so OpenTofu pulls the \`latest\` tag. ` +
          "Pin it to a digest (`?digest=sha256:...`) or an exact version tag (`?tag=1.4.0`).";
      } else if (isMutableOciTag(classified.tag)) {
        message =
          `Module "${address}" sources "${source}" with the mutable tag "${classified.tag}". ` +
          "Pin it to a digest (`?digest=sha256:...`) or an exact version tag (`?tag=1.4.0`).";
      }
      if (!message) continue;

      diagnostics.push({
        checkId: "TF038",
        severity: "warning",
        message,
        entity: key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
