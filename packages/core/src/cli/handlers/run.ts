import { resolve, dirname } from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { loadChantConfig, resolveAutoReleaseDisabled, type ChantConfig } from "../../config";
import { discoverOps } from "../../op/discover";
import type { OpConfig } from "../../op/types";
import { loadActivities, loadProfiles } from "../../op/activity-registry";
import { runOpLocally, findPolicyGateStep, OpRunFailure, type StepRecord } from "../../op/local-executor";
import { approveCommand } from "../../op/gate";
import { writeGatedRunSummary, type GatedRunSummary } from "../../op/gate-summary";
import { createLocalOpRuntime } from "../../op/runtimes/local";
import type { OpRuntimeProvider, OpRunStatus } from "../../op/runtime";
import { renderHuman, renderJson } from "../../op/local-output";
import { loadPlugins } from "../plugins";
import { recordGateApproval } from "./operator";
import { formatError, formatWarning, formatSuccess, formatBold, formatInfo } from "../format";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import type { CommandContext } from "../registry";
import { renderDriverHuman, renderDriverJson } from "../../components/driver-output";
import { ndjsonProgressSink } from "../../components/run-progress";
import { maybeRecordAutoRelease } from "../../components/auto-release";
import { maybePersistBuildManifest } from "../../components/manifest-persistence";
import type { DriverComponentResult } from "../../components/driver";

/**
 * The exit code a run that stopped at an unapproved gate uses (#2119).
 * Deliberately not 1: a gate is a standing fact waiting on a human, and a CI
 * job that treats it as a failure would page someone for a decision nobody has
 * made yet.
 */
export const GATED_EXIT_CODE = 3;

/**
 * The exit code this invocation gives a gated run — {@link GATED_EXIT_CODE}
 * unless `--gated-exit <code>` asked for another one (#2243).
 *
 * The mapping lives here rather than in a shell wrapper in every generated
 * pipeline, so one rule covers every forge: GitHub Actions has no neutral
 * conclusion for a `run:` step, so a push-to-main apply that stops at its gate
 * paints the branch red on every merge until someone approves. `--gated-exit
 * 0` is how the job that knows a pending approval is not a failure says so.
 *
 * Only the gated outcome is remapped. A failed run still returns 1, so the
 * flag can never hide a broken apply. Returns `undefined` after printing the
 * refusal when the value is not a process exit status.
 */
function resolveGatedExitCode(ctx: CommandContext): number | undefined {
  const raw = ctx.args.gatedExit;
  if (raw === undefined) return GATED_EXIT_CODE;
  if (!Number.isInteger(raw) || raw < 0 || raw > 255) {
    console.error(formatError({
      message: "--gated-exit expects a whole number from 0 to 255",
      hint: `Got ${Number.isNaN(raw) ? "a non-numeric value" : String(raw)}. ` +
        `Pass --gated-exit 0 to make a run that stopped at a gate a success for CI; ` +
        `omit the flag for the default ${GATED_EXIT_CODE}.`,
    }));
    return undefined;
  }
  return raw;
}

/**
 * What a gated run leaves behind for CI, beyond the stderr block the renderers
 * already print (#2243): the same gate, approve command and ledger path
 * appended to whatever file `GITHUB_STEP_SUMMARY` names, so the run page says
 * what is pending without anyone opening the log.
 *
 * Also says on stderr that the exit code was remapped, when it was. A job that
 * passes `--gated-exit 0` reports success, and the one line that explains why
 * a zero-exit run applied nothing belongs next to the gate itself.
 */
function reportGatedRun(summary: GatedRunSummary, exitCode: number): void {
  writeGatedRunSummary(summary);
  if (exitCode !== GATED_EXIT_CODE) {
    console.error(formatInfo(
      `gated: exiting ${exitCode} because --gated-exit asked for it. Nothing after the gate ran.`,
    ));
  }
}

/**
 * `run list/status/log/cancel --components` reported a component's *durable*
 * run state — a run that outlives the CLI process and can be queried, signalled
 * or cancelled afterwards (#589). #2116 removed the runtime that provided it.
 * The local driver runs a component to completion inside this process, so there
 * is no separate run left to ask about once the command returns.
 *
 * Returns 1; the caller returns it straight back.
 */
function refuseDurableComponentSubcommand(what: string, hint: string): number {
  console.error(formatError({
    message: `\`${what}\` read a component's durable run state, which #2116 removed`,
    hint,
  }));
  return 1;
}

// ── The runtime seam (#2121) ────────────────────────────────────────────────

/**
 * Resolve the one runtime this invocation talks to.
 *
 * `--on <name>` picks the named lexicon's `opRuntime` (`../../lexicon.ts`);
 * without it, core's built-in `local` provider runs the Op in this process.
 * Every `chant run` subcommand goes through whichever comes back, so there is
 * one dispatch path rather than a branch per runtime.
 *
 * A lexicon already loaded into the command context wins the lookup — that is
 * how a test hands in a stub, and how a command that loaded plugins for its
 * own reasons avoids loading them twice. Otherwise the project's configured
 * lexicons are loaded on demand: `chant run` is not a `requiresPlugins`
 * command, and a plain local run must not start paying for plugin resolution.
 *
 * Returns `undefined` after printing an actionable error — an unconfigured
 * name is answered with the configured list, a configured lexicon that hosts
 * nothing is named outright.
 */
async function resolveOpRuntime(ctx: CommandContext): Promise<OpRuntimeProvider | undefined> {
  const on = ctx.args.on;
  if (!on || on === "local") return createLocalOpRuntime({ projectPath: resolve(".") });

  // Read the configured list straight from `chant.config.ts` rather than
  // through `resolveProjectLexicons`: `--on` names a *configured* lexicon, and
  // that helper's fallback is a source scan of the whole project, which is a
  // long wait to be told a name is wrong.
  let configured: string[] = [];
  try {
    configured = (await loadChantConfig(resolve("."))).config.lexicons ?? [];
  } catch {
    // No/unreadable chant.config.ts — the error below says so by listing nothing.
  }

  let plugin = ctx.plugins.find((p) => p.name === on);
  if (!plugin && configured.includes(on)) {
    plugin = (await loadPlugins([on]).catch(() => []))[0];
  }

  if (!plugin) {
    const known = [...new Set([...ctx.plugins.map((p) => p.name), ...configured])];
    console.error(formatError({
      message: `--on ${on}: "${on}" is not a configured lexicon`,
      hint: known.length > 0
        ? `Configured lexicons: ${known.join(", ")}. Omit --on to run on the built-in local runtime.`
        : "chant.config.ts configures no lexicons. Omit --on to run on the built-in local runtime.",
    }));
    return undefined;
  }

  if (!plugin.opRuntime) {
    console.error(formatError({
      message: `--on ${on}: lexicon "${on}" does not host Op runs`,
      hint: "It declares no opRuntime. Omit --on to run on the built-in local runtime.",
    }));
    return undefined;
  }

  return plugin.opRuntime;
}

/** An ISO-8601 instant trimmed to what a table cell has room for. */
function shortInstant(iso: string | undefined): string {
  return iso ? iso.slice(0, 19).replace("T", " ") : "—";
}

/** Print what a runtime reports for a settled or in-flight run. */
function renderRuntimeStatus(label: string, name: string, runtime: string, status: OpRunStatus): void {
  console.log(formatBold(`${label}: ${name}`));
  console.log(`  Runtime     : ${runtime}`);
  console.log(`  Run ID      : ${status.runId}`);
  console.log(`  State       : ${status.state}`);
  console.log(`  Started     : ${shortInstant(status.startedAt)}`);
  if (status.endedAt) console.log(`  Ended       : ${shortInstant(status.endedAt)}`);
  if (status.records) {
    const settled = status.records.filter((r) => r.status !== "skipped").length;
    console.log(`  Steps       : ${settled}/${status.records.length} settled`);
  }
  if (status.gate) {
    console.log(`  Gate        : ${status.gate.name} (pending since ${status.gate.since})`);
  }
  if (status.error) console.log(`  Error       : ${status.error}`);
}

// ── chant run list ──────────────────────────────────���─────────────────────────

export async function runOpList(ctx: CommandContext): Promise<number> {
  if (ctx.args.components) return runComponentsList();
  return runOpListOnRuntime(ctx);
}

/**
 * `chant run list` on the resolved runtime (#2121) — discover every Op, ask
 * the runtime what it knows about each, print one row per Op. The runtime
 * answers for all of them in one call (`list`), so a hosted runtime can do it
 * in one round trip instead of N.
 *
 * An Op the runtime has no run for prints with no state annotation.
 */
async function runOpListOnRuntime(ctx: CommandContext): Promise<number> {
  const runtime = await resolveOpRuntime(ctx);
  if (!runtime) return 1;

  const { ops, errors } = await discoverOps();
  for (const err of errors) console.error(formatError({ message: err }));

  if (ops.size === 0) {
    console.error(formatWarning({ message: "No Op definitions found (*.op.ts)" }));
    return 0;
  }

  let states: Map<string, OpRunStatus | undefined>;
  try {
    states = await runtime.list([...ops.values()].map((d) => d.config));
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.log(
    "NAME".padEnd(26) +
    "PHASES".padEnd(8) +
    "DEPENDS".padEnd(20) +
    "OVERVIEW",
  );

  for (const [name, { config }] of ops) {
    const phases = String(config.phases.length);
    const deps = config.depends?.join(",") ?? "—";
    const overview = config.overview.length > 36
      ? config.overview.slice(0, 33) + "..."
      : config.overview;
    const state = states.get(name)?.state;

    console.log(
      (name + (state ? ` [${state}]` : "")).padEnd(26) +
      phases.padEnd(8) +
      deps.padEnd(20) +
      overview,
    );
  }

  return 0;
}

/**
 * `chant run list --components` (#599) listed discovered components annotated
 * with each one's durable run status. Discovery alone is what `chant list
 * --components` already prints, so with the status column gone (#2116) this
 * subcommand has nothing of its own left to say.
 */
function runComponentsList(): Promise<number> {
  return Promise.resolve(refuseDurableComponentSubcommand(
    "chant run list --components",
    "Run `chant list --components` to see discovered components.",
  ));
}

// ── chant run status <name> ───────────────────────────────────────────────────

export async function runOpStatus(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    const label = ctx.args.components ? "Component" : "Op";
    console.error(formatError({ message: `${label} name is required: chant run status <name>` }));
    return 1;
  }

  if (ctx.args.components) {
    return refuseDurableComponentSubcommand(
      "chant run status --components",
      "Run `chant components status` for a component's release and build state.",
    );
  }
  return runOpStatusOnRuntime(ctx, name);
}

/**
 * `chant run status <name>` on the resolved runtime (#2121). A runtime with
 * no record of the Op is not an error: it prints one line saying so and exits
 * 0, because "this runtime has never run it" is a true answer to the question.
 */
async function runOpStatusOnRuntime(ctx: CommandContext, name: string): Promise<number> {
  const runtime = await resolveOpRuntime(ctx);
  if (!runtime) return 1;

  let status: OpRunStatus | undefined;
  try {
    status = await runtime.status(name);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  if (!status) {
    console.error(formatInfo(`No run of Op "${name}" is recorded on the "${runtime.name}" runtime.`));
    return 0;
  }

  renderRuntimeStatus("Op", name, runtime.name, status);
  return 0;
}

// ── chant run log <name> ──────────────────────────────────────────────────────

export async function runOpLog(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    const label = ctx.args.components ? "Component" : "Op";
    console.error(formatError({ message: `${label} name is required: chant run log <name>` }));
    return 1;
  }

  if (ctx.args.components) {
    return refuseDurableComponentSubcommand(
      "chant run log --components",
      "Run `chant components status` for a component's recorded releases.",
    );
  }
  return runOpLogOnRuntime(ctx, name);
}

/**
 * `chant run log <name>` on the resolved runtime (#2121) — the runtime's own
 * run history, newest first, `--limit <n>` rows at most.
 */
async function runOpLogOnRuntime(ctx: CommandContext, name: string): Promise<number> {
  const runtime = await resolveOpRuntime(ctx);
  if (!runtime) return 1;

  let records;
  try {
    records = await runtime.log(name, ctx.args.limit === undefined ? undefined : { limit: ctx.args.limit });
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  if (records.length === 0) {
    console.error(formatInfo(`No run of Op "${name}" is recorded on the "${runtime.name}" runtime.`));
    return 0;
  }

  console.log(
    "RUN-ID".padEnd(38) +
    "STATUS".padEnd(10) +
    "STARTED".padEnd(26) +
    "ENDED",
  );
  for (const record of records) {
    console.log(
      record.id.padEnd(38) +
      record.status.padEnd(10) +
      shortInstant(record.started).padEnd(26) +
      shortInstant(record.ended),
    );
  }

  return 0;
}

// ── chant run approve <op> <gate> ────────────────────────────────────────────

/**
 * `chant run approve <op> <gate> [--approver] [--url] [--note]` (#2121) — the
 * rename of `chant run signal`, and a different act.
 *
 * A gate resolution is a fact, not a message: the ledger write is the whole
 * of it, and it is the same write `chant approve` performs
 * (`recordGateApproval`, ./operator.ts), so a resolution recorded here reads
 * back identically. The runtime is told afterwards, through its optional
 * `resolveGate`, purely so a runtime that parks a run mid-flight can wake it
 * now rather than on its next tick. A runtime without that method is not a
 * failure — the fact is recorded either way, and the next run re-reads it.
 */
export async function runOpApprove(ctx: CommandContext): Promise<number> {
  const opName = ctx.args.extraPositional;
  const gate = ctx.args.extraPositional2;
  if (!opName || !gate) {
    console.error(formatError({ message: "Usage: chant run approve <op> <gate>" }));
    return 1;
  }

  const runtime = await resolveOpRuntime(ctx);
  if (!runtime) return 1;

  const outcome = await recordGateApproval(opName, gate, {
    actor: ctx.args.approver ?? ctx.args.actor,
    note: ctx.args.note,
    url: ctx.args.url,
  });
  if (!outcome.ok) return 1;

  if (!runtime.resolveGate) {
    console.error(formatInfo(
      `The "${runtime.name}" runtime reads the resolution when the op next runs — re-run \`chant run ${opName}\`.`,
    ));
    return 0;
  }

  try {
    await runtime.resolveGate(opName, gate, outcome.record);
  } catch (err) {
    console.error(formatWarning({
      message:
        `The resolution is recorded, but the "${runtime.name}" runtime could not be woken: ` +
        (err instanceof Error ? err.message : String(err)),
      hint: `Re-run \`chant run ${opName} --on ${runtime.name}\` once the runtime is reachable.`,
    }));
    return 1;
  }

  console.error(formatSuccess(`Runtime "${runtime.name}" was notified of the resolution.`));
  return 0;
}

/**
 * `chant run signal` was renamed `chant run approve` (#2121). Registered so
 * the old spelling says where the verb went instead of being read as an Op
 * named "signal".
 */
export function runOpSignalRenamed(ctx: CommandContext): Promise<number> {
  const opName = ctx.args.extraPositional ?? "<op>";
  const gate = ctx.args.extraPositional2 ?? "<gate>";
  console.error(formatError({
    message: "`chant run signal` is now `chant run approve`",
    hint: `A gate is resolved by recording the fact, not by sending a message: chant run approve ${opName} ${gate}`,
  }));
  return Promise.resolve(1);
}

// ── chant run cancel <name> ───────────────────────────────────────────────────

/** `chant run cancel <name>` — asks the resolved runtime (#2121) to stop the Op's active run. */
export async function runOpCancel(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    console.error(formatError({ message: "Op name is required: chant run cancel <name>" }));
    return 1;
  }

  if (!ctx.args.force) {
    console.error(formatWarning({
      message: `Cancelling "${name}" will stop the active run`,
      hint: "Use --force to confirm cancellation",
    }));
    return 1;
  }

  if (ctx.args.components) {
    return refuseDurableComponentSubcommand(
      "chant run cancel --components",
      "A component run lives and dies with the `chant run --components` process — interrupt that instead.",
    );
  }

  return runOpCancelOnRuntime(ctx, name);
}

/**
 * `chant run cancel <name>` on the resolved runtime (#2121). `--force` is
 * already checked by the caller, so a runtime only ever sees a confirmed
 * request; a runtime with nothing to cancel says so in its own words and the
 * command exits non-zero.
 */
async function runOpCancelOnRuntime(ctx: CommandContext, name: string): Promise<number> {
  const runtime = await resolveOpRuntime(ctx);
  if (!runtime) return 1;

  try {
    await runtime.cancel(name, { force: true });
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.error(formatSuccess(`Cancellation requested for Op "${name}" on the "${runtime.name}" runtime`));
  return 0;
}

// ── chant run <name> — main command ───────────────────────────────────────────

/**
 * `chant run <name>` dispatcher.
 *
 * Every run goes through the runtime resolved by `--on` (#2121); without it,
 * core's built-in local provider runs the Op in this process, where a `gate`
 * is decided against the gate ledger and ends the run pending approval
 * (#2119), exit code 3.
 *
 * `chant run --components <name|all>` (#585) is a separate target: discovered
 * `Component` declarations dispatched through the interpret driver
 * (`../../components/driver.ts`) rather than a `*.op.ts` Op. Checked first,
 * mirroring `runGraph`'s `if (ctx.args.components) return
 * runComponentGraph(ctx)` branch (../handlers/graph.ts).
 *
 * chant #1116 — `--report` with `--components` is checked and hard-errored
 * before that dispatch, and #2116 retired `--report` on the Op path too: it
 * rendered a past durable run's workflow history, which no runtime keeps any
 * more. Both refuse rather than falling through to a real dispatch — the
 * component case was observed live reaching an actual cloud shell-out.
 */
/**
 * Pre-flight for `chant run <op> --sandbox` on an Op containing a `policyGate`
 * step (chant #2003). `--sandbox` is a global flag, and `../main.ts` arms the
 * process-wide policy latch off it for every command — so the gate's
 * `loadPolicyChecks` refuses mid-run with a message addressed to a chant
 * maintainer ("This is a chant bug"), which is not an answer a user can act
 * on. Refuse here instead, before anything runs, naming the combination and
 * what to do about it.
 *
 * Keyed on the flag rather than on whether the project declares
 * `lint.policies`: the flag is what arms the latch, and a gate that builds the
 * project in this process is a divergence from what `--sandbox` promises
 * whether or not a policy module happens to be declared. Returns true when the
 * caller should stop.
 */
function refusesPolicyGateUnderSandbox(ctx: CommandContext, config: OpConfig, opName: string): boolean {
  if (!ctx.args.sandbox) return false;
  if (!findPolicyGateStep(config)) return false;
  console.error(formatError({
    message: `Op "${opName}" has a policyGate step, which cannot run under --sandbox: the gate builds this project and imports its lint.policies in the chant process, which --sandbox forbids.`,
    hint: "Re-run without --sandbox, or drop the policyGate step from this Op. Running the gate itself inside the sandbox boundary is tracked on chant#1157.",
  }));
  return true;
}

export async function runOp(ctx: CommandContext): Promise<number> {
  if (ctx.args.components && ctx.args.report) {
    console.error(formatError({
      message: "--report is not supported with --components",
      hint: "No preview/dry-run mode exists yet for the component driver (see chant#1116). Omit --report.",
    }));
    return 1;
  }
  if (ctx.args.components) return runOpComponents(ctx);
  if (ctx.args.report) {
    console.error(formatError({
      message: "`chant run --report` rendered a past durable run, which #2116 removed",
      hint: "Run `chant run log <op>` for the runtime's own run history.",
    }));
    return 1;
  }
  return runOpOnRuntime(ctx);
}

// ── Auto-release recording post-run (#597) ──────────────────────────────────

/**
 * After a successful `chant run --components` (local executor), auto-emit
 * one release record per successfully deployed component that published a
 * digest-bearing artifact — reusing `maybeRecordAutoRelease`
 * (../../components/auto-release.ts), which itself reuses
 * `../../lifecycle/release-ledger.ts`'s `appendReleaseRecord` verbatim. Never
 * called on a failed run: both call sites below only reach this after
 * confirming `result.success`/`componentResult.ok`, so a failed deploy writes
 * nothing, by construction.
 *
 * Also persists the component's accumulated `BuildArchiveManifest`, when its
 * composition produced one, to the durable build-manifest store (#609,
 * ../../components/manifest-persistence.ts, ../../lifecycle/build-ledger-
 * store.ts) — the missing piece that lets `chant components status`'s
 * `componentBom`/`build.reproducibility` resolve to a real manifest instead
 * of always reporting `null`. Same `disabled` opt-out flag as the release
 * record: both are "durably record this successful deploy" side effects, so
 * `--no-release-record`/`release.autoRecord: false` gates persistence too
 * rather than needing a second, easy-to-forget knob (see
 * `ManifestPersistOptions.disabled`'s doc).
 *
 * Best-effort and silent on the happy path: a skip (opted out, no digest/
 * manifest, no actor) is unremarkable and not printed; only an actual write
 * failure (`reason: "error"`) is surfaced, as a warning — never a nonzero
 * exit, since the deploy itself already succeeded and a ledger-write hiccup
 * must not retroactively fail it.
 */
async function recordAutoReleasesForRun(
  results: DriverComponentResult[],
  env: string,
  runId: string,
  disabled: boolean,
): Promise<void> {
  for (const componentResult of results) {
    if (!componentResult.ok) continue;
    const outcome = await maybeRecordAutoRelease(
      {
        component: componentResult.component,
        env,
        success: true,
        records: componentResult.records,
        runId,
        // A local-executor id resolves nowhere — say so in a field (#2045).
        runOrigin: { forge: "local" },
      },
      { disabled },
    );
    if (!outcome.recorded && outcome.reason === "error") {
      console.error(formatWarning({
        message: `release record for "${componentResult.component}"@${env} was not recorded: ${outcome.error}`,
      }));
    } else if (outcome.recorded) {
      console.error(formatInfo(
        `Recorded release: ${formatBold(componentResult.component)}@${env} -> ${outcome.record.digest} (commit ${outcome.commit.slice(0, 7)})`,
      ));
    }

    const manifestOutcome = await maybePersistBuildManifest(
      { success: true, records: componentResult.records },
      { disabled },
    );
    if (!manifestOutcome.persisted && manifestOutcome.reason === "error") {
      console.error(formatWarning({
        message: `build manifest for "${componentResult.component}"@${env} was not persisted: ${manifestOutcome.error}`,
      }));
    } else if (manifestOutcome.persisted) {
      console.error(formatInfo(
        `Persisted build manifest: ${formatBold(componentResult.component)} -> ${manifestOutcome.manifestDigest} (commit ${manifestOutcome.commit.slice(0, 7)})`,
      ));
    }
  }
}

// ── chant run --components <name|all> ────────────────────────────────────────

/**
 * `chant run --components <name|all> [--env <env>]` (#585) — the interpret
 * driver's CLI entrypoint, and since #2116 the only component run path there
 * is. `args.path` is the component name (or `all`), matching `chant run
 * <name>`'s Op-dispatch convention exactly (`args.path` is the Op name there
 * too) rather than a project directory — components are always discovered from
 * the current working directory, the same way Op discovery (`discoverOps()`)
 * never takes a project-path argument either.
 *
 * The selector resolves through the runtime's `runComponents` and runs on the
 * local in-process driver; a `gate` is decided against the gate ledger when
 * the driver reaches it (#2119), and one nobody has approved ends the run with
 * exit code 3 and the `chant approve` line, exactly as `chant run <op>` does.
 *
 * On a successful run, auto-emits one release-ledger record per component
 * that published a digest (#597, `recordAutoReleasesForRun` above) — a
 * *post-run* CLI step, not a change to the driver itself (`../../components/
 * driver.ts` stays capability-agnostic and knows nothing about the ledger).
 * Opt out with `--no-release-record` or `chant.config.ts`'s
 * `release.autoRecord: false`; the default is ON. A failed run never reaches
 * this step, so it writes nothing.
 *
 * chant #1108 — resolves this invocation's declared build-time parameters
 * (`chant.config.ts`'s `buildParams`, against `--param`/`--params-file`/a
 * declared `env` mapping) the exact same way `chant build` does
 * (`resolveCliBuildParams`, shared with `buildCommand`), BEFORE anything
 * discovers/imports a `*.component.ts` file.
 * Before this, `params.*` (`@intentius/chant/params`) was always `{}` under
 * this command, no matter what a component's `chant.config.ts` declared or a
 * CI job's environment supplied — see chant #1108. `chant.config.ts` is
 * loaded once here (with the same defensive fallback the post-run
 * auto-release check below used to apply itself) and reused for that check,
 * rather than loaded a second time.
 */
export async function runOpComponents(ctx: CommandContext): Promise<number> {
  const selector = ctx.args.path;
  if (!selector || selector === ".") {
    console.error(formatError({
      message: "Component name is required: chant run --components <name|all>",
      hint: "Run `chant list --components` to see available components.",
    }));
    return 1;
  }

  const gatedExit = resolveGatedExitCode(ctx);
  if (gatedExit === undefined) return 1;

  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath).catch(() => ({ config: {} as ChantConfig }));
  const paramsResolution = resolveCliBuildParams(config.buildParams, {
    cli: parseParamFlags(ctx.args.param),
    paramsFile: ctx.args.paramsFile,
    verbose: ctx.args.verbose,
  });
  if (!paramsResolution.success) {
    for (const message of paramsResolution.errors) console.error(message);
    return 1;
  }

  const runtime = await resolveOpRuntime(ctx);
  if (!runtime) return 1;
  if (!runtime.runComponents) {
    console.error(formatError({
      message: `--components is not supported on the "${runtime.name}" runtime`,
      hint: "Omit --on to run components on the built-in local runtime.",
    }));
    return 1;
  }

  const env = ctx.args.env ?? "local";
  // Seed cross-component/cross-stack outputs from upstream jobs' dumped files
  // (`--seed-outputs`), so a single-component run resolves references to a
  // component that ran in an earlier CI job.
  const seededOutputs: Record<string, Record<string, unknown>> = {};
  for (const file of ctx.args.seedOutputs ?? []) {
    try {
      Object.assign(seededOutputs, JSON.parse(readFileSync(resolve(file), "utf8")));
    } catch (err) {
      console.error(formatError({
        message: `--seed-outputs: could not read "${file}": ${err instanceof Error ? err.message : String(err)}`,
      }));
      return 1;
    }
  }
  // `--progress-json` (#M3, behold roadmap): stream one NDJSON RunProgressEvent
  // per line to stdout while the run executes, so a consumer (e.g. behold) can
  // render live wave/component/phase/step progress instead of tailing raw
  // logs. Purely additive: when the flag is absent, `onProgress` stays
  // `undefined` and every `onProgress?.(...)` call in the driver is a no-op —
  // behavior is byte-for-byte unchanged from before this flag existed.
  const onProgress = ctx.args.progressJson ? ndjsonProgressSink() : undefined;
  const result = await runtime.runComponents(projectPath, selector, {
    env: ctx.args.env,
    componentOutputs: seededOutputs,
    onProgress,
    sandbox: ctx.args.sandbox,
    buildParams: paramsResolution.provenance,
  });

  // Dump the accumulated outputs for a downstream job to seed from. Written
  // even on failure (partial outputs) so a resumed run still has what completed.
  if (ctx.args.dumpOutputs && result.run) {
    const dumpPath = resolve(ctx.args.dumpOutputs);
    mkdirSync(dirname(dumpPath), { recursive: true });
    writeFileSync(dumpPath, JSON.stringify(result.run.componentOutputs, null, 2));
  }

  if (!result.success && !result.run && !result.gated) {
    console.error(formatError({ message: result.error ?? "Failed to run component(s)" }));
    return 1;
  }

  if (result.run) {
    if (ctx.args.json) renderDriverJson(result.run); else renderDriverHuman(result.run);
  }

  // Gated (#2119): the same fact-and-stop the Op path takes, and the same
  // exit code. Nothing to release — the component stopped short of finishing.
  if (result.gated) {
    const { gate } = result.gated;
    console.error(formatWarning({
      message: `component "${result.gated.component}" is gated on "${gate.gate}" — pending approval`,
    }));
    console.error(formatInfo(`approve : ${approveCommand(gate.op, gate.gate)}`));
    if (gate.url) console.error(formatInfo(`approve at: ${gate.url}`));
    console.error(formatInfo(`expires : ${gate.expiresAt}`));
    // #2310: this run's own append reached only the local chant/lifecycle
    // branch. The gate is still right to stand, but an operator elsewhere
    // cannot see the pending fact to approve it, and nothing else here says
    // why not.
    if (result.gated.pushed === false) {
      console.error(formatWarning({
        message: `the pending fact was not pushed to the remote: ${result.gated.pushWarning ?? "recorded locally only"}`,
        hint: "an operator working from a clone of the remote cannot approve it until it does",
      }));
    }
    reportGatedRun(
      {
        op: gate.op,
        gate: gate.gate,
        ...(gate.description ? { description: gate.description } : {}),
        expiresAt: gate.expiresAt,
        ...(gate.url ? { url: gate.url } : {}),
        ...(result.gated.pushed === false ? { pushed: false, pushWarning: result.gated.pushWarning } : {}),
      },
      gatedExit,
    );
    return gatedExit;
  }

  if (result.success && result.run) {
    const disabled = resolveAutoReleaseDisabled(config, ctx.args.noReleaseRecord);
    await recordAutoReleasesForRun(result.run.results, env, `local-${Date.now()}`, disabled);
  }

  return result.success ? 0 : 1;
}

/**
 * `chant run <name>` on the resolved runtime (#2121) — the built-in `local`
 * provider by default, a lexicon's `opRuntime` under `--on <name>`.
 *
 * This function knows nothing about how a run happens. It discovers the Op,
 * runs the CLI-level pre-flights that are about flags rather than execution
 * (`--sandbox` over a `policyGate` step, #2003), hands the config to the
 * runtime, and renders whatever comes back. On the local runtime that is the
 * executor's own `OpRunResult`, so `--json` and the human render are exactly
 * what they were before the seam existed; a runtime that reports only a state
 * gets the terser render instead.
 */
export async function runOpOnRuntime(ctx: CommandContext): Promise<number> {
  const opName = ctx.args.path;
  if (!opName || opName === ".") {
    console.error(formatError({
      message: "Op name is required: chant run <name>",
      hint: "Run `chant run list` to see available Ops",
    }));
    return 1;
  }

  const gatedExit = resolveGatedExitCode(ctx);
  if (gatedExit === undefined) return 1;

  const { ops, errors } = await discoverOps();
  for (const err of errors) console.error(formatWarning({ message: err }));

  const discovered = ops.get(opName);
  if (!discovered) {
    const names = [...ops.keys()];
    console.error(formatError({
      message: `Op "${opName}" not found`,
      hint: names.length > 0
        ? `Available: ${names.join(", ")}`
        : "No *.op.ts files found — create one",
    }));
    return 1;
  }

  const { config } = discovered;

  // Pre-flight: --sandbox cannot cover a policyGate step (#2003).
  if (refusesPolicyGateUnderSandbox(ctx, config, opName)) return 1;

  const runtime = await resolveOpRuntime(ctx);
  if (!runtime) return 1;

  // `--progress-json` streams one NDJSON StepRecord per settled step, fed by
  // whatever the runtime reports through `progress`.
  const progress = ctx.args.progressJson ? ndjsonProgressSink<StepRecord>() : undefined;

  // Ctrl-C aborts in-flight activities (kills their child processes) instead of
  // orphaning them. The handler is removed in `finally` so it never leaks.
  const controller = new AbortController();
  const onSigint = () => {
    console.error(formatWarning({ message: "interrupted — stopping Op" }));
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    const handle = await runtime.start(config, {
      env: ctx.args.env,
      ...(ctx.args.profile !== undefined ? { profile: ctx.args.profile } : {}),
      progress,
      signal: controller.signal,
    });
    const status = await handle.result();

    if (status.result) {
      // The executor's own render already prints a gate, its approve line
      // and its expiry (#2119).
      if (ctx.args.json) renderJson(status.result); else renderHuman(status.result);
    } else {
      renderRuntimeStatus("Op", opName, runtime.name, status);
      if (status.state === "gated" && status.gate) {
        console.error(formatWarning({
          message: `Op "${opName}" is waiting on gate "${status.gate.name}"`,
          hint: `Record the resolution with: ${approveCommand(opName, status.gate.name)}`,
        }));
      }
    }

    // Exit 3 for a gated run (#2119) — a distinct code so CI can tell
    // "waiting on a human" from a broken op, and retry the one but not the
    // other. `--gated-exit <code>` remaps that one outcome and nothing else
    // (#2243).
    if (status.state === "gated") {
      // The local runtime carries the whole pending fact on its result; a
      // runtime that reports only a state carries the gate's name alone.
      const pending = status.result?.gate;
      const gate = pending?.gate ?? status.gate?.name;
      if (gate) {
        reportGatedRun(
          {
            op: opName,
            gate,
            ...(pending?.description ? { description: pending.description } : {}),
            ...(pending?.expiresAt ? { expiresAt: pending.expiresAt } : {}),
            ...(pending?.url ? { url: pending.url } : {}),
            // #2310: the local runtime knows whether this run's own append
            // reached the remote; a runtime that reports only a state does not.
            ...(status.result?.gatePushed === false
              ? { pushed: false, pushWarning: status.result.gatePushWarning }
              : {}),
          },
          gatedExit,
        );
      }
      return gatedExit;
    }
    return status.state === "completed" ? 0 : 1;
  } catch (err) {
    if (err instanceof OpRunFailure) {
      if (ctx.args.json) renderJson(err.result); else renderHuman(err.result);
      return 1;
    }
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

// ── fallback ────────────────────────────────────────────────────────────────���─

export function runOpUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown run subcommand: ${ctx.args.extraPositional ?? ctx.args.path}`,
    hint: "Available: chant run <name>, run list, run status, run approve, run cancel, run log",
  }));
  return Promise.resolve(1);
}
