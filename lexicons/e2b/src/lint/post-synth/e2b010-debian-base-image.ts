/**
 * E2B010: a template starts from a Debian-based image.
 *
 * E2B turns a template's image into a microVM filesystem and boots it with its
 * own init and agent, which it supports on Debian-based images only. An Alpine
 * image builds as a Dockerfile but does not boot as a sandbox, so the mistake
 * otherwise shows up as a failed `e2b template build` or a sandbox that never
 * starts.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { templateProps } from "../../resources";

/** Image references that name an Alpine base, by repository or by tag. */
export function isAlpineImage(image: string): boolean {
  const ref = image.toLowerCase().split("@")[0];
  const segment = ref.slice(ref.lastIndexOf("/") + 1);
  const [repo, tag = ""] = segment.split(":");
  return repo === "alpine" || /(^|-)alpine/.test(tag);
}

export const e2b010: PostSynthCheck = {
  id: "E2B010",
  description: "A Template's fromImage must be Debian-based; E2B does not boot Alpine images",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [name, entity] of ctx.entities) {
      const props = templateProps(entity);
      if (!props || typeof props.fromImage !== "string" || !isAlpineImage(props.fromImage)) continue;
      diagnostics.push({
        checkId: "E2B010",
        severity: "error",
        message: `Template "${name}" starts from ${props.fromImage}, an Alpine image. E2B sandboxes need a Debian-based image, such as node:22-bookworm.`,
        entity: name,
        lexicon: "e2b",
      });
    }
    return diagnostics;
  },
};
