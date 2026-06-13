/**
 * `chant migrate` command implementation.
 *
 * Dispatches to the target lexicon's `migrationSource(from)` extension hook.
 * The lexicon owns the actual translation logic; core orchestrates I/O,
 * stdout/stderr surfaces, and exit codes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { formatError, formatInfo } from "../format";
import { formatSarif } from "../reporters/stylish";
import type { LexiconPlugin } from "../../lexicon";
import type { LintRule, LintDiagnostic } from "../../lint/rule";

export interface MigrateCliOpts {
  sourceFile: string;
  from: string;
  to: string;
  emit: "yaml" | "ts";
  strict: boolean;
  validate: boolean;
  useComposites: boolean;
  output?: string;
  reportFile?: string;
  plugins: LexiconPlugin[];
}

export interface MigrateCliResult {
  exitCode: number;
  /** Bytes written (output) if any */
  output?: string;
  /** All diagnostic records */
  diagnostics: Array<Record<string, unknown>>;
  /** Provenance records (used for SARIF + Markdown report) */
  provenance: Array<Record<string, unknown>>;
  /** Error message if dispatch failed */
  error?: string;
  /** Markdown summary lines printed to stderr */
  markdownSummary?: string;
}

export async function migrateCommand(opts: MigrateCliOpts): Promise<MigrateCliResult> {
  const targetPlugin = opts.plugins.find((p) => p.name === opts.to);
  if (!targetPlugin) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Target lexicon "${opts.to}" is not installed`,
    };
  }
  if (!targetPlugin.migrationSource) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Lexicon "${opts.to}" does not support migration`,
    };
  }
  const source = targetPlugin.migrationSource(opts.from);
  if (!source) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Lexicon "${opts.to}" does not support migration from "${opts.from}"`,
    };
  }

  let content: string;
  try {
    content = readFileSync(opts.sourceFile, "utf-8");
  } catch (err) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Cannot read ${opts.sourceFile}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!source.detect(content)) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Input file ${opts.sourceFile} does not look like ${opts.from} source`,
    };
  }

  let result;
  try {
    result = await source.transform(content, {
      emit: opts.emit,
      useComposites: opts.useComposites,
      sourceFile: opts.sourceFile,
      strict: opts.strict,
      // --validate also runs the target lexicon's security checks against the
      // migrated output and classifies security-property fates (#306).
      security: opts.validate,
    });
  } catch (err) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Transformation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Write output (--output file or stdout)
  if (opts.output && opts.output !== "-") {
    try {
      writeFileSync(opts.output, result.output);
    } catch (err) {
      return {
        exitCode: 1,
        diagnostics: result.diagnostics,
        provenance: result.provenance,
        error: `Cannot write ${opts.output}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    process.stdout.write(result.output);
  }

  // External validator (--validate) — glci preferred, glab fallback.
  let validatorWarning: string | undefined;
  if (opts.validate && opts.emit === "yaml") {
    const v = tryValidateExternal(result.output);
    if (!v.ran) {
      validatorWarning = "neither glci nor glab is on PATH; skipping --validate";
      if (opts.strict) {
        return {
          exitCode: 1,
          output: result.output,
          diagnostics: result.diagnostics,
          provenance: result.provenance,
          error: "--strict --validate: neither glci nor glab is on PATH",
        };
      }
    } else if (!v.ok) {
      console.error(`Validator (${v.backend}) reported errors:\n${v.output}`);
      if (opts.strict) {
        return {
          exitCode: 1,
          output: result.output,
          diagnostics: result.diagnostics,
          provenance: result.provenance,
          error: `--strict: ${v.backend} validation failed`,
        };
      }
    } else {
      console.error(`Validator (${v.backend}) OK`);
    }
  }

  // SARIF report (--report <path>) — reuse the lint-side formatSarif so any
  // CI SARIF ingest path treats migration findings uniformly.
  if (opts.reportFile) {
    try {
      const rules = await loadMigrationRules(opts.to);
      const lintShape = result.diagnostics as unknown as LintDiagnostic[];
      const sarif = formatSarif(lintShape, rules);
      writeFileSync(opts.reportFile, sarif);
    } catch (err) {
      // Non-fatal: surface the failure but don't abort the migration
      console.error(`Warning: could not write SARIF report to ${opts.reportFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Markdown summary (always to stderr — leaves stdout clean for piping)
  let markdownSummary = formatMarkdownSummary(result.provenance, result.diagnostics, content);
  // Append the security posture section when security analysis ran (#306).
  if (result.securityPosture) {
    markdownSummary += `\n\n${result.securityPosture}`;
  }

  // Determine exit code: any error-severity diagnostic fails when --strict.
  // The transformer already escalates needs-review → error when opts.strict
  // is passed via MigrationSource.transform(); we double-check here.
  const errorDiagnostics = result.diagnostics.filter((d) => d.severity === "error");
  const exitCode = opts.strict && errorDiagnostics.length > 0 ? 1 : 0;

  return {
    exitCode,
    output: result.output,
    diagnostics: result.diagnostics,
    provenance: result.provenance,
    markdownSummary,
  };
}

interface ValidatorResult {
  ran: boolean;
  ok: boolean;
  backend?: "glci" | "glab";
  output: string;
}

function isOnPath(cmd: string): boolean {
  // Use the OS-native lookup. `which` exists on macOS/Linux; `where` on Windows.
  const lookup = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(lookup, [cmd], { encoding: "utf-8" });
  return r.status === 0;
}

/**
 * Run glci or glab against the generated .gitlab-ci.yml. Prefers glci
 * (offline, no auth). Falls back to glab ci lint. Returns a structured
 * result so the caller can decide how to surface success/failure.
 *
 * Exported for testability.
 */
export function tryValidateExternal(yamlText: string): ValidatorResult {
  if (isOnPath("glci")) {
    const r = spawnSync("glci", ["lint", "-f", "-"], { input: yamlText, encoding: "utf-8" });
    return { ran: true, ok: r.status === 0, backend: "glci", output: (r.stdout ?? "") + (r.stderr ?? "") };
  }
  if (isOnPath("glab")) {
    const r = spawnSync("glab", ["ci", "lint", "-f", "-"], { input: yamlText, encoding: "utf-8" });
    return { ran: true, ok: r.status === 0, backend: "glab", output: (r.stdout ?? "") + (r.stderr ?? "") };
  }
  return { ran: false, ok: false, output: "" };
}

/**
 * Lazily load the target lexicon's MIGRATION_RULES (used for SARIF enrichment).
 * Returns an empty array if the lexicon doesn't expose them.
 */
async function loadMigrationRules(targetLexicon: string): Promise<LintRule[]> {
  // For now only gitlab exposes migration rules. Hard-coded import keeps
  // the dependency direction explicit; widen the switch when more
  // lexicons ship their own migrate paths.
  if (targetLexicon === "gitlab") {
    try {
      const mod = await import("@intentius/chant-lexicon-gitlab/migrate/from-github/rules");
      return (mod as { MIGRATION_RULES: LintRule[] }).MIGRATION_RULES;
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Format the migration report as Markdown, mirroring the output format
 * prescribed by the upstream gitlab-org/ci-cd/github-actions-to-gitlab-ci
 * skill: overview, classification, diagnostic table, aggregated manual
 * setup steps, suggested GitLab improvements, caveats.
 *
 * The same data backs the SARIF report (via formatSarif); this is the
 * human-readable surface.
 */
function formatMarkdownSummary(
  provenance: Array<Record<string, unknown>>,
  diagnostics: Array<Record<string, unknown>>,
  sourceContent?: string,
): string {
  const totals = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) {
    const sev = d.severity as string;
    if (sev === "error" || sev === "warning" || sev === "info") {
      totals[sev]++;
    }
  }

  // Derive workflow shape from source (best effort) for the overview line
  const overview = deriveOverview(sourceContent);
  const classification = classifyWorkflow(sourceContent);
  const manualSteps = collectManualSetupSteps(diagnostics);
  const suggestions = collectSuggestions(provenance, sourceContent);

  const lines: string[] = [];
  lines.push("");
  lines.push("## Migration report");
  lines.push("");
  if (overview) lines.push(`**Overview** — ${overview}`);
  if (classification) {
    lines.push("");
    lines.push(classification);
  }
  lines.push("");
  lines.push(`- Provenance records: ${provenance.length}`);
  lines.push(`- Diagnostics: ${totals.error} error, ${totals.warning} warning, ${totals.info} info`);

  if (diagnostics.length > 0) {
    lines.push("");
    lines.push("### Diagnostics");
    lines.push("");
    lines.push("| Severity | Rule | Message |");
    lines.push("|---|---|---|");
    for (const d of diagnostics.slice(0, 50)) {
      lines.push(`| ${d.severity} | ${d.ruleId} | ${String(d.message).slice(0, 120)} |`);
    }
    if (diagnostics.length > 50) {
      lines.push(`| … | … | ${diagnostics.length - 50} more diagnostics omitted |`);
    }
  }

  if (manualSteps.length > 0) {
    lines.push("");
    lines.push("### Manual setup steps");
    lines.push("");
    for (let i = 0; i < manualSteps.length; i++) {
      lines.push(`${i + 1}. ${manualSteps[i]}`);
    }
  }

  if (suggestions.length > 0) {
    lines.push("");
    lines.push("### Suggested GitLab improvements");
    lines.push("");
    for (const s of suggestions) lines.push(`- ${s}`);
  }

  if (totals.error > 0 || totals.warning > 0) {
    lines.push("");
    lines.push("### Caveats");
    lines.push("");
    lines.push(`The translation has ${totals.error} item${totals.error === 1 ? "" : "s"} needing review and ${totals.warning} approximation${totals.warning === 1 ? "" : "s"}. Review the diagnostics above before pushing the generated YAML.`);
  }

  return lines.join("\n");
}

/** Derive a one-sentence overview from the source workflow shape. */
function deriveOverview(content?: string): string | undefined {
  if (!content) return undefined;
  const nameMatch = /^\s*name\s*:\s*(.+?)\s*$/m.exec(content);
  const name = nameMatch ? nameMatch[1].replace(/['"]/g, "") : undefined;
  const jobCount = countJobs(content);
  const triggers = (content.match(/^\s*on\s*:/gm) ?? []).length > 0;
  const parts: string[] = [];
  if (name) parts.push(`workflow "${name}"`);
  if (jobCount > 0) parts.push(`${jobCount} job${jobCount === 1 ? "" : "s"}`);
  if (triggers) parts.push("triggered via on:");
  if (parts.length === 0) return undefined;
  return parts.join(", ") + ".";
}

/** Count top-level entries directly under `jobs:`. */
function countJobs(content: string): number {
  // Find the jobs: line, then walk forward collecting indented-2 keys until
  // we hit a non-indented non-empty line (next top-level key) or EOF.
  const lines = content.split(/\r?\n/);
  let inJobs = false;
  let count = 0;
  for (const line of lines) {
    if (/^\s*jobs\s*:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break; // next top-level key
    if (/^\s{2}[A-Za-z_][A-Za-z0-9_-]*\s*:\s*$/.test(line)) {
      count++;
    }
  }
  return count;
}

/**
 * Detect workflows whose triggers are predominantly repo-automation
 * events (issues, labels, comments, discussions) — GitLab CI can't replace
 * these because pipelines only run on git events.
 */
function classifyWorkflow(content?: string): string | undefined {
  if (!content) return undefined;
  const onBlockMatch = /^\s*on\s*:([\s\S]*?)(?=^\S|\Z)/m.exec(content);
  if (!onBlockMatch) return undefined;
  const onText = onBlockMatch[1];
  const automationEvents = [
    "issues", "issue_comment", "pull_request_review", "pull_request_review_comment",
    "discussion", "discussion_comment", "label", "milestone", "project_card",
    "release", "star", "watch", "fork", "create", "delete",
  ];
  const found = automationEvents.filter((e) =>
    new RegExp(`^\\s*${e}\\s*:`, "m").test(onText),
  );
  const gitEvents = ["push", "pull_request", "schedule", "workflow_dispatch", "workflow_call", "tag"];
  const foundGit = gitEvents.filter((e) =>
    new RegExp(`^\\s*${e}\\s*:|${e}\\b`, "m").test(onText),
  );
  if (found.length > 0 && foundGit.length === 0) {
    return `> ⚠️ **Repo-automation workflow detected** (triggers: ${found.join(", ")}). GitLab CI/CD only runs on git events; consider [gitlab-triage](https://gitlab.com/gitlab-org/ruby/gems/gitlab-triage) on a schedule, or webhooks + an external service. The translated YAML below is best-effort.`;
  }
  if (found.length > 0 && foundGit.length > 0) {
    return `> ℹ️ Mixed triggers: git (${foundGit.join(", ")}) + automation (${found.join(", ")}). The automation events have no GitLab equivalent; the translated pipeline only fires on the git events.`;
  }
  return undefined;
}

/** Aggregate the human-actionable manual setup steps from needs-review diagnostics. */
function collectManualSetupSteps(diagnostics: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const d of diagnostics) {
    if (d.severity !== "warning" && d.severity !== "error") continue;
    const ruleId = d.ruleId as string;
    const action = manualStepFor(ruleId);
    if (action && !seen.has(action)) {
      seen.add(action);
      steps.push(action);
    }
  }
  return steps;
}

const MANUAL_STEPS_BY_RULE: Record<string, string> = {
  "MIG-PERMISSIONS-001": "Configure CI/CD token access at Project Settings > CI/CD > Token Access (no per-job YAML equivalent in GitLab).",
  "MIG-ON-SCHEDULE": "Create a pipeline schedule at Project Settings > CI/CD > Schedules (cron lives in the GitLab UI, not in YAML).",
  "MIG-ON-DISPATCH": "Convert `workflow_dispatch.inputs` to `spec:inputs` at the top of the generated YAML (GitLab 17+). Every input must have a default so auto-triggered pipelines don't fail.",
  "MIG-ON-NON-GIT": "Replace issue/MR/discussion triggers with gitlab-triage on a schedule, or webhooks + an external service. GitLab CI/CD only runs on git events.",
  "MIG-NEEDS-OUTPUTS-001": "Convert step/job outputs to the `artifacts:reports:dotenv` pattern in the producing job, and add `needs: [{ job: X, artifacts: true }]` in the consuming job.",
  "MIG-JOB-OUTPUTS": "Replace GitHub job outputs with `artifacts:reports:dotenv` files written by the producing job.",
  "MIG-MATRIX-INCLUDE-001": "Manually unroll `matrix.include`/`matrix.exclude` entries; GitLab `parallel:matrix:` doesn't support these directly.",
  "MIG-FAIL-FAST": "GitLab's `parallel:matrix:` doesn't fail-fast by default. If fail-fast is critical, wrap the matrix in a job that exits on first child failure.",
  "MIG-RUNS-ON-NON-LINUX": "Register a self-hosted GitLab runner with the appropriate `tags:` for macOS or Windows jobs.",
  "MIG-REUSABLE-WORKFLOW": "Rewrite `uses: org/repo/.github/workflows/*.yml` calls as GitLab `include:project:` + `variables:` parameterisation. Typed inputs aren't supported; document expected variable names.",
};

function manualStepFor(ruleId: string): string | undefined {
  return MANUAL_STEPS_BY_RULE[ruleId];
}

/** Suggest GitLab-native improvements based on workflow shape + provenance. */
function collectSuggestions(
  provenance: Array<Record<string, unknown>>,
  content?: string,
): string[] {
  const out: string[] = [];
  // DAG (needs:) is already passed through; suggest it if multiple jobs exist without explicit needs
  const hasNeeds = provenance.some((p) => p.rule === "MIG-NEEDS");
  const jobCount = content ? countJobs(content) : 0;
  if (jobCount >= 3 && !hasNeeds) {
    out.push("**DAG with `needs:`** — your jobs run sequentially via stage barriers. Adding explicit `needs:` lets jobs run as soon as their dependencies finish, often cutting pipeline time significantly.");
  }
  // rules:changes: when the workflow looks like it might benefit from path filtering
  if (content && /paths\s*:/m.test(content)) {
    out.push("**`rules:changes:`** — GitLab supports path-based job filtering natively. Convert GitHub `on:push:paths:` to `rules:changes:` on each job for monorepo-friendly conditional execution.");
  }
  // include: for multi-file workflow repos
  if (content && /\buses\s*:\s*\.\/.+\.ya?ml/m.test(content)) {
    out.push("**`include:`** — your workflow references local reusable workflows. GitLab `include:local:` merges YAML at parse time; consider migrating those references too.");
  }
  // Composite-recogniser hint when --use-composites would simplify
  if (content && /actions\/setup-node/.test(content) && jobCount >= 1) {
    out.push("**`--use-composites`** — re-run with this flag to collapse Node-shaped pipelines into a single `NodePipeline({...})` call (5–10× shorter generated TypeScript).");
  }
  // resource_group / interruptible already mapped; suggest protected environments for deploy jobs
  if (content && /\bdeploy\b/i.test(content)) {
    out.push("**Protected environments** — gate deploy jobs by approval rules and environment-specific variables (Project Settings > CI/CD > Environments). No GitHub equivalent.");
  }
  // GitLab CI templates
  if (content && /security|sast|dast|terraform/i.test(content)) {
    out.push("**GitLab CI templates** — `include:template:` gives you Auto DevOps, SAST, DAST, Container Scanning, Terraform, etc. out of the box. No GitHub Actions equivalent.");
  }
  return out;
}

export function printMigrateResult(result: MigrateCliResult): void {
  if (result.error) {
    console.error(formatError({ message: result.error }));
    return;
  }
  if (result.markdownSummary) {
    console.error(result.markdownSummary);
  }
  if (result.exitCode === 0) {
    console.error(formatInfo("\nMigration complete."));
  } else {
    console.error(formatError({ message: "Migration completed with errors (--strict)" }));
  }
}
