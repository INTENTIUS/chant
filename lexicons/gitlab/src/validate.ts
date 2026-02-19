/**
 * Semantic validation for GitLab CI lexicon artifacts.
 *
 * Checks that generated files exist, contain expected entities,
 * and pass basic structural validation.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface ValidateCheck {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ValidateResult {
  success: boolean;
  checks: ValidateCheck[];
}

const EXPECTED_RESOURCES = ["Job", "Default", "Workflow"];
const EXPECTED_PROPERTIES = [
  "Artifacts", "Cache", "Image", "Rule", "Retry",
  "AllowFailure", "Parallel", "Include", "Release",
  "Environment", "Trigger", "AutoCancel",
];

/**
 * Validate lexicon artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const generatedDir = join(basePath, "src", "generated");
  const checks: ValidateCheck[] = [];

  // Check files exist
  for (const file of ["lexicon-gitlab.json", "index.d.ts", "index.ts", "runtime.ts"]) {
    const path = join(generatedDir, file);
    checks.push({
      name: `${file} exists`,
      ok: existsSync(path),
      error: existsSync(path) ? undefined : `File not found: ${path}`,
    });
  }

  // Validate lexicon JSON structure
  const lexiconPath = join(generatedDir, "lexicon-gitlab.json");
  if (existsSync(lexiconPath)) {
    try {
      const content = readFileSync(lexiconPath, "utf-8");
      const registry = JSON.parse(content);
      const entries = Object.keys(registry);

      // Check expected count
      const expectedCount = EXPECTED_RESOURCES.length + EXPECTED_PROPERTIES.length;
      checks.push({
        name: `lexicon-gitlab.json has ${expectedCount} entries`,
        ok: entries.length === expectedCount,
        error: entries.length !== expectedCount
          ? `Expected ${expectedCount} entries, found ${entries.length}`
          : undefined,
      });

      // Check resource entities present
      for (const name of EXPECTED_RESOURCES) {
        const entry = registry[name];
        const ok = entry !== undefined && entry.kind === "resource";
        checks.push({
          name: `resource ${name} present`,
          ok,
          error: ok ? undefined : `Missing or invalid resource entry: ${name}`,
        });
      }

      // Check property entities present
      for (const name of EXPECTED_PROPERTIES) {
        const entry = registry[name];
        const ok = entry !== undefined && entry.kind === "property";
        checks.push({
          name: `property ${name} present`,
          ok,
          error: ok ? undefined : `Missing or invalid property entry: ${name}`,
        });
      }

      // Check all entries have required fields
      for (const [name, entry] of Object.entries(registry)) {
        const e = entry as Record<string, unknown>;
        const hasRequired = e.resourceType && e.kind && e.lexicon === "gitlab";
        checks.push({
          name: `${name} has required fields`,
          ok: !!hasRequired,
          error: hasRequired ? undefined : `Entry ${name} missing required fields`,
        });
      }
    } catch (err) {
      checks.push({
        name: "lexicon-gitlab.json is valid JSON",
        ok: false,
        error: `Parse error: ${err}`,
      });
    }
  }

  // Validate index.d.ts has class declarations
  const dtsPath = join(generatedDir, "index.d.ts");
  if (existsSync(dtsPath)) {
    const dts = readFileSync(dtsPath, "utf-8");
    for (const name of [...EXPECTED_RESOURCES, ...EXPECTED_PROPERTIES]) {
      const has = dts.includes(`export declare class ${name}`);
      checks.push({
        name: `index.d.ts declares ${name}`,
        ok: has,
        error: has ? undefined : `Missing class declaration: ${name}`,
      });
    }
  }

  return {
    success: checks.every((c) => c.ok),
    checks,
  };
}
