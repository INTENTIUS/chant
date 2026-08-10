/**
 * `PolicyReplayOp` — replay a declared `.dw` set against a recorded event
 * trace and report divergence (#1661, epic #1646).
 *
 * Shape follows `WorkflowAuditOp`: an observe-dial Op whose last phase is a
 * finding mode (`report | issue | pull-request`). What it observes is not a
 * moving upstream but a moving *history* — a policy set that was correct
 * against last week's traffic can decide differently against this week's, and
 * the deterministic build cannot see that.
 *
 * ## Packaging: the composite ships from cedar, not from temporal
 *
 * `WorkflowAuditOp` and `PipelineAuditOp` live in the temporal lexicon because
 * they hand back a `TemporalSchedule` alongside the Op, and that resource is
 * temporal's. This composite hands back an Op and nothing else, so it has no
 * reason to reach across — it imports `@intentius/chant/op` only, exactly as
 * the fly lexicon's `flyDeploy` composite does. cedar therefore keeps zero
 * runtime dependency on `@intentius/chant-lexicon-temporal`.
 *
 * The scheduled form is a two-line project-side pairing rather than a config
 * flag, and that is the deliberate cost of the decision:
 *
 * ```ts
 * import { TemporalSchedule } from "@intentius/chant-lexicon-temporal";
 *
 * export const { op } = PolicyReplayOp({ name: "policy-replay", … });
 * export const schedule = new TemporalSchedule({
 *   scheduleId: "policy-replay-schedule",
 *   spec: { cronExpressions: ["0 6 * * *"] },
 *   action: { workflowType: "policyReplayWorkflow", taskQueue: "policy-replay" },
 * });
 * ```
 *
 * A project that wants that already installs the temporal lexicon; a project
 * that only wants `chant run policy-replay` on the local executor should not
 * have to. `examples/policy-replay` is the worked recipe for both.
 *
 * ## Phases
 *
 * ```
 * Artifacts  chantBuild — emit policies.dw, the .cedarschema and the
 *            .dwschema the replay reads (skippable when they are checked in)
 * Replay     dogwoodReplay — run `dogwood replay --format json` over the
 *            bundle and the trace, write the divergence report
 * Report     dogwoodReplayReport — read that report and act on the mode
 * ```
 *
 * The report file is the seam between the last two phases, the same way
 * `dist/fly.json` is the seam between `build:fly` and `flyApply`: Op steps do
 * not pass return values to one another, so a phase boundary needs an artifact
 * to be a real boundary rather than a cosmetic one.
 */

import { Op, activity, build, phase, type ActivityStep, type OpResource } from "@intentius/chant/op";
import type { PolicyReplayMode, ReplayExpectation } from "./replay-activity";

/** Where the Replay phase writes its report by default. */
export const DEFAULT_REPLAY_REPORT_PATH = "dist/dogwood-replay.json";

/** Options for {@link dogwoodReplayStep}. Mirrors `DogwoodReplayArgs`. */
export interface DogwoodReplayStepOpts {
  policies?: string;
  policiesPath?: string;
  policySchema?: string;
  policySchemaPath?: string;
  eventSchema?: string;
  eventSchemaPath?: string;
  macros?: string;
  macrosPath?: string;
  providers?: string;
  providersPath?: string;
  trace?: string;
  tracePath?: string;
  expect?: readonly ReplayExpectation[];
  mode?: PolicyReplayMode;
  binary?: string;
  cwd?: string;
  reportPath?: string;
  profile?: ActivityStep["profile"];
}

/**
 * Replay a policy bundle against a trace — the typed twin of `flyApplyStep`.
 *
 * Resolves to the `dogwoodReplay` activity by name, which `loadActivities`
 * binds when the project lists the `cedar` lexicon. Defaults to the
 * `policyCheck` profile.
 */
export const dogwoodReplayStep = (opts: DogwoodReplayStepOpts): ActivityStep => {
  const { profile, ...args } = opts;
  return activity("dogwoodReplay", args as Record<string, unknown>, profile ?? "policyCheck");
};

/** Options for {@link dogwoodReplayReportStep}. */
export interface DogwoodReplayReportStepOpts {
  reportPath?: string;
  mode?: PolicyReplayMode;
  title?: string;
  cwd?: string;
  failOnDivergence?: boolean;
  profile?: ActivityStep["profile"];
}

/** Read a written replay report and act on its finding mode. */
export const dogwoodReplayReportStep = (opts: DogwoodReplayReportStepOpts = {}): ActivityStep => {
  const { profile, ...args } = opts;
  return activity("dogwoodReplayReport", args as Record<string, unknown>, profile ?? "fastIdempotent");
};

/** Options for {@link PolicyReplayOp}. */
export interface PolicyReplayOpConfig {
  /** Op name (kebab-case) — the `chant run <name>` target and the task queue base. */
  name: string;
  overview?: string;
  /** Defaults to {@link name}. */
  taskQueue?: string;

  /**
   * Directory every relative path below resolves against, and the one the
   * build script runs in. Default `.`.
   */
  path?: string;
  /**
   * npm script that emits the `.dw` bundle. Default `build`. Pass `false` when
   * the artifacts are checked in — the Artifacts phase is then omitted rather
   * than run as a no-op, so the Op's phase list says what it really does.
   */
  buildScript?: string | false;

  /** Emitted `.dw` policy set. Default `dist/policies.dw`. */
  policiesPath?: string;
  /** Emitted Cedar action schema. Required by the CLI; default `dist/app.cedarschema`. */
  policySchemaPath?: string;
  /** Emitted `.dwschema`, when the project declares one. */
  eventSchemaPath?: string;
  /** Emitted macro library, when the project ships one out of line. */
  macrosPath?: string;
  /** `providers.json`, with the Rhai inlined under `implementation.script`. */
  providersPath?: string;

  /** The recorded trace to replay. Required — there is nothing to replay without one. */
  tracePath: string;

  /** What each decision point must decide. Empty replays and reports verdicts. */
  expect?: readonly ReplayExpectation[];

  /** What to produce on divergence. Default `report`. */
  onFinding?: PolicyReplayMode;
  /** Title for the issue or pull request the finding mode calls for. */
  title?: string;
  /**
   * Fail the Op when the replay diverged. Default false — an observe-dial Op
   * reports by default, and a red run is a decision the caller makes.
   */
  failOnDivergence?: boolean;

  /** Where the Replay phase writes its report. Default {@link DEFAULT_REPLAY_REPORT_PATH}. */
  reportPath?: string;
  /** Explicit `dogwood` binary path, for a runner that knows where it built one. */
  binary?: string;
}

/** What {@link PolicyReplayOp} hands back. */
export interface PolicyReplayOpResources {
  /** The Op — discovered by `chant run <name>`, emitted by `chant build`. */
  op: InstanceType<typeof OpResource>;
}

/**
 * Assemble the replay Op: emit the artifacts, replay them, act on the finding.
 *
 * @example
 * ```typescript
 * export const { op } = PolicyReplayOp({
 *   name: "policy-replay",
 *   tracePath: "trace/read-after-login.log",
 *   expect: [
 *     { timestamp: 10, verdict: "allow", determiningRules: [0] },
 *     { timestamp: 7200, verdict: "deny", note: "the login is two hours stale" },
 *   ],
 *   onFinding: "issue",
 * });
 * ```
 */
export function PolicyReplayOp(config: PolicyReplayOpConfig): PolicyReplayOpResources {
  const path = config.path ?? ".";
  const mode = config.onFinding ?? "report";
  const reportPath = config.reportPath ?? DEFAULT_REPLAY_REPORT_PATH;

  const phases = [];

  if (config.buildScript !== false) {
    phases.push(phase("Artifacts", [build(path, { script: config.buildScript ?? "build" })]));
  }

  phases.push(
    phase("Replay", [
      {
        ...dogwoodReplayStep({
          cwd: path,
          policiesPath: config.policiesPath ?? "dist/policies.dw",
          policySchemaPath: config.policySchemaPath ?? "dist/app.cedarschema",
          ...(config.eventSchemaPath ? { eventSchemaPath: config.eventSchemaPath } : {}),
          ...(config.macrosPath ? { macrosPath: config.macrosPath } : {}),
          ...(config.providersPath ? { providersPath: config.providersPath } : {}),
          tracePath: config.tracePath,
          ...(config.expect ? { expect: config.expect } : {}),
          mode,
          ...(config.binary ? { binary: config.binary } : {}),
          reportPath,
        }),
        // The divergence count as a workflow search attribute, so "show me the
        // replays that found something" is one filter rather than a log read.
        outcomeAttribute: { name: "Divergences", from: "findings" },
      },
    ]),
    phase("Report", [
      dogwoodReplayReportStep({
        cwd: path,
        reportPath,
        mode,
        ...(config.title ? { title: config.title } : {}),
        ...(config.failOnDivergence ? { failOnDivergence: true } : {}),
      }),
    ]),
  );

  return {
    op: Op({
      name: config.name,
      overview:
        config.overview ??
        "Replay the declared dogwood policy set against a recorded event trace and report divergence",
      taskQueue: config.taskQueue ?? config.name,
      searchAttributes: {
        Audit: "true",
        Surface: "cedar-dogwood",
      },
      phases,
    }),
  };
}
