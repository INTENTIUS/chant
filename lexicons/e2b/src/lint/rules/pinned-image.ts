import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { ts } from "@intentius/chant/lint/typescript";
import { at, property, templateLiterals } from "./template-literal";

/** An image reference with no tag or digest, or the `latest` tag. */
export function isFloatingImage(image: string): boolean {
  if (image.includes("@")) return false;
  const lastSegment = image.slice(image.lastIndexOf("/") + 1);
  const colon = lastSegment.indexOf(":");
  return colon === -1 || lastSegment.slice(colon + 1) === "latest";
}

/**
 * E2B002: A template's base image is pinned.
 *
 * A steward keeps one sandbox for months, but a template is rebuilt whenever
 * someone runs `e2b template build`. With `fromImage` untagged or on `latest`,
 * two builds of the same declaration can carry different Node or git
 * versions, and a steward made from the second behaves differently with no
 * change in the repository.
 */
export const pinnedImageRule: LintRule = {
  id: "E2B002",
  severity: "warning",
  category: "correctness",
  description: "A Template's fromImage should name a tag other than latest, or a digest",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];
    for (const obj of templateLiterals(sourceFile)) {
      const image = property(obj, "fromImage", sourceFile);
      if (image && ts.isStringLiteralLike(image) && image.text.length > 0 && isFloatingImage(image.text)) {
        diagnostics.push(
          at(sourceFile, image, "E2B002", "warning", `fromImage "${image.text}" is not pinned; name a version tag such as node:22-bookworm, or a digest.`),
        );
      }
    }
    return diagnostics;
  },
};
