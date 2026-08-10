/**
 * `dogwoodReplay` / `dogwoodReplayReport` — the replay half of PolicyReplayOp
 * (#1661, epic #1646).
 *
 * Contributed the way the fly lexicon contributes `flyApply`: a plain exported
 * async function taking one args object, re-exported from
 * `src/op/activities/index.ts`, resolved **by name** by core's activity
 * registry when a project lists the `cedar` lexicon. There is no Temporal
 * import here and no Temporal dependency in the package — the local executor
 * runs it as-is, and a Temporal worker registers the same function.
 *
 * What it does: takes a policy bundle (inline text or paths), an event trace
 * (typed events, inline text, or a path) and a set of expectations, runs
 * `dogwood replay --format json` through the existing CLI adapter in
 * `./cli.ts`, and returns a typed divergence report — expected versus actual
 * verdict per decision point, with the determining rules and per-evaluation
 * errors carried through.
 *
 * Three contract details from the #1657 verification shape the code:
 *
 * - **Replay exits 0 even when every verdict is DENY.** A nonzero exit means
 *   the trace or the policy set failed to load. `./cli.ts` already refuses to
 *   read exit codes as verdicts; this module refuses to read a DENY as a
 *   failure.
 * - **A run that could not happen is not a run that found nothing.** An
 *   unusable invocation or a fatal (a malformed trace line, an unparseable
 *   policy set) throws, so the step fails instead of reporting zero
 *   divergences.
 * - **`index` is the decision-stream position, not the trace line number.** A
 *   history-only event contributes history and no verdict, so expectations
 *   written against trace lines would silently address the wrong decision.
 *   Expectations therefore match on `timestamp` by default, and on `index`
 *   only when the caller says so.
 *
 * The trace input is deliberately generic. An AgentCore session/decision
 * history is the follow-on source (it needs the aws lexicon's activity
 * surface, out of scope here) — a trace is a trace, wherever it came from.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  DOGWOOD_SEARCH_ORDER,
  findDogwoodBinary,
  formatDogwoodDiagnostic,
  runDogwoodReplay,
  type DogwoodBundle,
  type DogwoodVerdict,
} from "./cli";
import { auditTrace, renderTrace, type TraceEvent, type TraceIssue } from "./trace";

/** What a replay produces on divergence, mirroring `WorkflowAuditOp`'s modes. */
export type PolicyReplayMode = "report" | "issue" | "pull-request";

/** A verdict a decision point is expected to reach. */
export type ExpectedVerdict = "allow" | "deny";

/**
 * One expectation against the decision stream.
 *
 * Give a `timestamp` (the `@<n>` of the line) or an `index` (the 0-based
 * position in the decision stream). Prefer `timestamp`: it survives a trace
 * gaining a history-only event, which shifts every later index.
 */
export interface ReplayExpectation {
  readonly timestamp?: number;
  readonly index?: number;
  readonly verdict: ExpectedVerdict;
  /** When set, the `.dw` rule indices the decision must be determined by. */
  readonly determiningRules?: readonly number[];
  /** What this decision point is proving, carried into the report. */
  readonly note?: string;
}

/** One expected-versus-actual mismatch. */
export interface ReplayDivergence {
  /** Decision-stream index. `-1` when the expected decision point never occurred. */
  readonly index: number;
  readonly timestamp: number;
  /** Absent when the replay produced a decision nothing expected. */
  readonly expected?: ExpectedVerdict;
  /** Absent when an expected decision point produced no verdict at all. */
  readonly actual?: ExpectedVerdict;
  readonly determiningRules: readonly number[];
  readonly errors: readonly string[];
  readonly detail: string;
  readonly note?: string;
}

/** What `dogwoodReplay` returns and `dogwoodReplayReport` reads back. */
export interface PolicyReplayReport {
  /** True when nothing diverged and no decision point errored. */
  readonly ok: boolean;
  readonly mode: PolicyReplayMode;
  /** Every decision point, in stream order. */
  readonly verdicts: readonly DogwoodVerdict[];
  readonly divergences: readonly ReplayDivergence[];
  /** Divergence count — the number a search attribute or a gate reads. */
  readonly findings: number;
  /** Trace weaknesses found by `auditTrace`, when typed events were supplied. */
  readonly traceIssues: readonly TraceIssue[];
  /** Markdown, used as the report body or an issue/PR body. */
  readonly summary: string;
}

/** What `dogwoodReplay` takes. Every artifact is inline text or a path. */
export interface DogwoodReplayArgs {
  /** `.dw` policy set text. */
  policies?: string;
  /** …or a path to it. Relative paths resolve against {@link cwd}. */
  policiesPath?: string;
  /** Cedar action schema text (`--policy-schema`). Not optional to the CLI. */
  policySchema?: string;
  policySchemaPath?: string;
  /** `.dwschema` event schema text (`--event-schema`). */
  eventSchema?: string;
  eventSchemaPath?: string;
  /** `.dw` macro library text (`--macros`). */
  macros?: string;
  macrosPath?: string;
  /** `providers.json` text (`--providers`). Rhai must be inlined under `implementation.script`. */
  providers?: string;
  providersPath?: string;

  /** Typed events — rendered here, and audited for the both-bags trap. */
  traceEvents?: readonly TraceEvent[];
  /** …or the trace text as it would appear in a `.log`. */
  trace?: string;
  /** …or a path to it. */
  tracePath?: string;
  /**
   * Event kinds that decide, for the trace audit. Default `["request"]` — the
   * truth is whichever kinds the `.dwschema` marks `decision`.
   */
  traceDecisionKinds?: readonly string[];

  /** What each decision point must decide. An empty list replays and reports. */
  expect?: readonly ReplayExpectation[];
  /** Default `report`. */
  mode?: PolicyReplayMode;

  /** Explicit binary path. Otherwise resolved by {@link findDogwoodBinary}. */
  binary?: string;
  /** Base directory for every relative path. Default `process.cwd()`. */
  cwd?: string;
  /** When set, the report is written here as JSON for the Report phase to read. */
  reportPath?: string;
}

async function textOf(
  inline: string | undefined,
  path: string | undefined,
  cwd: string,
  what: string,
): Promise<string | undefined> {
  if (inline !== undefined) return inline;
  if (path === undefined) return undefined;
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    return await readFile(full, "utf-8");
  } catch (err) {
    throw new Error(`dogwood replay: could not read ${what} at ${full} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Assemble the bundle and the trace from whichever form the caller supplied.
 *
 * Exported because the composite's Artifacts phase writes files and the Replay
 * phase names them: resolving the same way in a test as in the Op is the point
 * of having one function do it.
 */
export async function resolveReplayInputs(
  args: DogwoodReplayArgs,
): Promise<{ bundle: DogwoodBundle; trace: string; traceIssues: TraceIssue[] }> {
  const cwd = args.cwd ?? process.cwd();

  const policies = await textOf(args.policies, args.policiesPath, cwd, "the .dw policy set");
  if (policies === undefined) {
    throw new Error("dogwood replay: no policy set — pass `policies` or `policiesPath`");
  }

  const policySchema = await textOf(args.policySchema, args.policySchemaPath, cwd, "the Cedar action schema");
  if (policySchema === undefined) {
    throw new Error(
      "dogwood replay: no action schema — `--policy-schema` is not optional to the CLI, so pass `policySchema` or `policySchemaPath`",
    );
  }

  const eventSchema = await textOf(args.eventSchema, args.eventSchemaPath, cwd, "the .dwschema event schema");
  const macros = await textOf(args.macros, args.macrosPath, cwd, "the macro library");
  const providers = await textOf(args.providers, args.providersPath, cwd, "providers.json");

  let trace: string | undefined;
  let traceIssues: TraceIssue[] = [];
  if (args.traceEvents && args.traceEvents.length > 0) {
    // Only the typed form can be audited — there is no trace parser on this
    // side, and guessing one from a regex would report confident nonsense
    // about a format a sync can retune.
    traceIssues = auditTrace(args.traceEvents, {
      ...(args.traceDecisionKinds ? { decisionKinds: args.traceDecisionKinds } : {}),
    });
    trace = renderTrace(args.traceEvents);
  } else {
    trace = await textOf(args.trace, args.tracePath, cwd, "the event trace");
  }
  if (trace === undefined) {
    throw new Error("dogwood replay: no trace — pass `traceEvents`, `trace` or `tracePath`");
  }

  return {
    bundle: {
      policies,
      policySchema,
      ...(eventSchema !== undefined ? { eventSchema } : {}),
      ...(macros !== undefined ? { macros } : {}),
      ...(providers !== undefined ? { providers } : {}),
    },
    trace,
    traceIssues,
  };
}

/**
 * Match expectations against the decision stream.
 *
 * Timestamp matching consumes verdicts left to right, so two expectations at
 * the same `@n` address the first and second decision there rather than both
 * addressing the first. A verdict nothing expected is reported too — a policy
 * set that starts deciding somewhere new is drift, and the usual reason a
 * replay is being run at all.
 */
export function compareVerdicts(
  verdicts: readonly DogwoodVerdict[],
  expectations: readonly ReplayExpectation[],
): ReplayDivergence[] {
  const divergences: ReplayDivergence[] = [];
  const claimed = new Set<number>();

  for (const expectation of expectations) {
    if (expectation.index === undefined && expectation.timestamp === undefined) {
      throw new Error("dogwood replay: an expectation needs a `timestamp` or an `index`");
    }

    const position =
      expectation.index !== undefined
        ? verdicts.findIndex((v) => v.index === expectation.index)
        : verdicts.findIndex((v, i) => !claimed.has(i) && v.timestamp === expectation.timestamp);

    if (position === -1) {
      const where =
        expectation.index !== undefined ? `decision index ${expectation.index}` : `@${String(expectation.timestamp)}`;
      divergences.push({
        index: -1,
        timestamp: expectation.timestamp ?? -1,
        expected: expectation.verdict,
        determiningRules: [],
        errors: [],
        detail: `no decision point at ${where} — the trace produced ${verdicts.length} decision(s), and a history-only event produces none`,
        ...(expectation.note ? { note: expectation.note } : {}),
      });
      continue;
    }

    claimed.add(position);
    const actual = verdicts[position];

    if (actual.verdict !== expectation.verdict) {
      divergences.push({
        index: actual.index,
        timestamp: actual.timestamp,
        expected: expectation.verdict,
        actual: actual.verdict,
        determiningRules: actual.determiningRules,
        errors: actual.errors,
        detail: `expected ${expectation.verdict.toUpperCase()}, replayed ${actual.verdict.toUpperCase()}${
          actual.determiningRules.length > 0 ? ` (rules: ${actual.determiningRules.join(", ")})` : ""
        }`,
        ...(expectation.note ? { note: expectation.note } : {}),
      });
      continue;
    }

    if (expectation.determiningRules !== undefined) {
      const want = [...expectation.determiningRules].sort((a, b) => a - b).join(", ");
      const got = [...actual.determiningRules].sort((a, b) => a - b).join(", ");
      if (want !== got) {
        divergences.push({
          index: actual.index,
          timestamp: actual.timestamp,
          expected: expectation.verdict,
          actual: actual.verdict,
          determiningRules: actual.determiningRules,
          errors: actual.errors,
          detail: `${actual.verdict.toUpperCase()} as expected, but determined by rules [${got}] rather than [${want}] — the decision is right for a different reason`,
          ...(expectation.note ? { note: expectation.note } : {}),
        });
        continue;
      }
    }

    if (actual.errors.length > 0) {
      divergences.push({
        index: actual.index,
        timestamp: actual.timestamp,
        expected: expectation.verdict,
        actual: actual.verdict,
        determiningRules: actual.determiningRules,
        errors: actual.errors,
        detail: `${actual.verdict.toUpperCase()} as expected, but the evaluation errored: ${actual.errors.join("; ")}`,
        ...(expectation.note ? { note: expectation.note } : {}),
      });
    }
  }

  verdicts.forEach((verdict, position) => {
    if (claimed.has(position)) return;
    if (expectations.length === 0) return;
    divergences.push({
      index: verdict.index,
      timestamp: verdict.timestamp,
      actual: verdict.verdict,
      determiningRules: verdict.determiningRules,
      errors: verdict.errors,
      detail: `an unexpected decision point: @${verdict.timestamp} replayed ${verdict.verdict.toUpperCase()} and nothing expected a decision there`,
    });
  });

  // Errors on decision points nobody wrote an expectation for still matter —
  // a provider with no inlined Rhai script errors on every evaluation, and a
  // replay with no expectations at all would otherwise report itself clean.
  if (expectations.length === 0) {
    for (const verdict of verdicts) {
      if (verdict.errors.length === 0) continue;
      divergences.push({
        index: verdict.index,
        timestamp: verdict.timestamp,
        actual: verdict.verdict,
        determiningRules: verdict.determiningRules,
        errors: verdict.errors,
        detail: `@${verdict.timestamp} evaluated with errors: ${verdict.errors.join("; ")}`,
      });
    }
  }

  return divergences.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
}

/** The markdown body — printed in `report` mode, posted in the other two. */
export function renderReplaySummary(report: Omit<PolicyReplayReport, "summary">): string {
  const lines = ["## Policy replay", ""];
  lines.push(
    `${report.verdicts.length} decision point(s) replayed; ${report.divergences.length} divergence(s).`,
    "",
  );

  if (report.divergences.length > 0) {
    lines.push("| @ | index | expected | replayed | detail |", "|---|---|---|---|---|");
    for (const d of report.divergences) {
      lines.push(
        `| ${d.timestamp === -1 ? "—" : `@${d.timestamp}`} | ${d.index === -1 ? "—" : d.index} | ${
          d.expected ?? "—"
        } | ${d.actual ?? "—"} | ${d.detail}${d.note ? ` — ${d.note}` : ""} |`,
      );
    }
    lines.push("");
  }

  if (report.traceIssues.length > 0) {
    lines.push(
      "### Trace weaknesses",
      "",
      "These do not fail a replay — they make one report a verdict it did not really test.",
      "",
    );
    for (const issue of report.traceIssues) {
      lines.push(`- \`${issue.kind}\` @${issue.timestamp}: ${issue.message}`);
    }
    lines.push("");
  }

  if (report.divergences.length === 0 && report.traceIssues.length === 0) {
    lines.push("Every decision point replayed to the verdict it was expected to reach.", "");
  }

  return lines.join("\n");
}

/**
 * Replay a policy bundle against a trace and report divergence.
 *
 * Throws when the CLI could not be used or the run was fatal. That is the
 * distinction `./cli.ts` draws and this preserves: a replay that did not
 * happen must fail the step, never report zero divergences.
 */
export async function dogwoodReplay(args: DogwoodReplayArgs): Promise<PolicyReplayReport> {
  const cwd = args.cwd ?? process.cwd();
  const mode = args.mode ?? "report";

  const binary = args.binary ?? findDogwoodBinary(cwd)?.path;
  if (!binary) {
    throw new Error(
      `dogwood replay: no \`dogwood\` binary. chant looked at ${DOGWOOD_SEARCH_ORDER}. Upstream ships only a Rust CLI — build it from dogwood-policy/dogwood and point chant at it.`,
    );
  }

  const { bundle, trace, traceIssues } = await resolveReplayInputs(args);
  const result = runDogwoodReplay(binary, bundle, trace);

  if (result.kind === "unusable") {
    throw new Error(`dogwood replay: ${result.reason}`);
  }
  if (result.kind === "fatal") {
    const related = result.related.map((d) => `\n  ${formatDogwoodDiagnostic(d)}`).join("");
    throw new Error(`dogwood replay: ${formatDogwoodDiagnostic(result.error)}${related}`);
  }

  const divergences = compareVerdicts(result.verdicts, args.expect ?? []);
  const partial = {
    ok: divergences.length === 0,
    mode,
    verdicts: result.verdicts,
    divergences,
    findings: divergences.length,
    traceIssues,
  };
  const report: PolicyReplayReport = { ...partial, summary: renderReplaySummary(partial) };

  if (args.reportPath) {
    const full = isAbsolute(args.reportPath) ? args.reportPath : resolve(cwd, args.reportPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, JSON.stringify(report, null, 2) + "\n", "utf-8");
  }

  return report;
}

/** What `dogwoodReplayReport` takes. */
export interface DogwoodReplayReportArgs {
  /** The JSON `dogwoodReplay` wrote. Relative paths resolve against {@link cwd}. */
  reportPath?: string;
  /** …or the report itself, for a caller holding it already. */
  report?: PolicyReplayReport;
  /** Overrides the mode recorded in the report. */
  mode?: PolicyReplayMode;
  /** Title for the issue or pull request. */
  title?: string;
  cwd?: string;
  /** Fail the step when the replay diverged. Default false — the mode decides. */
  failOnDivergence?: boolean;
}

/** What the Report phase produces. */
export interface PolicyReplayDispatch {
  readonly mode: PolicyReplayMode;
  readonly findings: number;
  readonly title: string;
  /** The markdown to print, or to use as an issue/PR body. */
  readonly body: string;
  /** True when there is something to say — an issue/PR is only worth opening then. */
  readonly actionable: boolean;
}

/**
 * Turn a written replay report into the thing the finding mode calls for.
 *
 * It renders and returns; it does not open anything. Same as
 * `workflowSupplyChainAudit`, and for the same reason — the cedar lexicon has
 * no forge client and should not grow one to reach GitHub, GitLab or Forgejo.
 * `report` mode prints the body; `issue` and `pull-request` hand back the
 * title and body for whatever step opens them.
 */
export async function dogwoodReplayReport(args: DogwoodReplayReportArgs): Promise<PolicyReplayDispatch> {
  const cwd = args.cwd ?? process.cwd();

  let report = args.report;
  if (!report) {
    if (!args.reportPath) {
      throw new Error("dogwood replay report: pass `report` or `reportPath`");
    }
    const full = isAbsolute(args.reportPath) ? args.reportPath : resolve(cwd, args.reportPath);
    try {
      report = JSON.parse(await readFile(full, "utf-8")) as PolicyReplayReport;
    } catch (err) {
      throw new Error(
        `dogwood replay report: could not read the replay report at ${full} — ${err instanceof Error ? err.message : String(err)}. The Replay phase writes it; a Report phase that runs without one has nothing to report on.`,
      );
    }
  }

  const mode = args.mode ?? report.mode;
  const findings = report.findings;
  const actionable = findings > 0 || report.traceIssues.length > 0;
  const title = args.title ?? `Policy replay: ${findings} divergence(s)`;

  if (mode === "report") {
    // eslint-disable-next-line no-console -- report mode's whole output is this.
    console.log(report.summary);
  }

  if (args.failOnDivergence && findings > 0) {
    throw new Error(`dogwood replay: ${findings} divergence(s) between the declared policy set and the replayed trace`);
  }

  return { mode, findings, title, body: report.summary, actionable };
}
