/**
 * WAW016: Deprecated Property Usage
 *
 * Flags properties marked as deprecated in the CloudFormation Registry.
 *
 * Two bases feed this, and the finding says which one it stands on (#1701).
 * A `declared` name comes from the Registry schema's own `deprecatedProperties`
 * array. An `inferred` name comes from a regex over the property description,
 * which also matches descriptions that mention the deprecation of a sibling
 * property, an enum value, or the thing the property configures. Declared is a
 * warning; inferred is reported at info and worded as a guess.
 *
 * A declared name is a flattened Registry pointer path (#1988), so most of them
 * are nested — `Tags/TagKey`, `Source/Decryption/Url`. The template is walked
 * along that path; matching top-level keys reached fewer than half of them.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

/** What a deprecation classification rests on. */
export type DeprecationBasis = "declared" | "inferred";

interface LexiconEntry {
  kind: string;
  resourceType: string;
  deprecatedProperties?: string[];
  inferredDeprecations?: string[];
  [key: string]: unknown;
}

/**
 * Load deprecated properties per resource type from the lexicon JSON, each
 * tagged with the basis it was classified on.
 */
function loadDeprecatedProperties(): Map<string, Map<string, DeprecationBasis>> {
  const map = new Map<string, Map<string, DeprecationBasis>>();
  try {
    const pkgDir = join(__dirname, "..", "..", "..");
    const lexiconPath = join(pkgDir, "src", "generated", "lexicon-aws.json");
    const content = readFileSync(lexiconPath, "utf-8");
    const data = JSON.parse(content) as Record<string, LexiconEntry>;

    for (const [_name, entry] of Object.entries(data)) {
      if (entry.kind !== "resource" || !entry.resourceType) continue;
      if (!entry.deprecatedProperties?.length) continue;

      const inferred = new Set(entry.inferredDeprecations ?? []);
      const byProp = new Map<string, DeprecationBasis>();
      for (const propName of entry.deprecatedProperties) {
        byProp.set(propName, inferred.has(propName) ? "inferred" : "declared");
      }
      map.set(entry.resourceType, byProp);
    }
  } catch {
    // Lexicon not available — skip
  }
  return map;
}

/**
 * True when `value` expresses `segments` — the flattened Registry pointer path
 * (#1988), which is a single key for a top-level property and `/`-joined for a
 * nested one.
 *
 * An array met where the pointer named a property is descended anyway: the
 * Registry elides the wildcard in some schemas, so `Tags/TagKey` addresses a
 * key inside the Tags array's items.
 */
function expressesPath(value: unknown, segments: string[]): boolean {
  if (segments.length === 0) return true;
  if (Array.isArray(value)) {
    const rest = segments[0] === "*" ? segments.slice(1) : segments;
    return value.some((item) => expressesPath(item, rest));
  }
  if (segments[0] === "*") return false;
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, segments[0])) return false;
  return expressesPath(obj[segments[0]], segments.slice(1));
}

/**
 * Core detection logic — exported for direct testing with synthetic data.
 */
export function checkDeprecatedProperties(
  ctx: PostSynthContext,
  deprecated: Map<string, Map<string, DeprecationBasis>>,
): PostSynthDiagnostic[] {
  if (deprecated.size === 0) return [];

  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      const deprProps = deprecated.get(resource.Type);
      if (!deprProps) continue;

      const props = resource.Properties ?? {};
      // Walk each declared path into the template, rather than matching
      // top-level template keys: over half the declared names are nested
      // (#1988), and a key comparison could never reach them.
      for (const [propName, basis] of deprProps) {
        if (!expressesPath(props, propName.split("/"))) continue;

        diagnostics.push({
          checkId: "WAW016",
          severity: basis === "declared" ? "warning" : "info",
          message:
            basis === "declared"
              ? `Resource "${logicalId}" (${resource.Type}) uses deprecated property "${propName}" — consider alternatives`
              : `Resource "${logicalId}" (${resource.Type}) uses property "${propName}", whose description reads as deprecated — the CloudFormation Registry does not declare it deprecated, so confirm before changing it`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw016: PostSynthCheck = {
  id: "WAW016",
  description: "Deprecated property usage — flags properties marked as deprecated in the CloudFormation Registry",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkDeprecatedProperties(ctx, loadDeprecatedProperties());
  },
};
