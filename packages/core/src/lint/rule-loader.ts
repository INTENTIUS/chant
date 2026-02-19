import { readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { LintRule } from "./rule";

/**
 * Type guard to check if a value conforms to the LintRule interface.
 */
function isLintRule(value: unknown): value is LintRule {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as Record<string, unknown>).id === "string" &&
    "severity" in value &&
    "category" in value &&
    "check" in value &&
    typeof (value as Record<string, unknown>).check === "function"
  );
}

/**
 * Load local lint rules from `.chant/rules/` directory.
 *
 * Scans for `.ts` files, dynamically imports each, and collects
 * all exports that conform to the LintRule interface.
 *
 * @param projectDir - Root directory of the project
 * @returns Array of LintRule objects found in `.chant/rules/`
 */
export async function loadLocalRules(projectDir: string): Promise<LintRule[]> {
  const rulesDir = join(projectDir, ".chant", "rules");

  if (!existsSync(rulesDir)) {
    return [];
  }

  const rules: LintRule[] = [];
  let entries: string[];

  try {
    entries = readdirSync(rulesDir);
  } catch {
    return [];
  }

  const tsFiles = entries.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"));

  for (const file of tsFiles) {
    const filePath = resolve(rulesDir, file);
    let mod: Record<string, unknown>;
    try {
      mod = await import(filePath);
    } catch (err) {
      throw new Error(
        `Failed to load rule file "${file}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (const value of Object.values(mod)) {
      if (isLintRule(value)) {
        rules.push(value);
      }
    }
  }

  return rules;
}
