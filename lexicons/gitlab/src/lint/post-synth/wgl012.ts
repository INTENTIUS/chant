/**
 * WGL012: Deprecated Property Usage
 *
 * Flags properties marked as deprecated in the GitLab CI schema.
 * Sources: description text mining (keywords like "Deprecated", "legacy").
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

interface LexiconEntry {
  kind: string;
  resourceType: string;
  deprecatedProperties?: string[];
  [key: string]: unknown;
}

/**
 * Load deprecated properties per entity type from the lexicon JSON.
 */
function loadDeprecatedProperties(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  try {
    const pkgDir = join(__dirname, "..", "..", "..");
    const lexiconPath = join(pkgDir, "src", "generated", "lexicon-gitlab.json");
    const content = readFileSync(lexiconPath, "utf-8");
    const data = JSON.parse(content) as Record<string, LexiconEntry>;

    for (const [_name, entry] of Object.entries(data)) {
      if (entry.resourceType && entry.deprecatedProperties && entry.deprecatedProperties.length > 0) {
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

  for (const [entityName, entity] of ctx.entities) {
    if (isPropertyDeclarable(entity)) continue;

    const entityType = (entity as Record<string, unknown>).entityType as string;
    const deprProps = deprecated.get(entityType);
    if (!deprProps) continue;

    const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
    if (!props) continue;

    for (const propName of Object.keys(props)) {
      if (deprProps.has(propName)) {
        diagnostics.push({
          checkId: "WGL012",
          severity: "warning",
          message: `Entity "${entityName}" (${entityType}) uses deprecated property "${propName}" — consider alternatives`,
          entity: entityName,
          lexicon: "gitlab",
        });
      }
    }
  }

  return diagnostics;
}

export const wgl012: PostSynthCheck = {
  id: "WGL012",
  description: "Deprecated property usage — flags properties marked as deprecated in the GitLab CI schema",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkDeprecatedProperties(ctx, loadDeprecatedProperties());
  },
};
