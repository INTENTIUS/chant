/**
 * github → forgejo migration entry point.
 *
 * Thin by design: Forgejo Actions YAML *is* GitHub Actions YAML, so the
 * migration applies the same dialect as a `chant build` (drop ignored keys,
 * resolve `uses:` refs, map runner labels) and emits the result. No stage
 * inference, job→script rewrite, or `!reference` intrinsic like the gitlab
 * migration needs. The differentiated value is the security-fate **compare**
 * (see ./security).
 */

import type { LintDiagnostic } from "@intentius/chant/lint/rule";
import { parseYAML, emitYAML } from "@intentius/chant/yaml";
import { transformWorkflowObject } from "../../dialect";
import {
  analyzeForgejoSecurity,
  provenanceToDiagnostics,
  renderSecurityPosture,
  type SecurityRecord,
} from "./security";

export interface MigrateOptions {
  /** Output format. Defaults to "yaml". */
  emit?: "yaml" | "ts";
  /** Source file path (display only). */
  sourceFile?: string;
  /** Escalate needs-review/lost findings to errors. */
  strict?: boolean;
  /** Accepted for parity with the core MigrationSource contract; forgejo
   *  always runs the (cheap) security analysis. */
  security?: boolean;
  /** Accepted for parity; forgejo has no composite rewriter. */
  useComposites?: boolean;
}

export interface MigrationResult {
  /** Rendered output (forgejo YAML by default, chant TS when emit: "ts"). */
  output: string;
  /** Per-property security-fate records. */
  provenance: SecurityRecord[];
  /** SARIF-shaped diagnostics derived from the records. */
  diagnostics: LintDiagnostic[];
  /** Markdown "Security posture" section. */
  securityPosture: string;
}

/** Emit a parsed/transformed workflow object back to YAML. */
function emitForgejoYaml(value: unknown): string {
  const body = emitYAML(value, 0);
  return (body.startsWith("\n") ? body.slice(1) : body) + "\n";
}

/** Emit a chant TypeScript pipeline (authored github-style, imported from forgejo). */
async function emitTs(content: string, opts: MigrateOptions): Promise<string> {
  const { GitHubActionsParser } = await import("@intentius/chant-lexicon-github/import/parser");
  const { GitHubActionsGenerator } = await import("@intentius/chant-lexicon-github/import/generator");
  const ir = new GitHubActionsParser().parse(content);
  const files = new GitHubActionsGenerator().generate(ir);
  const banner =
    `// Migrated from ${opts.sourceFile ?? "(stdin)"} by chant migrate (github → forgejo).\n` +
    `// Authored github-style; the forgejo lexicon applies its dialect on build.\n\n`;
  return (
    banner +
    files
      .map((f) => f.content.replace(/@intentius\/chant-lexicon-github/g, "@intentius/chant-lexicon-forgejo"))
      .join("\n")
  );
}

/**
 * Migrate a GitHub Actions workflow into a Forgejo workflow.
 *
 * @param content raw .github/workflows/*.yml content
 * @param opts    migration options
 */
export async function transform(content: string, opts: MigrateOptions = {}): Promise<MigrationResult> {
  const source = parseYAML(content);

  let output: string;
  if (opts.emit === "ts") {
    output = await emitTs(content, opts);
  } else {
    const { value } = transformWorkflowObject(source);
    output = emitForgejoYaml(value);
  }

  // The compare is computed against the *source* — that's where the dropped
  // keys still exist — so it reports what the move costs.
  const provenance = analyzeForgejoSecurity(source, { sourceFile: opts.sourceFile });
  const diagnostics = provenanceToDiagnostics(provenance, { strict: opts.strict });
  const securityPosture = renderSecurityPosture(provenance);

  return { output, provenance, diagnostics, securityPosture };
}

/**
 * Lightweight detector: does this content look like a GitHub Actions workflow?
 * Used by the plugin's `migrationSource("github")`.
 */
export function detectGitHubWorkflow(content: string): boolean {
  if (!/^\s*jobs\s*:/m.test(content)) return false;
  return /^\s*on\s*:/m.test(content) || /^\s*runs-on\s*:/m.test(content);
}
