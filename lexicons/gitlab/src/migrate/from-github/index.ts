/**
 * Public entry point for the GitHub Actions → GitLab CI migration tool.
 *
 * Lazy-imports `@intentius/chant-lexicon-github` so users who don't need
 * migration don't pay the install cost (the github lexicon is an optional
 * peer dependency of `@intentius/chant-lexicon-gitlab`).
 */

import type { TemplateIR } from "@intentius/chant/import/parser";
import type { LintDiagnostic } from "@intentius/chant/lint/rule";
import { ProvenanceAccumulator, type ProvenanceRecord } from "./provenance";
import { transformIR } from "./transformer";
import { emitGitlabYaml } from "./emit-yaml";
import { provenanceToDiagnostics } from "./diagnostics";
import type { ActionMappingRegistry } from "./actions/registry";
// Importing `./actions/index` triggers auto-registration of Tier 1
// marketplace action mappings into the default registry. This is the
// single chokepoint where the registry is wired up.
import "./actions/index";

export interface MigrateOptions {
  /** Output format. */
  emit?: "yaml" | "ts";
  /** Enable composite-pattern recognition (Node patterns in v1). */
  useComposites?: boolean;
  /** Source file path for provenance (display only). */
  sourceFile?: string;
  /** Inject a custom action mapping registry for testing. */
  registry?: ActionMappingRegistry;
  /** Escalate needs-review diagnostics to errors. */
  strict?: boolean;
}

export interface MigrationResult {
  /** GitLab IR (consumed by `chant import`-style tools downstream). */
  ir: TemplateIR;
  /** Rendered output (YAML by default, TS when emit: "ts"). */
  output: string;
  /** Per-key provenance records. */
  provenance: ProvenanceRecord[];
  /** SARIF-shaped diagnostics derived from provenance. */
  diagnostics: LintDiagnostic[];
  /** Inferred stage list. */
  stages: string[];
}

/**
 * Migrate a GitHub Actions workflow YAML into GitLab CI.
 *
 * @param yamlContent raw .github/workflows/*.yml content
 * @param opts        migration options
 */
export async function transform(
  yamlContent: string,
  opts: MigrateOptions = {},
): Promise<MigrationResult> {
  // Lazy-import the GitHub parser to keep the github lexicon dep optional.
  let GitHubActionsParser: typeof import("@intentius/chant-lexicon-github/import/parser").GitHubActionsParser;
  try {
    ({ GitHubActionsParser } = await import("@intentius/chant-lexicon-github/import/parser"));
  } catch {
    throw new Error(
      "chant migrate from github requires @intentius/chant-lexicon-github. " +
        "Install it: npm install --save-dev @intentius/chant-lexicon-github",
    );
  }

  const ghIR = new GitHubActionsParser().parse(yamlContent);
  const provAcc = new ProvenanceAccumulator();
  const { ir, stages } = await transformIR(ghIR, {
    sourceFile: opts.sourceFile,
    registry: opts.registry,
    provenance: provAcc,
  });

  let output: string;
  if (opts.emit === "ts") {
    // TS emit is added in commit #89; placeholder for now to keep types stable.
    output = "// chant migrate --emit ts is implemented in a follow-up commit.\n";
  } else {
    output = emitGitlabYaml(ir);
  }

  const provenance = provAcc.all();
  const diagnostics = provenanceToDiagnostics(provenance, { strict: opts.strict });

  return { ir, output, provenance, diagnostics, stages };
}

/**
 * Lightweight detector: does this YAML look like a GitHub Actions workflow?
 * Used by the plugin's `migrationSource("github")` extension.
 */
export function detectGitHubWorkflow(content: string): boolean {
  // Cheap detection: top-level `jobs:` + `on:` or `runs-on:` appearing nested.
  if (!/^\s*jobs\s*:/m.test(content)) return false;
  return /^\s*on\s*:/m.test(content) || /^\s*runs-on\s*:/m.test(content);
}

export { ProvenanceAccumulator } from "./provenance";
export type { ProvenanceRecord, ProvenanceCategory } from "./provenance";
export type { ActionMapping, ActionMapCtx, ActionMappedResult, ActionMappingRegistry } from "./actions/registry";
export { createRegistry, getDefaultRegistry, lookupAction } from "./actions/registry";
