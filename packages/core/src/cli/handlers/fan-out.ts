/**
 * `chant components fan-out` (#2420) — run a change out across the components
 * downstream of it, in an order chant derives from the source.
 *
 * #2417 built the four pieces this command joins (`componentsForUnits`,
 * `planFanOut`, `remainingFanOut`, `runFanOut`, all in ../../components/) and
 * left them reachable only from their own tests. `chant lifecycle affected`
 * produces the stack-level change signal at one end; `runFanOut` consumes a
 * plan at the other; this is the line between them.
 *
 * ## Why a sibling command rather than a third `--components` selector
 *
 * `chant run --components all` stops the whole run at the first failed
 * component, and it should: there the user asked for everything, so a failure
 * means the estate is in a state nobody described. A fan-out deliberately does
 * the opposite, skipping the failure's own subtree and letting independent
 * branches finish (#2419 added a second runner for exactly that reason). Two
 * opposite failure semantics behind one flag's third value would be a trap. The
 * flags differ too: a fan-out is parameterised by a change signal, which
 * `chant run` has no business growing a `--base` for.
 *
 * ## The loop
 *
 * ```
 * chant components fan-out --base main --env prod --dry-run
 * chant components fan-out --base main --env prod --gate release --resume .chant/fan-out.json
 * chant approve fan-out release --plan sha256:...
 * chant components fan-out --base main --env prod --gate release --resume .chant/fan-out.json
 * ```
 *
 * The last two lines are the same command twice, which is the point: an attempt
 * that stopped is finished by repeating it, not by hand-picking what is left.
 * `--resume` carries the earlier attempt's progress, `remainingFanOut` narrows
 * the plan before the gate is decided, and the digest is carried rather than
 * recomputed, so the approval still stands.
 */

import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadChantConfig, resolveAutoReleaseDisabled, type ChantConfig } from "../../config";
import { affectedStacks } from "../../lifecycle/affected";
import { deriveFanOut, fanOutRegistry } from "../../components/fan-out-support";
import { runFanOut } from "../../components/fan-out-run";
import { renderFanOutHuman, renderFanOutJson, renderFanOutPlan } from "../../components/fan-out-output";
import { ndjsonProgressSink } from "../../components/run-progress";
import { writeGatedRunSummary } from "../../op/gate-summary";
import { remainingFanOut, type ChangedUnits, type FanOutProgress } from "../../components/fan-out";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { formatError, formatInfo, formatWarning } from "../format";
import { FAN_OUT_GATE_OP } from "../../op/gate-name";
import { resolveBuildRoot } from "./lifecycle";
import { GATED_EXIT_CODE, recordAutoReleasesForRun } from "./run";
import type { CommandContext } from "../registry";



/**
 * What an attempt left behind, and what the next one reads (`--resume`).
 *
 * The digest is stored alongside the progress because progress is only
 * meaningful for the plan it was made against. A fan-out derived from different
 * source is a different fan-out, and carrying "cluster-a already applied" into
 * it would be a claim about work nobody did.
 */
interface FanOutAttempt {
  digest: string;
  completed: string[];
  failed: string[];
}

function readAttempt(path: string): FanOutAttempt | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FanOutAttempt>;
  return {
    digest: typeof parsed.digest === "string" ? parsed.digest : "",
    completed: Array.isArray(parsed.completed) ? parsed.completed.filter((n): n is string => typeof n === "string") : [],
    failed: Array.isArray(parsed.failed) ? parsed.failed.filter((n): n is string => typeof n === "string") : [],
  };
}

function writeAttempt(path: string, attempt: FanOutAttempt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(attempt, null, 2) + "\n");
}

/**
 * The stack-level change signal, from whichever end the invocation supplied.
 *
 * `--base` re-derives it here, which is the one-command shape a developer
 * wants. `--from-affected` reads what `chant lifecycle affected --json` already
 * wrote, which is the shape a CI job wants when an earlier step has run the
 * diff and there is no reason to build twice. Exactly one, because defaulting
 * either way would let a stale file silently beat a fresh `--base` or the other
 * way round.
 *
 * `dependents` is folded into `changed` when it is present. It is only present
 * when somebody asked for it (`--include-dependents`), and a stack that
 * consumes a changed export is affected at stack granularity in the same way a
 * changed component is at component granularity.
 */
async function resolveChangedUnits(
  ctx: CommandContext,
  config: ChantConfig,
): Promise<{ units: ChangedUnits } | { error: string; hint?: string }> {
  const { args } = ctx;
  const fromFile = args.fromAffected;
  if (args.base && fromFile) {
    return {
      error: "--base and --from-affected both name a change signal",
      hint: "Pass --base <ref> to derive it here, or --from-affected <file> to read one `chant lifecycle affected --json` already wrote.",
    };
  }

  if (fromFile) {
    let parsed: { changed?: unknown; dependents?: unknown; indeterminate?: unknown };
    try {
      parsed = JSON.parse(readFileSync(resolve(fromFile), "utf8"));
    } catch (err) {
      return { error: `--from-affected: could not read "${fromFile}": ${err instanceof Error ? err.message : String(err)}` };
    }
    const names = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((n): n is string => typeof n === "string") : [];
    if (!Array.isArray(parsed.changed)) {
      return {
        error: `--from-affected: "${fromFile}" has no "changed" array`,
        hint: "It should be the output of `chant lifecycle affected --base <ref> --json`.",
      };
    }
    return {
      units: {
        changed: [...new Set([...names(parsed.changed), ...names(parsed.dependents)])].sort(),
        indeterminate: names(parsed.indeterminate),
      },
    };
  }

  if (!args.base) {
    return {
      error: "A change signal is required: chant components fan-out --base <ref> [--head <ref>]",
      hint: "Or pass --from-affected <file> with the JSON `chant lifecycle affected --base <ref> --json` wrote.",
    };
  }

  try {
    const result = await affectedStacks({
      // Components are discovered from the current directory, the convention
      // every component command follows. In a multi-stack project the diff
      // reads the same root, because `stacks[].src` is written relative to it.
      projectPath: config.stacks?.length ? resolve(".") : resolveBuildRoot(args, config),
      serializers: ctx.plugins.map((p) => p.serializer),
      baseRef: args.base,
      headRef: args.head,
      includeDependents: args.includeDependents,
      // A project that declares its stacks gets an answer keyed by stack name,
      // which is the name a component's deploy step uses. Without this the diff
      // answers by lexicon partition and the join below claims none of it.
      ...(config.stacks ? { stacks: config.stacks } : {}),
    });
    return {
      units: {
        changed: [...new Set([...result.changed, ...result.dependents])].sort(),
        indeterminate: result.indeterminate,
      },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * chant components fan-out --base <ref> | --from-affected <file>
 *   [--head <ref>] [--include-dependents] [--env <env>] [--gate <name>]
 *   [--dry-run] [--json] [--resume <file>] [--seed-outputs <file>]
 *   [--dump-outputs <file>] [--progress-json]
 */
export async function runComponentsFanOut(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath).catch(() => ({ config: {} as ChantConfig }));

  const paramsResolution = resolveCliBuildParams(config.buildParams, {
    cli: parseParamFlags(args.param),
    paramsFile: args.paramsFile,
    verbose: args.verbose,
  });
  if (!paramsResolution.success) {
    for (const message of paramsResolution.errors) console.error(message);
    return 1;
  }

  const signal = await resolveChangedUnits(ctx, config);
  if ("error" in signal) {
    console.error(formatError({ message: signal.error, ...(signal.hint ? { hint: signal.hint } : {}) }));
    return 1;
  }

  let derived;
  try {
    derived = await deriveFanOut({
      path: projectPath,
      units: signal.units,
      sandbox: args.sandbox,
      buildParams: paramsResolution.provenance,
      config,
    });
  } catch (err) {
    // A cycle or an unknown `dependsOn` refuses here, over the whole graph and
    // before anything is selected (#2417). The message names the members.
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
  if (!derived.success) {
    console.error(formatError({ message: derived.error ?? "Could not discover components" }));
    return 1;
  }

  // A changed stack no component deploys is a hole in this fan-out's coverage.
  // Reporting it is the whole reason `componentsForUnits` returns it.
  if (derived.signal.unclaimed.length > 0) {
    console.error(formatWarning({
      message: `no component deploys these changed unit(s): ${derived.signal.unclaimed.join(", ")}`,
      hint: "They are outside this fan-out. Deploy them another way, or give a component a step that names them.",
    }));
  }

  const gate = args.gate ? { op: FAN_OUT_GATE_OP, gate: args.gate } : undefined;

  // `--resume`: what an earlier attempt at this same plan finished. Read before
  // the dry-run branch so a plan-only invocation shows what is actually left
  // rather than what the fan-out looked like the first time. Narrowing for the
  // real run happens inside `runFanOut`, before the gate is decided, so an
  // approval survives the resume rather than being re-asked for.
  const resumePath = args.resume ? resolve(args.resume) : undefined;
  let priorCompleted: string[] = [];
  let progress: FanOutProgress | undefined;
  if (resumePath) {
    let attempt: FanOutAttempt | undefined;
    try {
      attempt = readAttempt(resumePath);
    } catch (err) {
      console.error(formatError({ message: `--resume: could not read "${args.resume}": ${err instanceof Error ? err.message : String(err)}` }));
      return 1;
    }
    if (attempt && attempt.digest !== derived.plan.digest) {
      console.error(formatWarning({
        message: `--resume: "${args.resume}" records a different fan-out (${attempt.digest || "no digest"}), so its progress does not apply here`,
        hint: "The derivation changed, which makes this a different change. Everything selected will run.",
      }));
    } else if (attempt) {
      // Only `completed` is carried forward. The earlier attempt's failures are
      // recorded in the file for whoever has to read it, but feeding them back
      // as progress would block their subtrees again on the very run that
      // exists to retry them — the operator repeated the command precisely
      // because the thing that failed is now expected to work.
      priorCompleted = attempt.completed;
      progress = { completed: attempt.completed };
    }
  }

  if (args.dryRun) {
    // `remainingFanOut` carries the digest rather than minting a new one, so
    // the digest printed here is the same string that approves the real run.
    const plan = progress ? remainingFanOut(derived.plan, derived.components, progress) : derived.plan;
    if (args.json) renderFanOutJson(plan);
    else renderFanOutPlan(plan, { ...(gate ? { gate } : {}) });
    return 0;
  }

  const seededOutputs: Record<string, Record<string, unknown>> = {};
  for (const file of args.seedOutputs ?? []) {
    try {
      Object.assign(seededOutputs, JSON.parse(readFileSync(resolve(file), "utf8")));
    } catch (err) {
      console.error(formatError({ message: `--seed-outputs: could not read "${file}": ${err instanceof Error ? err.message : String(err)}` }));
      return 1;
    }
  }

  const registry = await fanOutRegistry(projectPath, config);
  const result = await runFanOut(derived.plan, derived.components, registry, {
    env: args.env ?? "local",
    componentOutputs: seededOutputs,
    ...(gate ? { gate } : {}),
    ...(progress ? { progress } : {}),
    ...(args.progressJson ? { onProgress: ndjsonProgressSink() } : {}),
  });

  if (args.dumpOutputs) {
    const dumpPath = resolve(args.dumpOutputs);
    mkdirSync(dirname(dumpPath), { recursive: true });
    writeFileSync(dumpPath, JSON.stringify(result.componentOutputs, null, 2));
  }

  // Written even on a failure and even on a gate: the next attempt needs to
  // know what this one got through, and a gated attempt got through nothing,
  // which is itself worth recording against this plan's digest.
  if (resumePath) {
    writeAttempt(resumePath, {
      digest: result.plan.digest,
      completed: [...new Set([...priorCompleted, ...result.completed])].sort(),
      failed: result.failed,
    });
  }

  if (args.json) renderFanOutJson(result);
  else renderFanOutHuman(result, { ...(gate ? { gate } : {}) });

  // The same durable trace `chant run --components` leaves (#597), for the
  // components this fan-out actually applied. A partial fan-out records the
  // branches that finished and nothing else, which is the whole reason the
  // runner reports `completed` separately from `failed`.
  if (result.status !== "gated") {
    await recordAutoReleasesForRun(
      result.results,
      args.env ?? "local",
      `fan-out-${Date.now()}`,
      resolveAutoReleaseDisabled(config, args.noReleaseRecord),
    );
  }

  if (result.status === "gated" && result.gate) {
    const pending = result.gate;
    console.error(formatInfo(`approve : chant approve ${pending.op} ${pending.gate} --plan ${result.plan.digest}`));
    writeGatedRunSummary({
      op: pending.op,
      gate: pending.gate,
      ...(pending.description ? { description: pending.description } : {}),
      expiresAt: pending.expiresAt,
      ...(pending.url ? { url: pending.url } : {}),
      ...(pending.planDigest ? { planDigest: pending.planDigest } : {}),
    });
    return GATED_EXIT_CODE;
  }

  return result.status === "ok" ? 0 : 1;
}
