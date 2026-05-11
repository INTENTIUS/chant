import { readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
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
 * Walk up from `from` until a directory containing `.chant/rules/` is found,
 * or until we hit the filesystem root or a non-project boundary (a directory
 * with `package.json` but no `.chant/rules/` — that's the project root and
 * we stop there even if no rules dir exists).
 *
 * Returns the absolute path to the discovered `.chant/rules/` directory, or
 * null if none was found before we crossed the project root.
 */
function findRulesDir(from: string): string | null {
  let cur = resolve(from);
  while (true) {
    const candidate = join(cur, ".chant", "rules");
    if (existsSync(candidate)) {
      return candidate;
    }
    // Stop at the nearest project root (where package.json sits) — going
    // above it would pick up rules belonging to an unrelated parent project.
    if (existsSync(join(cur, "package.json"))) {
      return null;
    }
    const parent = dirname(cur);
    if (parent === cur) {
      return null;
    }
    cur = parent;
  }
}

/**
 * Load local lint rules from `.chant/rules/`.
 *
 * Scans for `.ts` files in the nearest `.chant/rules/` directory found by
 * walking up from `projectDir` (stopping at the closest `package.json` to
 * avoid leaking into unrelated parent projects). Dynamically imports each
 * file and collects all exports that conform to the LintRule interface.
 *
 * @param projectDir - Directory the lint command was invoked against. May be
 *                     a sub-stack of a larger project — the rules dir is
 *                     resolved by walking up.
 * @returns Array of LintRule objects found in the discovered `.chant/rules/`.
 */
export async function loadLocalRules(projectDir: string): Promise<LintRule[]> {
  const rulesDir = findRulesDir(projectDir);

  if (rulesDir === null) {
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
