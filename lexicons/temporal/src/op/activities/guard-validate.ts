/**
 * guardValidate — chant #522: reuse an existing CloudFormation Guard rules
 * pack as a first-class Op step, instead of reimplementing compliance packs
 * as native `WAW` rules.
 *
 * chant already emits standard CloudFormation `template.json` (no
 * chant-specific translation), so an org's existing `.guard` files run
 * against it unchanged: this activity is a thin shell around
 * `cfn-guard validate -r <rules> -d <template> --output-format json`, run
 * through the runtime adapter's `spawn` (never `node:child_process`
 * directly — see `lexicons/aws/src/plugin.ts`'s `exportResources` for the
 * same seam, and `../../import/live-export-io.test.ts` for how a test mocks
 * it). `cfn-guard` is an operational dependency, not a `chant build`
 * dependency — nothing here runs inside the pure core.
 *
 * Mirrors `./policy.ts`'s `policyGate`: `report` is the only finding-mode
 * today (the type only admits that one value; `issue`/`pull-request` modes
 * are a follow-up, chant #522), and an error-severity finding throws
 * (`ApplicationFailure.nonRetryable`) so the local executor exits non-zero —
 * the same gate CI relies on to fail the pipeline — and the same activity
 * blocks a Temporal-orchestrated `ApplyOp` when placed before it.
 */
import { resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";

export interface GuardValidateArgs {
  /**
   * Path to a `.guard` rules file or directory, passed to `cfn-guard validate
   * -r`. No chant-specific rule format — these are ordinary cfn-guard rules,
   * the same ones CDK's `CfnGuardValidator` would run.
   */
  rules: string;
  /**
   * Path to the built CloudFormation template to validate. Default:
   * `<path>/template.json` — the convention `chant build -o template.json`
   * writes to (see the aws lexicon's own examples and the native-output
   * policy docs).
   */
  template?: string;
  /** Project directory `template` is resolved relative to, when `template` is not given. Default ".". */
  path?: string;
  /**
   * What to produce on a finding. Only `"report"` runs today — it prints a
   * summary and throws on any finding, no external service involved.
   * `issue`/`pull-request` modes (reusing the audit-Op finding-mode
   * plumbing) are left to a follow-up. Default: `"report"`.
   */
  onFinding?: "report";
  /** Path to (or name of) the `cfn-guard` binary. Default: `"cfn-guard"`, resolved via `PATH`. */
  binary?: string;
}

/** One cfn-guard rule violation, mapped to a chant-shaped diagnostic. */
export interface GuardFinding {
  /** The cfn-guard rule name that failed. */
  rule: string;
  /** Always `"error"` today — a cfn-guard non-compliant result is a policy violation, the same weight `policyGate` gives a violation. */
  severity: "error";
  /** Human-readable violation message. */
  message: string;
  /** Best-effort CloudFormation logical id the violation is about, when cfn-guard's output names one. */
  entity?: string;
}

export interface GuardValidateResult {
  findings: GuardFinding[];
  summary: string;
}

type JsonValue = unknown;

/**
 * Recursively collect message-shaped string values anywhere inside a parsed
 * cfn-guard `not_compliant` entry. cfn-guard's exact JSON nesting for a
 * violation's human message has shifted across versions (Unary/Clause/Check
 * wrappers, `messages.custom_message` vs `messages.error`, …); rather than
 * betting on one fixed path that a version bump silently breaks, this walks
 * the whole entry and takes every message-shaped string it finds — the same
 * "degrade, don't false-negative" instinct `defaultGitlabRefResolver`
 * (`./pipeline-audit.ts`) uses for a resolver failure.
 */
function collectMessages(value: JsonValue, out: string[] = [], seen = new Set<string>()): string[] {
  if (typeof value !== "object" || value === null) return out;
  if (Array.isArray(value)) {
    for (const v of value) collectMessages(v, out, seen);
    return out;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && /^(message|custom_message|error)$/i.test(key) && v.trim() && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    } else {
      collectMessages(v, out, seen);
    }
  }
  return out;
}

/** Collect every string value found under a `*path*`-shaped key, anywhere in the entry. */
function collectPaths(value: JsonValue, out: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return out;
  if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, out);
    return out;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && /path/i.test(key)) out.push(v);
    else collectPaths(v, out);
  }
  return out;
}

/**
 * Best-effort CloudFormation logical id for a violation: cfn-guard reports
 * the offending property as a template path such as
 * `/Resources/MyBucket/Properties/...`. Pull the segment right after
 * `Resources` from the first path-shaped string found, if any.
 */
function findEntity(value: JsonValue): string | undefined {
  for (const p of collectPaths(value)) {
    const m = /Resources[./]([A-Za-z0-9]+)/.exec(p);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Map cfn-guard's `--output-format json` report to chant-shaped findings.
 * Exported and tested directly (independent of `spawn`) — same split
 * `collectPipelineRefs`/`pipelineSupplyChainAudit` (`./pipeline-audit.ts`)
 * use between pure mapping and the orchestrating activity.
 *
 * Throws if `stdout` is not parseable JSON — a cfn-guard invocation that
 * didn't run with `--output-format json` (a bad rules path, a version too
 * old to support it) is a setup problem, not "zero violations"; reporting
 * a clean run here would be a false negative.
 */
export function parseGuardFindings(stdout: string): GuardFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `cfn-guard did not return parseable JSON (guardValidate always passes --output-format json) — ` +
        `${err instanceof Error ? err.message : String(err)}\nraw output:\n${stdout}`,
    );
  }

  const fileReports = Array.isArray(parsed) ? parsed : [parsed];
  const findings: GuardFinding[] = [];
  for (const report of fileReports) {
    const notCompliant = (report as { not_compliant?: unknown[] } | null)?.not_compliant ?? [];
    for (const entry of notCompliant) {
      const rule =
        (entry as { Rule?: { name?: string }; name?: string } | null)?.Rule?.name ??
        (entry as { name?: string } | null)?.name ??
        "unknown-rule";
      const messages = collectMessages(entry);
      const message = messages.length > 0 ? `cfn-guard rule "${rule}" violated: ${messages.join("; ")}` : `cfn-guard rule "${rule}" violated`;
      const entity = findEntity(entry);
      findings.push({ rule, severity: "error", message, ...(entity ? { entity } : {}) });
    }
  }
  return findings;
}

function renderSummary(findings: GuardFinding[], template: string, rules: string): string {
  if (findings.length === 0) return `## cfn-guard\n\n${template} is compliant with ${rules}.\n`;
  let out = `## cfn-guard\n\n${findings.length} violation(s) in ${template} against ${rules}:\n\n`;
  out += "| Rule | Entity | Message |\n|---|---|---|\n";
  for (const f of findings) out += `| ${f.rule} | ${f.entity ?? ""} | ${f.message} |\n`;
  return out;
}

/**
 * Run an external CloudFormation Guard rules pack against the project's
 * built CloudFormation template. `report` mode: prints a summary, and
 * throws (non-retryable) when any rule is violated, so the local executor
 * (`chant run`) exits non-zero and CI fails the pipeline — the same shape
 * `policyGate` uses to block an apply. A clean run passes through.
 *
 * Runs in both executors — it is a plain activity, not a Temporal gate.
 */
export async function guardValidate(args: GuardValidateArgs, _signal?: AbortSignal): Promise<GuardValidateResult> {
  const mode = args.onFinding ?? "report";
  if (mode !== "report") {
    throw new Error(
      `guardValidate: onFinding "${mode}" is not implemented — only "report" runs today ` +
        `(chant #522 leaves issue/pull-request modes to a follow-up).`,
    );
  }

  const projectPath = args.path ?? ".";
  const template = args.template ?? resolve(projectPath, "template.json");
  const binary = args.binary ?? "cfn-guard";

  const { getRuntime } = await import("@intentius/chant/runtime-adapter");
  const rt = getRuntime();
  const result = await rt.spawn([binary, "validate", "-r", args.rules, "-d", template, "--output-format", "json"]);

  if (result.stdout.trim() === "" && result.stderr.trim() !== "") {
    throw new Error(
      `cfn-guard ("${binary}") produced no output — ${result.stderr.trim()}\n` +
        `Install cfn-guard (https://github.com/aws-cloudformation/cloudformation-guard) or pass { binary } ` +
        `to point at an existing install.`,
    );
  }

  const findings = parseGuardFindings(result.stdout);
  const summary = renderSummary(findings, template, args.rules);

  if (findings.length > 0) {
    console.log(summary);
    const detail = findings.map((f) => `[${f.rule}]${f.entity ? ` ${f.entity}:` : ""} ${f.message}`).join("; ");
    throw ApplicationFailure.nonRetryable(
      `cfn-guard blocked the build — ${findings.length} violation(s) against ${args.rules}: ${detail}`,
      "GuardViolation",
    );
  }

  console.log(`[guard] ${template} is compliant with ${args.rules}`);
  return { findings, summary };
}
