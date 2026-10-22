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
 *
 * The approval and the progress are bound to different things (#4081). The
 * approval is bound to the plan digest, the derivation: who runs, in what
 * order, off which edges. The progress is bound to each component's input
 * digest (../../components/fan-out-inputs.ts): a component the earlier
 * attempt applied stays `already-applied` only while what it would apply is
 * the same, and one whose template, step inputs or upstream moved runs again
 * with a line saying so. The fix after a failure keeps the approval, and a
 * different change of the same shape does not inherit the progress.
 *
 * `--wave-gate <name>` (#3049) swaps the one gate for one per wave: the same
 * repeated command stops at each wave's gate in turn, each planned after the
 * wave before it applied, and `chant approve fan-out <name>-wave-<n>` answers
 * it. `--wave <n>` runs one wave, for a CI job per wave.
 */

import { resolve, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadChantConfig, resolveAutoReleaseDisabled, type ChantConfig } from "../../config";
import { samePlanDigest } from "../../lifecycle/plan-digest";
import { affectedStacks } from "../../lifecycle/affected";
import { changedFilesBetween, lexiconChangedUnits } from "../../components/changed-files";
import { deriveFanOut, fanOutRegistry } from "../../components/fan-out-support";
import { EarlierWaveNotAppliedError, EarlierWaveWaitingError, runFanOut, type FanOutWaveGate } from "../../components/fan-out-run";
import { readFanOutAttempt, writeFanOutAttempt, type FanOutAttempt } from "../../components/fan-out-record";
import { componentInputDigests, progressThatCarries } from "../../components/fan-out-inputs";
import { appliedDigestOf } from "../../components/auto-release";
import { describeChangedWave, withWaveRecord, type WaveRecord } from "../../gated-waves";
import { renderFanOutHuman, renderFanOutJson, renderFanOutPlan } from "../../components/fan-out-output";
import { ndjsonProgressSink } from "../../components/run-progress";
import { openCliRunEvents, refusesBothStreams } from "../run-events";
import { summaryLedgerPrefix, writeGatedRunSummary } from "../../op/gate-summary";
import { approveCommand, gateIsSealed } from "../../op/gate";
import { getHeadCommit } from "../../lifecycle/git";
import { remainingFanOut, type ChangedUnits, type FanOutProgress } from "../../components/fan-out";
import { readDeployedOutputs } from "../../components/wave-plan";
import { deployContext, failedRunExitCode } from "../../components/driver";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { formatError, formatInfo, formatWarning } from "../format";
import { reportUninstalledDependencies } from "../dependencies";
import { FAN_OUT_GATE_OP } from "../../op/gate-name";
import { resolveBuildRoot } from "./lifecycle";
import { GATED_EXIT_CODE, autoReleaseRun, recordAutoReleasesForRun } from "./run";
import type { CommandContext } from "../registry";
import { withComponentEndpoint } from "../component-endpoint";

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
export async function resolveChangedUnits(
  ctx: CommandContext,
  config: ChantConfig,
  opts: {
    /** Measure from this commit instead of `--base` (a pull request's merge base, #3183). */
    base?: string;
    /** Build both refs for `lifecycle affected` only when the project declares `stacks`. */
    stacksOnly?: boolean;
  } = {},
): Promise<{ units: ChangedUnits } | { error: string; hint?: string }> {
  const { args } = ctx;
  const base = opts.base ?? args.base;
  const fromFile = args.fromAffected;
  if (base && fromFile) {
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

  if (!base) {
    return {
      error: "A change signal is required: chant components fan-out --base <ref> [--head <ref>]",
      hint: "Or pass --from-affected <file> with the JSON `chant lifecycle affected --base <ref> --json` wrote.",
    };
  }

  try {
    // A unit that is not chant source, such as a Terraform root, never shows
    // in the artifact diff below; the lexicon that owns it answers from the
    // changed paths (#3183).
    const projectRoot = resolve(".");
    const lexiconUnits = ctx.plugins.some((p) => p.changedUnits)
      ? await lexiconChangedUnits(ctx.plugins, {
          projectRoot,
          config: config as Record<string, unknown>,
          changedFiles: await changedFilesBetween(projectRoot, base, args.head ?? "HEAD"),
        })
      : [];
    const result =
      opts.stacksOnly && !config.stacks?.length
        ? { changed: [], dependents: [], indeterminate: [] }
        : await affectedStacks({
            // Components are discovered from the current directory, the convention
            // every component command follows. In a multi-stack project the diff
            // reads the same root, because `stacks[].src` is written relative to it.
            projectPath: config.stacks?.length ? resolve(".") : resolveBuildRoot(args, config),
            serializers: ctx.plugins.map((p) => p.serializer),
            baseRef: base,
            headRef: args.head,
            includeDependents: args.includeDependents,
            // A project that declares its stacks gets an answer keyed by stack name,
            // which is the name a component's deploy step uses. Without this the diff
            // answers by lexicon partition and the join below claims none of it.
            ...(config.stacks ? { stacks: config.stacks } : {}),
          });
    return {
      units: {
        changed: [...new Set([...result.changed, ...result.dependents, ...lexiconUnits])].sort(),
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
 *   [--dump-outputs <file>] [--progress-json | --events-json]
 */
export async function runComponentsFanOut(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (refusesBothStreams(args)) return 1;
  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath).catch(() => ({ config: {} as ChantConfig }));
  // #4281: every capability the fan-out plans or runs reaches the environment's declared endpoint.
  return withComponentEndpoint(ctx, () => fanOut(ctx, projectPath, config), { config });
}

async function fanOut(ctx: CommandContext, projectPath: string, config: ChantConfig): Promise<number> {
  const { args } = ctx;

  const paramsResolution = resolveCliBuildParams(config.buildParams, {
    cli: parseParamFlags(args.param),
    paramsFile: args.paramsFile,
    verbose: args.verbose,
  });
  if (!paramsResolution.success) {
    for (const message of paramsResolution.errors) console.error(message);
    return 1;
  }

  // The two gate modes (#3049). `--gate` approves the whole set once, as
  // #2417 decided; `--wave-gate` approves each wave once the waves before it
  // applied. They answer different questions, so one run takes one of them.
  if (args.gate && args.waveGate) {
    console.error(formatError({
      message: "--gate and --wave-gate both name a gate",
      hint: "Pass --gate <name> for one approval over the whole set, or --wave-gate <name> for one per wave.",
    }));
    return 1;
  }
  if (args.wave !== undefined && !args.waveGate) {
    console.error(formatError({ message: "--wave runs one wave of a gated-wave fan-out, so it needs --wave-gate <name>" }));
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
      ...(args.canary?.length ? { canary: args.canary } : {}),
    });
  } catch (err) {
    // A cycle or an unknown `dependsOn` refuses here, over the whole graph and
    // before anything is selected (#2417). The message names the members.
    const message = err instanceof Error ? err.message : String(err);
    reportUninstalledDependencies([message], projectPath); // #4116
    console.error(formatError({ message }));
    return 1;
  }
  if (!derived.success) {
    // #4116: component files that import packages the project has not installed.
    if (derived.error) reportUninstalledDependencies([derived.error], projectPath);
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
  const waveGate: FanOutWaveGate | undefined = args.waveGate
    ? { op: FAN_OUT_GATE_OP, gate: args.waveGate, ...(args.wave !== undefined ? { only: args.wave } : {}) }
    : undefined;

  // `--resume`: what an earlier attempt at this same plan finished. Read before
  // the dry-run branch so a plan-only invocation shows what is actually left
  // rather than what the fan-out looked like the first time. Narrowing for the
  // real run happens inside `runFanOut`, before the gate is decided, so an
  // approval survives the resume rather than being re-asked for.
  const resumePath = args.resume ? resolve(args.resume) : undefined;
  // What each component would apply now (#4081). The record keeps it for
  // every component that applies, and a later attempt carries progress only
  // where it is unchanged.
  const inputsNow = resumePath ? componentInputDigests(derived.components, { projectRoot: projectPath, env: args.env ?? "local" }) : {};
  let priorCompleted: string[] = [];
  let priorInputs: Record<string, string> = {};
  let priorOutputs: Record<string, Record<string, unknown>> = {};
  let priorWaves: WaveRecord[] = [];
  let priorCarried: Record<string, unknown> = {};
  let priorFailed: string[] = [];
  let progress: FanOutProgress | undefined;
  if (resumePath) {
    let attempt: FanOutAttempt | undefined;
    try {
      attempt = readFanOutAttempt(resumePath);
    } catch (err) {
      console.error(formatError({ message: `--resume: could not read "${args.resume}": ${err instanceof Error ? err.message : String(err)}` }));
      return 1;
    }
    if (attempt && !samePlanDigest(attempt.digest, derived.plan.digest)) {
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
      //
      // And only the part of `completed` whose input is the same now (#4081).
      // The plan digest identifies the derivation, which a different change
      // of the same shape shares; the input digest says what was applied.
      const split = progressThatCarries(attempt, inputsNow);
      if (split.unrecorded && split.changed.length > 0) {
        console.error(formatWarning({
          message: `--resume: "${args.resume}" does not record what each component applied, so none of its progress carries`,
          hint: "It was written before chant recorded component inputs. Everything selected will run.",
        }));
      } else {
        for (const name of split.changed) {
          console.error(formatInfo(`${name}: changed since the earlier attempt, so it runs again`));
        }
      }
      const carried = new Set(split.carried);
      priorCompleted = split.carried;
      priorInputs = Object.fromEntries(split.carried.map((name) => [name, inputsNow[name]!]));
      priorOutputs = Object.fromEntries(
        Object.entries(attempt.outputs).filter(([name]) => carried.has(name)),
      );
      progress = { completed: split.carried };
      priorWaves = attempt.waves ?? [];
      // #4291: what failed stays in the record until it applies, so each later wave's job blocks its dependents and runs the rest.
      priorFailed = attempt.failed.filter((name) => !carried.has(name));
      if (waveGate?.only !== undefined) {
        waveGate.failedEarlier = priorFailed;
        waveGate.waitingEarlier = priorWaves.filter((w) => w.status === "gated").map((w) => ({ wave: w.wave, gate: w.gate, components: w.components }));
      }
      // What steps kept per member (#3459), such as a choudoufu root's wave
      // resume file. Each step decides whether what it kept still applies.
      priorCarried = attempt.carried ?? {};
    }
  }

  if (args.dryRun) {
    // `remainingFanOut` carries the digest rather than minting a new one, so
    // the digest printed here is the same string that approves the real run.
    // A gated-wave fan-out keeps the derivation's wave numbers, since they
    // name the gates, so its plan is printed whole.
    const plan = progress && !waveGate ? remainingFanOut(derived.plan, derived.components, progress) : derived.plan;
    if (args.json) renderFanOutJson(plan);
    else renderFanOutPlan(plan, { ...(gate ? { gate } : {}), ...(waveGate ? { waveGate } : {}) });
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
  const env = args.env ?? "local";

  // A completed component's recorded outputs win over a `--seed-outputs`
  // entry for the same name, as a fresh apply's outputs merge over a seed in
  // the driver: the record holds what this fan-out itself applied. A seed
  // neither gives is read from the deployed estate (#4104), through its
  // capability's `outputs`, as pr-plan reads a dependency outside the change.
  // One that cannot be read leaves its dependents' references unresolved.
  const componentOutputs: Record<string, Record<string, unknown>> = { ...seededOutputs, ...priorOutputs };
  const seeds = (progress ? remainingFanOut(derived.plan, derived.components, progress) : derived.plan).seeds;
  let deployedSeeds: Record<string, string[]>;
  try {
    deployedSeeds = await readDeployedOutputs(
      seeds,
      new Map(derived.components.map((c) => [c.name, c])),
      registry,
      (name) => deployContext({ env }, name),
      componentOutputs,
    );
  } catch (err) {
    console.error(formatError({
      message: `could not read the deployed outputs of ${seeds.filter((s) => !(s in componentOutputs)).join(", ")}: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Nothing ran. --seed-outputs <file> gives a component's outputs instead of reading them.",
    }));
    return 1;
  }
  for (const [name, keys] of Object.entries(deployedSeeds)) {
    console.error(formatInfo(`${name}: outputs read from the deployed estate (${keys.length > 0 ? keys.join(", ") : "none yet"})`));
  }

  // #3061: the commit this run deploys, for the workloads' vcs.ref.head.revision.
  const revision = await getHeadCommit().catch(() => undefined);

  // The record is rewritten as each component settles, not only once the run
  // returns. A fan-out killed in its third wave (a cancelled CI job, a lost
  // runner, ctrl-c) then still knows that the first two applied, and the
  // repeated command picks up from there instead of redoing them.
  const completedSoFar = new Set(priorCompleted);
  const inputsSoFar: Record<string, string> = { ...priorInputs };
  const failedSoFar = new Set(priorFailed);
  const outputsSoFar = { ...priorOutputs };
  let wavesSoFar = priorWaves;
  const carriedSoFar: Record<string, unknown> = { ...priorCarried };
  const recordAttempt = (): void => {
    if (!resumePath) return;
    const attempt: FanOutAttempt = {
      digest: derived.plan.digest,
      completed: [...completedSoFar].sort(),
      failed: [...failedSoFar].sort(),
      outputs: outputsSoFar,
      inputs: Object.fromEntries(Object.entries(inputsSoFar).sort(([a], [b]) => a.localeCompare(b))),
      ...(wavesSoFar.length > 0 ? { waves: wavesSoFar } : {}),
      ...(Object.keys(carriedSoFar).length > 0 ? { carried: carriedSoFar } : {}),
    };
    writeFanOutAttempt(resumePath, attempt);
  };

  // The run id the release records carry, chosen before the run so that
  // `--events-json` (#4041) names the run by it too.
  const release = autoReleaseRun(`fan-out-${Date.now()}`);
  const events = await openCliRunEvents(args, { kind: "component", name: `fan-out ${derived.plan.order.join(",")}`, runId: release.runId, cwd: projectPath });

  let result;
  try {
    result = await runFanOut(derived.plan, derived.components, registry, {
      env,
      releaseIdentity: () => (revision ? { revision } : {}),
      componentOutputs,
      ...(gate ? { gate } : {}),
      ...(waveGate ? { waveGate } : {}),
      ...(waveGate
        ? {
            onWaveSettled: (record: WaveRecord) => {
              wavesSoFar = withWaveRecord(wavesSoFar, record);
              recordAttempt();
            },
          }
        : {}),
      ...(progress ? { progress } : {}),
      ...(Object.keys(priorCarried).length > 0 ? { carried: priorCarried } : {}),
      ...(resumePath
        ? {
            onCarry: (member: string, value: unknown) => {
              carriedSoFar[member] = value;
              recordAttempt();
            },
          }
        : {}),
      ...(args.progressJson ? { onProgress: ndjsonProgressSink() } : {}),
      ...(events ? { onRunEvent: events.emit } : {}),
      ...(resumePath
        ? {
            onComponentSettled: (settled, outputs) => {
              if (settled.status === "ok") {
                completedSoFar.add(settled.component);
                if (inputsNow[settled.component] !== undefined) inputsSoFar[settled.component] = inputsNow[settled.component]!;
                if (outputs) outputsSoFar[settled.component] = outputs;
                failedSoFar.delete(settled.component);
              } else if (settled.status === "fail") {
                failedSoFar.add(settled.component);
              }
              recordAttempt();
            },
          }
        : {}),
    });
  } catch (err) {
    events?.settle("failed", err instanceof Error ? err.message : String(err));
    // `--wave <n>` reached before an earlier wave applied: nothing ran.
    // #4291: an earlier wave waits at its gate, so this one waits too.
    if (err instanceof EarlierWaveWaitingError) {
      console.error(formatInfo(err.message));
      return GATED_EXIT_CODE;
    }
    if (err instanceof EarlierWaveNotAppliedError) {
      console.error(formatError({ message: err.message }));
      return 1;
    }
    throw err;
  }
  // The fan-out settles the stream; this only ends one it left open.
  events?.settle(result.status === "fail" ? "failed" : result.status);

  if (args.dumpOutputs) {
    const dumpPath = resolve(args.dumpOutputs);
    mkdirSync(dirname(dumpPath), { recursive: true });
    writeFileSync(dumpPath, JSON.stringify(result.componentOutputs, null, 2));
  }

  // Written again at the end, even on a failure and even on a gate: a gated
  // attempt got through nothing, which is itself worth recording against this
  // plan's digest.
  recordAttempt();

  if (args.json) renderFanOutJson(result);
  else renderFanOutHuman(result, { ...(gate ? { gate } : {}), ...(waveGate ? { waveGate } : {}) });

  // A wave whose set moved after its approval stops with both digests named
  // (#3049), the #2300 refusal on a set. Printed on stderr even under --json,
  // since it is the line a CI log reader is looking for.
  for (const wave of result.waves ?? []) {
    if (wave.status === "gated" && wave.approved) {
      console.error(formatWarning({ message: describeChangedWave(wave, await gateIsSealed(wave.gate)) }));
    }
  }

  // The same durable trace `chant run --components` leaves (#597), for the
  // components this fan-out actually applied. A partial fan-out records the
  // branches that finished and nothing else, which is the whole reason the
  // runner reports `completed` separately from `failed`.
  // A gated-wave run can stop at a later wave's gate after earlier waves
  // applied, and those applies are recorded like any other.
  if (result.status !== "gated" || result.completed.length > 0) {
    await recordAutoReleasesForRun(
      result.results,
      args.env ?? "local",
      release.runId,
      resolveAutoReleaseDisabled(config, args.noReleaseRecord),
      release.runOrigin,
      undefined,
      undefined,
      // #4274: a component that publishes nothing is recorded by its deploy-input digest.
      appliedDigestOf({ components: derived.components, env: args.env ?? "local", projectRoot: projectPath }),
    );
  }

  // A failed root outranks a gate in the status, but a gated-wave run that
  // stopped at a wave's gate still prints how to approve it.
  if (result.gate && (result.status === "gated" || waveGate)) {
    const pending = result.gate;
    // The pending fact's own plan: the fan-out's digest for the gate over the
    // set, or a component's plan and environment for a gate inside one (#2574).
    const sealed = await gateIsSealed(pending.gate);
    console.error(formatInfo(
      `approve : ${approveCommand(pending.op, pending.gate, pending.environment, pending.planDigest ?? result.plan.digest, sealed)}`,
    ));
    writeGatedRunSummary({
      sealed,
      op: pending.op,
      gate: pending.gate,
      ...(pending.description ? { description: pending.description } : {}),
      expiresAt: pending.expiresAt,
      ...(pending.url ? { url: pending.url } : {}),
      ...(pending.planDigest ? { planDigest: pending.planDigest } : {}),
      ...(await summaryLedgerPrefix()),
      ...(pending.environment ? { environment: pending.environment } : {}),
    });
    return result.status === "gated" ? GATED_EXIT_CODE : failedRunExitCode(result.results);
  }

  // A step that refused the wave's plan because its target moved since the
  // approval exits 3, the code of a wave whose plan changed (#3997).
  return result.status === "ok" ? 0 : failedRunExitCode(result.results);
}
