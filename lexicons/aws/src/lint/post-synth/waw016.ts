/**
 * WAW016: Deprecated Property Usage
 *
 * Flags properties marked as deprecated in the CloudFormation Registry.
 * Sources: explicit `deprecatedProperties` array + description text mining.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

interface LexiconEntry {
  kind: string;
  resourceType: string;
  deprecatedProperties?: string[];
  [key: string]: unknown;
}

/**
 * Load deprecated properties per resource type from the lexicon JSON.
 */
function loadDeprecatedProperties(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  try {
    const pkgDir = join(__dirname, "..", "..", "..");
    const lexiconPath = join(pkgDir, "src", "generated", "lexicon-aws.json");
    const content = readFileSync(lexiconPath, "utf-8");
    const data = JSON.parse(content) as Record<string, LexiconEntry>;

    for (const [_name, entry] of Object.entries(data)) {
      if (entry.kind === "resource" && entry.resourceType && entry.deprecatedProperties && entry.deprecatedProperties.length > 0) {
        map.set(entry.resourceType, new Set(entry.deprecatedProperties));
      }
    }
  } catch {
    // Lexicon not available — skip
  }
  return map;
}

/**
 * Core detection logic — exported for direct testing with synthetic data.
 */
export function checkDeprecatedProperties(
  ctx: PostSynthContext,
  deprecated: Map<string, Set<string>>,
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
      for (const propName of Object.keys(props)) {
        if (deprProps.has(propName)) {
          diagnostics.push({
            checkId: "WAW016",
            severity: "warning",
            message: `Resource "${logicalId}" (${resource.Type}) uses deprecated property "${propName}" — consider alternatives`,
            entity: logicalId,
            lexicon: "aws",
          });
        }
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
