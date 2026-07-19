import { resolve, join, dirname } from "node:path";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { loadChantConfig, resolveAutoReleaseDisabled } from "../../config";
import { discoverOps } from "../../op/discover";
import { loadActivities, loadProfiles } from "../../op/activity-registry";
import { runOpLocally, findGate, LocalGateUnsupportedError, OpRunFailure } from "../../op/local-executor";
import { renderHuman, renderJson } from "../../op/local-output";
import { formatError, formatWarning, formatSuccess, formatBold, formatInfo } from "../format";
import type { CommandContext } from "../registry";
import {
  loadTemporalClient,
  connectionOptions,
  resolveWorkflowId,
  resolveProfile,
  type WorkflowHandleRaw,
  type WorkflowExecutionDescription,
  type WorkflowHistoryRaw,
} from "./run-client";
import { generateReport, writeReport } from "./run-report";
import { runComponents, resolveComponentTargets, findComponentGate, listComponents } from "../../components/cli-support";
import { renderDriverHuman, renderDriverJson } from "../../components/driver-output";
import { ndjsonProgressSink } from "../../components/run-progress";
import { loadComponentTemporalCodegen } from "../../components/temporal-codegen-loader";
import { applyConfigDefaults } from "../../components/config-defaults";
import { maybeRecordAutoRelease, extractRunDigestFromPhaseOutputs } from "../../components/auto-release";
import { maybePersistBuildManifest, extractRunManifestFromPhaseOutputs } from "../../components/manifest-persistence";
import type { DriverComponentResult } from "../../components/driver";

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function workflowFnName(opName: string): string {
  return kebabToCamel(opName) + "Workflow";
}

/**
 * Guard for Temporal-only commands (run list/status/log/signal/cancel, --report).
 * These query durable run state that only exists under Temporal. Returns true
 * when `--temporal` was passed; otherwise prints an actionable message and the
 * caller should return non-zero.
 */
function requireTemporalMode(ctx: CommandContext, what: string): boolean {
  if (ctx.args.temporal) return true;
  console.error(formatError({
    message: `\`${what}\` is not available in local mode`,
    hint: "pass --temporal or configure a profile",
  }));
  return false;
}

export async function makeTemporalClient(profileName: string | undefined, projectPath: string) {
  const { config } = await loadChantConfig(projectPath);
  const profile = resolveProfile(config as Record<string, unknown>, profileName);
  const { Connection, Client } = await loadTemporalClient();
  const connection = await Connection.connect(connectionOptions(profile));
  const client = new Client({ connection, namespace: profile.namespace });
  return { client, profile, config };
}

/**
 * Register the Keyword search attributes the generated workflow upserts
 * (`OpName`, `Phase`, plus any op-declared) on the namespace, so the first
 * workflow task does not fail with `BadSearchAttributes`. Registered one at a
 * time so an already-present attribute (`ALREADY_EXISTS`) does not block the
 * rest. Only used for the autoStart dev server — a real server (autoStart=false)
 * is expected to have these pre-registered (it may reject registration).
 */
async function ensureSearchAttributes(client: unknown, namespace: string, names: string[]): Promise<void> {
  const operatorService = (
    client as { connection?: { operatorService?: { addSearchAttributes?: (r: unknown) => Promise<unknown> } } }
  ).connection?.operatorService;
  if (!operatorService?.addSearchAttributes) return;
  const KEYWORD = 2; // Temporal IndexedValueType KEYWORD
  for (const name of names) {
    try {
      await operatorService.addSearchAttributes({ namespace, searchAttributes: { [name]: KEYWORD } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already|exists/i.test(msg)) {
        console.error(formatWarning({ message: `Could not register search attribute "${name}": ${msg}` }));
      }
    }
  }
}

// ── chant run list ──────────────────────────────────���─────────────────────────

export async function runOpList(ctx: CommandContext): Promise<number> {
  if (ctx.args.components) return runComponentsList(ctx);

  if (!requireTemporalMode(ctx, "chant run list")) return 1;
  const { ops, errors } = await discoverOps();

  for (const err of errors) {
    console.error(formatError({ message: err }));
  }

  if (ops.size === 0) {
    console.error(formatWarning({ message: "No Op definitions found (*.op.ts)" }));
    return 0;
  }

  console.log(
    "NAME".padEnd(22) +
    "PHASES".padEnd(8) +
    "TASK-QUEUE".padEnd(20) +
    "DEPENDS".padEnd(20) +
    "OVERVIEW",
  );

  let runStatus: Map<string, string> | undefined;
  try {
    const projectPath = resolve(".");
    const { config } = await loadChantConfig(projectPath);
    const profile = resolveProfile(config as Record<string, unknown>, ctx.args.profile);
    const { Connection, Client } = await loadTemporalClient();
    const connection = await Connection.connect(connectionOptions(profile));
    const client = new Client({ connection, namespace: profile.namespace });
    runStatus = new Map();
    for (const [name] of ops) {
      try {
        const desc = await client.workflow.getHandle(resolveWorkflowId(name)).describe();
        runStatus.set(name, desc.status.name);
      } catch {
        runStatus.set(name, "—");
      }
    }
  } catch {
    // Temporal not available — degrade gracefully
  }

  for (const [name, { config }] of ops) {
    const phases = String(config.phases.length);
    const tq = config.taskQueue ?? config.name;
    const deps = config.depends?.join(",") ?? "—";
    const overview = config.overview.length > 36
      ? config.overview.slice(0, 33) + "..."
      : config.overview;
    const status = runStatus?.get(name);
    const statusStr = status ? ` [${status}]` : "";

    console.log(
      (name + statusStr).padEnd(22) +
      phases.padEnd(8) +
      tq.padEnd(20) +
      deps.padEnd(20) +
      overview,
    );
  }

  return 0;
}

/**
 * `chant run list --components` (#599) — the component counterpart of
 * `runOpList` above, mirrored shape-for-shape: discover, print a header,
 * best-effort annotate with Temporal run status, print one row per entry.
 * Kept behind the same `requireTemporalMode` gate as the Op path — the whole
 * point of this subcommand is the run-status annotation, and components have
 * no local notion of a "run" to list either (mirrors the "Temporal-only
 * subcommand guards" test coverage for the Op list/status/log/signal/cancel
 * set).
 *
 * Discovery + column shape reuses `listComponents` (../../components/cli-
 * support.ts), the same helper `chant list --components` already uses, so
 * archetype inference/field projection isn't duplicated here — this function
 * only adds the Temporal status column. Status lookups use
 * `componentWorkflowId`, the id space `runOpSignal`/`runOpCancel` established
 * for components (#589) — kept distinct from `resolveWorkflowId`'s Op id
 * space so an Op and a component can share a name.
 */
async function runComponentsList(ctx: CommandContext): Promise<number> {
  if (!requireTemporalMode(ctx, "chant run list --components")) return 1;

  const projectPath = resolve(".");
  const result = await listComponents(projectPath);

  if (!result.success) {
    for (const err of result.errors) console.error(formatError({ message: err }));
    return 1;
  }

  if (result.components.length === 0) {
    console.error(formatWarning({ message: "No component definitions found (*.component.ts)" }));
    return 0;
  }

  console.log(
    "NAME".padEnd(22) +
    "ARCHETYPE".padEnd(18) +
    "PHASES".padEnd(8) +
    "DEPENDS".padEnd(20) +
    "FILE",
  );

  let runStatus: Map<string, string> | undefined;
  try {
    const { config } = await loadChantConfig(projectPath);
    const profile = resolveProfile(config as Record<string, unknown>, ctx.args.profile);
    const { Connection, Client } = await loadTemporalClient();
    const connection = await Connection.connect(connectionOptions(profile));
    const client = new Client({ connection, namespace: profile.namespace });
    runStatus = new Map();
    for (const { name } of result.components) {
      try {
        const desc = await client.workflow.getHandle(componentWorkflowId(name)).describe();
        runStatus.set(name, desc.status.name);
      } catch {
        runStatus.set(name, "—");
      }
    }
  } catch {
    // Temporal not available — degrade gracefully
  }

  for (const c of result.components) {
    const phases = String(c.phases.length);
    const deps = c.dependsOn.join(",") || "—";
    const status = runStatus?.get(c.name);
    const statusStr = status ? ` [${status}]` : "";

    console.log(
      (c.name + statusStr).padEnd(22) +
      c.archetype.padEnd(18) +
      phases.padEnd(8) +
      deps.padEnd(20) +
      c.filePath,
    );
  }

  return 0;
}

// ── chant run status <name> ───────────────────────────────────────────────────

export async function runOpStatus(ctx: CommandContext): Promise<number> {
  if (!requireTemporalMode(ctx, "chant run status")) return 1;
  const name = ctx.args.extraPositional;
  if (!name) {
    const label = ctx.args.components ? "Component" : "Op";
    console.error(formatError({ message: `${label} name is required: chant run status <name>` }));
    return 1;
  }

  if (ctx.args.components) return runComponentStatus(ctx, name);

  const projectPath = resolve(".");
  let client, desc: WorkflowExecutionDescription, history: WorkflowHistoryRaw;
  try {
    ({ client } = await makeTemporalClient(ctx.args.profile, projectPath));
    const handle = client.workflow.getHandle(resolveWorkflowId(name));
    desc = await handle.describe();
    history = await handle.fetchHistory();
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.log(formatBold(`Op: ${name}`));
  console.log(`  Workflow ID : ${desc.workflowId}`);
  console.log(`  Run ID      : ${desc.runId}`);
  console.log(`  Status      : ${desc.status.name}`);
  console.log(`  Task Queue  : ${desc.taskQueue}`);
  console.log(`  Started     : ${desc.startTime.toISOString()}`);
  if (desc.closeTime) console.log(`  Closed      : ${desc.closeTime.toISOString()}`);

  const events = history.events ?? [];
  const completed = events.filter((e) => e.eventType === "ActivityTaskCompleted").length;
  const scheduled = events.filter((e) => e.eventType === "ActivityTaskScheduled").length;
  if (scheduled > 0) {
    console.log(`  Activities  : ${completed}/${scheduled} completed`);
  }

  return 0;
}

/**
 * `chant run status <name> --components` (#599) — the component counterpart
 * of `runOpStatus` above. Identical describe+history rendering; the only
 * difference is the workflow id (`componentWorkflowId`, not
 * `resolveWorkflowId`) and the "Component:" label, mirroring how
 * `runOpSignal`/`runOpCancel` already distinguish the two id spaces (#589).
 */
async function runComponentStatus(ctx: CommandContext, name: string): Promise<number> {
  const projectPath = resolve(".");
  let client, desc: WorkflowExecutionDescription, history: WorkflowHistoryRaw;
  try {
    ({ client } = await makeTemporalClient(ctx.args.profile, projectPath));
    const handle = client.workflow.getHandle(componentWorkflowId(name));
    desc = await handle.describe();
    history = await handle.fetchHistory();
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.log(formatBold(`Component: ${name}`));
  console.log(`  Workflow ID : ${desc.workflowId}`);
  console.log(`  Run ID      : ${desc.runId}`);
  console.log(`  Status      : ${desc.status.name}`);
  console.log(`  Task Queue  : ${desc.taskQueue}`);
  console.log(`  Started     : ${desc.startTime.toISOString()}`);
  if (desc.closeTime) console.log(`  Closed      : ${desc.closeTime.toISOString()}`);

  const events = history.events ?? [];
  const completed = events.filter((e) => e.eventType === "ActivityTaskCompleted").length;
  const scheduled = events.filter((e) => e.eventType === "ActivityTaskScheduled").length;
  if (scheduled > 0) {
    console.log(`  Activities  : ${completed}/${scheduled} completed`);
  }

  return 0;
}

// ── chant run log <name> ──────────────────────────────────────────────────────

export async function runOpLog(ctx: CommandContext): Promise<number> {
  if (!requireTemporalMode(ctx, "chant run log")) return 1;
  const name = ctx.args.extraPositional;
  if (!name) {
    const label = ctx.args.components ? "Component" : "Op";
    console.error(formatError({ message: `${label} name is required: chant run log <name>` }));
    return 1;
  }

  if (ctx.args.components) return runComponentLog(ctx, name);

  const projectPath = resolve(".");
  let client;
  try {
    ({ client } = await makeTemporalClient(ctx.args.profile, projectPath));
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.log(
    "RUN-ID".padEnd(36) +
    "STATUS".padEnd(16) +
    "STARTED".padEnd(26) +
    "CLOSED",
  );

  try {
    const fnName = workflowFnName(name);
    for await (const run of client.workflow.list({ query: `WorkflowType = "${fnName}"` })) {
      const start = run.startTime.toISOString().slice(0, 19).replace("T", " ");
      const close = run.closeTime ? run.closeTime.toISOString().slice(0, 19).replace("T", " ") : "—";
      console.log(
        run.runId.padEnd(36) +
        run.status.name.padEnd(16) +
        start.padEnd(26) +
        close,
      );
    }
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  return 0;
}

/**
 * `chant run log <name> --components` (#599) — the component counterpart of
 * `runOpLog` above. Same table shape; the `WorkflowType` query needs the
 * component's generated workflow function name rather than
 * `workflowFnName`'s Op convention, so this loads the Temporal component
 * codegen module (`../../components/temporal-codegen-loader.ts`, the same
 * loader `runComponentTemporal` already uses) purely for its
 * `componentWorkflowFnName` helper — no compilation happens here, `log` only
 * reads past run history.
 */
async function runComponentLog(ctx: CommandContext, name: string): Promise<number> {
  const projectPath = resolve(".");
  let client;
  try {
    ({ client } = await makeTemporalClient(ctx.args.profile, projectPath));
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  let fnName: string;
  try {
    const codegen = await loadComponentTemporalCodegen();
    fnName = codegen.componentWorkflowFnName(name);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.log(
    "RUN-ID".padEnd(36) +
    "STATUS".padEnd(16) +
    "STARTED".padEnd(26) +
    "CLOSED",
  );

  try {
    for await (const run of client.workflow.list({ query: `WorkflowType = "${fnName}"` })) {
      const start = run.startTime.toISOString().slice(0, 19).replace("T", " ");
      const close = run.closeTime ? run.closeTime.toISOString().slice(0, 19).replace("T", " ") : "—";
      console.log(
        run.runId.padEnd(36) +
        run.status.name.padEnd(16) +
        start.padEnd(26) +
        close,
      );
    }
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  return 0;
}

// ── chant run signal <name> <signal> ─────────────────────────────────────────

/**
 * `chant run signal <name> <signal> [--components]` — sends a signal to a
 * running Op workflow by default, or a component workflow when `--components`
 * is passed (#589): the durable path's gate is otherwise unclearable from the
 * CLI. Resolves the workflow id via `componentWorkflowId` (`chant-component-
 * <name>`) instead of `resolveWorkflowId` (`chant-op-<name>`) in that case —
 * the two id spaces are kept distinct so an Op and a component can share a
 * name without colliding.
 */
export async function runOpSignal(ctx: CommandContext): Promise<number> {
  if (!requireTemporalMode(ctx, "chant run signal")) return 1;
  const name = ctx.args.extraPositional;
  const signalName = ctx.args.extraPositional2;

  if (!name || !signalName) {
    console.error(formatError({ message: "Usage: chant run signal <name> <signal-name>" }));
    return 1;
  }

  const projectPath = resolve(".");
  const workflowId = ctx.args.components ? componentWorkflowId(name) : resolveWorkflowId(name);
  let handle: WorkflowHandleRaw;
  try {
    const { client } = await makeTemporalClient(ctx.args.profile, projectPath);
    handle = client.workflow.getHandle(workflowId);
    await handle.signal(signalName);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.error(formatSuccess(`Signal "${signalName}" sent to ${ctx.args.components ? "component" : "Op"} "${name}"`));
  return 0;
}

// ── chant run cancel <name> ───────────────────────────────────────────────────

/** `chant run cancel <name> [--components]` — cancels an Op workflow by default, or a component workflow when `--components` is passed (#589), mirroring `runOpSignal`'s id resolution. */
export async function runOpCancel(ctx: CommandContext): Promise<number> {
  if (!requireTemporalMode(ctx, "chant run cancel")) return 1;
  const name = ctx.args.extraPositional;
  if (!name) {
    console.error(formatError({ message: "Op name is required: chant run cancel <name>" }));
    return 1;
  }

  if (!ctx.args.force) {
    console.error(formatWarning({
      message: `Cancelling "${name}" will stop the active workflow run`,
      hint: "Use --force to confirm cancellation",
    }));
    return 1;
  }

  const projectPath = resolve(".");
  const workflowId = ctx.args.components ? componentWorkflowId(name) : resolveWorkflowId(name);
  let handle: WorkflowHandleRaw;
  try {
    const { client } = await makeTemporalClient(ctx.args.profile, projectPath);
    handle = client.workflow.getHandle(workflowId);
    await handle.cancel();
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.error(formatSuccess(`Cancellation requested for ${ctx.args.components ? "component" : "Op"} "${name}"`));
  return 0;
}

// ── chant run <name> — main command ───────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"]);
const POLL_INTERVAL_MS = 3000;

async function waitForTemporalServer(address: string, maxWaitMs = 30_000): Promise<void> {
  const [host, portStr] = address.split(":");
  const port = parseInt(portStr ?? "7233", 10);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((res, rej) => {
        const socket = createConnection({ host, port }, () => { socket.destroy(); res(); });
        socket.on("error", rej);
        socket.setTimeout(1000, () => { socket.destroy(); rej(new Error("timeout")); });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Temporal server at ${address} did not become ready within ${maxWaitMs / 1000}s`);
}

function renderProgress(opName: string, history: WorkflowHistoryRaw): void {
  const events = history.events ?? [];
  const completed = events.filter((e) => e.eventType === "ActivityTaskCompleted").length;
  const scheduled = events.filter((e) => e.eventType === "ActivityTaskScheduled").length;
  process.stderr.write(
    `\r${formatInfo(`[${opName}]`)} ${completed}/${scheduled} activities completed`,
  );
}

/**
 * `chant run <name>` dispatcher.
 *
 * Local mode is the default — it runs the Op in-process with no Temporal
 * server. `--temporal` opts into a cluster (gates, schedules, durable resume).
 * `--report` reads a past durable run and is therefore Temporal-only.
 *
 * `chant run --components <name|all>` (#585) is a separate target: discovered
 * `Component` declarations dispatched through the interpret driver
 * (`../../components/driver.ts`) rather than a `*.op.ts` Op. Checked first,
 * mirroring `runGraph`'s `if (ctx.args.components) return
 * runComponentGraph(ctx)` branch (../handlers/graph.ts).
 */
export async function runOp(ctx: CommandContext): Promise<number> {
  if (ctx.args.components) return runOpComponents(ctx);
  if (ctx.args.local && ctx.args.temporal) {
    console.error(formatError({
      message: "--local and --temporal are mutually exclusive",
      hint: "omit both for local mode (the default), or pass exactly one",
    }));
    return 1;
  }
  if (ctx.args.report) {
    if (!requireTemporalMode(ctx, "chant run --report")) return 1;
    return runOpTemporal(ctx);
  }
  return ctx.args.temporal ? runOpTemporal(ctx) : runOpLocal(ctx);
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
 * `chant run --components <name|all> [--env <env>] [--temporal]` (#585, and
 * #589 for `--temporal`) — the interpret driver's CLI entrypoint. `args.path`
 * is the component name (or `all`), matching `chant run <name>`'s Op-dispatch
 * convention exactly (`args.path` is the Op name there too) rather than a
 * project directory — components are always discovered from the current
 * working directory, the same way Op discovery (`discoverOps()`) never takes
 * a project-path argument either.
 *
 * Local mode (the default) resolves the selector through `runComponents`
 * (`../../components/cli-support.ts`) and runs it on the local in-process
 * executor; gated components are rejected before any step runs (matching
 * `runOpLocal`'s pre-flight `findGate` guard) with an actionable message
 * pointing at `--temporal`.
 *
 * `--temporal` (#589) takes the durable path instead: compiles the named
 * component's composition to a Temporal workflow/worker (mirroring
 * `Temporal::Op` codegen — see `runComponentTemporal` below), and gates are
 * now ACCEPTED — a gate is durable wait-for-signal there, not a local
 * in-process block. Scoped to a single named component (`all --temporal` is
 * out of scope for #589: coordinating N durable workflows' cross-component
 * `dependsOn` durably is a follow-up, not part of "compile a component's
 * `deploy` composition into a durable orchestrator").
 *
 * On a successful run, auto-emits one release-ledger record per component
 * that published a digest (#597, `recordAutoReleasesForRun` above) — a
 * *post-run* CLI step, not a change to the driver itself (`../../components/
 * driver.ts` stays capability-agnostic and knows nothing about the ledger).
 * Opt out with `--no-release-record` or `chant.config.ts`'s
 * `release.autoRecord: false`; the default is ON. A failed run never reaches
 * this step, so it writes nothing.
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

  if (ctx.args.temporal) return runComponentTemporal(ctx, selector);

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
  const result = await runComponents(resolve("."), selector, { env: ctx.args.env, componentOutputs: seededOutputs, onProgress });

  // Dump the accumulated outputs for a downstream job to seed from. Written
  // even on failure (partial outputs) so a resumed run still has what completed.
  if (ctx.args.dumpOutputs && result.run) {
    const dumpPath = resolve(ctx.args.dumpOutputs);
    mkdirSync(dirname(dumpPath), { recursive: true });
    writeFileSync(dumpPath, JSON.stringify(result.run.componentOutputs, null, 2));
  }

  if (result.gateUnsupported) {
    console.error(formatError({
      message:
        `component "${result.gateUnsupported.component}": gate "${result.gateUnsupported.signalName}" is not ` +
        `supported on the local executor — gates need a durable runtime.`,
      hint: "Re-run with `chant run --components " + result.gateUnsupported.component + " --temporal`.",
    }));
    return 1;
  }

  if (!result.success && !result.run) {
    console.error(formatError({ message: result.error ?? "Failed to run component(s)" }));
    return 1;
  }

  if (result.run) {
    if (ctx.args.json) renderDriverJson(result.run); else renderDriverHuman(result.run);
  }

  if (result.success && result.run) {
    const { config } = await loadChantConfig(resolve(".")).catch(() => ({ config: {} }));
    const disabled = resolveAutoReleaseDisabled(config, ctx.args.noReleaseRecord);
    await recordAutoReleasesForRun(result.run.results, env, `local-${Date.now()}`, disabled);
  }

  return result.success ? 0 : 1;
}

// ── chant run --components <name> --temporal (#589) ─────────────────────────

function componentWorkflowId(componentName: string): string {
  return `chant-component-${componentName}`;
}

/**
 * `chant run --components <name> --temporal` (#589, epic #551 §5/§8) — the
 * durable counterpart to `runOpComponents`'s local path. Mirrors
 * `runOpTemporal`'s shape exactly (build+spawn worker, submit workflow, poll,
 * report) but "build" here means compiling the component's composition
 * on-the-fly via `loadComponentTemporalCodegen` (the Temporal lexicon's
 * `serializeComponent`, mirroring `serializeOps`) rather than reading a
 * pre-existing `dist/ops/<name>/worker.ts` — components have no separate
 * `chant build` step that already produced generated files the way Ops do, so
 * this generates `dist/components/<name>/{workflow,worker,activities}.ts`
 * itself before spawning.
 *
 * Unlike the local executor, a `gate` anywhere in the component's
 * composition is fully supported: the generated workflow durably waits for
 * the signal (see `serializeComponent`'s codegen), survivable across a worker
 * crash and clearable via `chant run signal <name> <signal> --components
 * --temporal` (`runOpSignal` above, extended for components alongside this
 * issue).
 */
async function runComponentTemporal(ctx: CommandContext, selector: string): Promise<number> {
  if (selector === "all") {
    console.error(formatError({
      message: "`chant run --components all --temporal` is not supported",
      hint: "Pass a single component name — durable execution is compiled and run per component (see epic #551 #589).",
    }));
    return 1;
  }

  const projectPath = resolve(".");
  const resolved = await resolveComponentTargets(projectPath, selector);
  if (!resolved.success || resolved.targets.length === 0) {
    console.error(formatError({ message: resolved.error ?? `Component "${selector}" not found` }));
    return 1;
  }
  const component = resolved.targets[0];

  // Load config + profile (mirrors runOpTemporal).
  const { config: chantConfig } = await loadChantConfig(projectPath);
  let profile;
  try {
    profile = resolveProfile(chantConfig as Record<string, unknown>, ctx.args.profile);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  // Compile the component to workflow/worker/activities under dist/components/<name>/.
  let codegen;
  try {
    codegen = await loadComponentTemporalCodegen();
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  // (#629) Fill `chant.config.ts`'s `sbom`/`signing`/`vulnPolicy` defaults into
  // every recognized step BEFORE codegen — same pass the interpret/local path
  // runs in `runComponents` (../../components/cli-support.ts). The Temporal path
  // *inlines* the resolved composition into the generated workflow/activities,
  // so if we serialized the raw component the durable path would silently drop
  // project-level supply-chain defaults the local path honors. (The GitLab
  // generate path needs no equivalent: it emits thin `chant run --components`
  // trigger jobs, so defaults are applied at run time inside the triggered job.)
  const resolvedComponent = applyConfigDefaults(component, chantConfig);
  const files = codegen.serializeComponent(resolvedComponent, { env: ctx.args.env });
  for (const [relPath, content] of Object.entries(files)) {
    const outPath = join(projectPath, "dist", relPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content);
  }

  const workerPath = join(projectPath, "dist", "components", component.name, "worker.ts");

  // autoStart: spin up temporal server if needed (mirrors runOpTemporal).
  if (profile.autoStart) {
    console.error(formatInfo("autoStart: checking Temporal server..."));
    try {
      await waitForTemporalServer(profile.address, 2000);
      console.error(formatInfo("Temporal server already running."));
    } catch {
      console.error(formatInfo("Starting temporal server start-dev..."));
      spawnChild("temporal", ["server", "start-dev"], {
        cwd: projectPath,
        stdio: "ignore",
        detached: true,
      }).unref();
      await waitForTemporalServer(profile.address, 30_000);
      console.error(formatSuccess("Temporal server ready."));
    }
  }

  let client;
  try {
    ({ client } = await makeTemporalClient(ctx.args.profile, projectPath));
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  // Register the search attributes the generated component workflow upserts
  // (ComponentName/Phase) on the autoStart dev server (mirrors runOpTemporal).
  if (profile.autoStart) {
    await ensureSearchAttributes(client, profile.namespace, ["ComponentName", "Phase"]);
  }

  const profileName = ctx.args.profile ??
    (((chantConfig as Record<string, unknown>).temporal as Record<string, unknown> | undefined)?.defaultProfile as string | undefined) ??
    "local";

  console.error(formatInfo(`Spawning worker for component "${component.name}" (profile: ${profileName})...`));
  const workerProcess: ChildProcess = spawnChild("npx", ["tsx", workerPath], {
    cwd: projectPath,
    env: { ...process.env, TEMPORAL_PROFILE: profileName },
    stdio: ["ignore", "ignore", "inherit"],
  });

  const workflowId = componentWorkflowId(component.name);
  const fnName = codegen.componentWorkflowFnName(component.name);
  const taskQueue = profile.taskQueue ?? component.name;

  let handle: WorkflowHandleRaw;
  try {
    handle = await client.workflow.start(fnName, {
      taskQueue,
      workflowId,
      workflowIdConflictPolicy: "FAIL",
    });
    console.error(formatSuccess(`Workflow started: ${workflowId}`));
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    try { workerProcess.kill(); } catch { /* ignore */ }
    return 1;
  }

  const gate = findComponentGate(component);
  if (gate) {
    console.error(formatInfo(
      `Component has a gate ("${gate.signalName}") — unblock it with: chant run signal ${component.name} ${gate.signalName} --components --temporal`,
    ));
  }

  let finalDesc: WorkflowExecutionDescription | undefined;

  try {
    while (true) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const desc = await handle.describe();
      const history = await handle.fetchHistory();
      renderProgress(component.name, history);
      if (TERMINAL_STATUSES.has(desc.status.name)) {
        process.stderr.write("\n");
        finalDesc = desc;
        break;
      }
    }
  } catch (err) {
    process.stderr.write("\n");
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  } finally {
    try { workerProcess.kill(); } catch { /* ignore */ }
  }

  if (!finalDesc) return 1;

  const status = finalDesc.status.name;
  console.error(status === "COMPLETED"
    ? formatSuccess(`Component "${component.name}" completed successfully.`)
    : formatError({ message: `Component "${component.name}" ended with status: ${status}` }),
  );

  if (status === "COMPLETED") {
    // (#597) Auto-emit a release record post-run — never inside the generated
    // workflow (determinism). The workflow returns its final phaseOutputs
    // (see serializeComponent's codegen) precisely so this read is possible;
    // handle.result() on an already-COMPLETED workflow is a plain historical
    // read, not a new activity/side effect.
    let digest: string | undefined;
    let manifest: ReturnType<typeof extractRunManifestFromPhaseOutputs>;
    try {
      const workflowResult = await handle.result() as { phaseOutputs?: Record<string, Record<string, unknown>> } | undefined;
      digest = extractRunDigestFromPhaseOutputs(workflowResult?.phaseOutputs);
      manifest = extractRunManifestFromPhaseOutputs(workflowResult?.phaseOutputs);
    } catch {
      digest = undefined;
      manifest = undefined;
    }

    const { config } = await loadChantConfig(projectPath).catch(() => ({ config: {} }));
    const disabled = resolveAutoReleaseDisabled(config, ctx.args.noReleaseRecord);
    const env = ctx.args.env ?? "local";
    const outcome = await maybeRecordAutoRelease(
      { component: component.name, env, success: true, digest, runId: finalDesc.runId },
      { disabled },
    );
    if (!outcome.recorded && outcome.reason === "error") {
      console.error(formatWarning({ message: `release record for "${component.name}"@${env} was not recorded: ${outcome.error}` }));
    } else if (outcome.recorded) {
      console.error(formatInfo(
        `Recorded release: ${formatBold(component.name)}@${env} -> ${outcome.record.digest} (commit ${outcome.commit.slice(0, 7)})`,
      ));
    }

    // (#609) Persist the run's build manifest post-run, same opt-out flag as
    // the release record above — see ../../components/manifest-persistence.ts.
    const manifestOutcome = await maybePersistBuildManifest({ success: true, manifest }, { disabled });
    if (!manifestOutcome.persisted && manifestOutcome.reason === "error") {
      console.error(formatWarning({ message: `build manifest for "${component.name}"@${env} was not persisted: ${manifestOutcome.error}` }));
    } else if (manifestOutcome.persisted) {
      console.error(formatInfo(
        `Persisted build manifest: ${formatBold(component.name)} -> ${manifestOutcome.manifestDigest} (commit ${manifestOutcome.commit.slice(0, 7)})`,
      ));
    }
  }

  return status === "COMPLETED" ? 0 : 1;
}

/**
 * Run an Op in-process via the local executor — no Temporal worker, server, or
 * built `worker.ts`. Reads the Op config straight from discovery and resolves
 * activities from the Temporal lexicon package.
 */
export async function runOpLocal(ctx: CommandContext): Promise<number> {
  const opName = ctx.args.path;
  if (!opName || opName === ".") {
    console.error(formatError({
      message: "Op name is required: chant run <name>",
      hint: "Run `chant run list --temporal` to see available Ops",
    }));
    return 1;
  }

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

  // Pre-flight: gates/schedules need a durable runtime — fail before any step.
  const gate = findGate(config);
  if (gate) {
    console.error(formatError({
      message: new LocalGateUnsupportedError(gate.signalName).message,
    }));
    return 1;
  }

  // The project's configured lexicons decide which cloud appliers to load
  // (aws → floci, gcp → gcpApply, azure → az group). Best-effort: an unreadable
  // config just yields the temporal base activities.
  let lexicons: string[] = [];
  try {
    lexicons = (await loadChantConfig(process.cwd())).config.lexicons ?? [];
  } catch {
    // No/invalid chant.config — fall back to base activities only.
  }

  let activities, profiles;
  try {
    [activities, profiles] = await Promise.all([loadActivities(lexicons), loadProfiles()]);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  // Ctrl-C aborts in-flight activities (kills their child processes) instead of
  // orphaning them. The handler is removed in `finally` so it never leaks.
  const controller = new AbortController();
  const onSigint = () => {
    console.error(formatWarning({ message: "interrupted — stopping Op" }));
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    const result = await runOpLocally(config, activities, profiles, controller.signal);
    if (ctx.args.json) renderJson(result); else renderHuman(result);
    return 0;
  } catch (err) {
    if (err instanceof OpRunFailure) {
      if (ctx.args.json) renderJson(err.result); else renderHuman(err.result);
      return 1;
    }
    if (err instanceof LocalGateUnsupportedError) {
      console.error(formatError({ message: err.message }));
      return 1;
    }
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function runOpTemporal(ctx: CommandContext): Promise<number> {
  const opName = ctx.args.path;

  if (!opName || opName === ".") {
    console.error(formatError({
      message: "Op name is required: chant run <name>",
      hint: "Run `chant run list` to see available Ops",
    }));
    return 1;
  }

  // Discover Ops
  const { ops, errors } = await discoverOps();
  for (const err of errors) console.error(formatWarning({ message: err }));

  const discovered = ops.get(opName);
  if (!discovered) {
    const names = [...ops.keys()];
    console.error(formatError({
      message: `Op "${opName}" not found`,
      hint: names.length > 0
        ? `Available: ${names.join(", ")}`
        : "No *.op.ts files found — create one or run `chant run list`",
    }));
    return 1;
  }

  const { config } = discovered;
  const projectPath = resolve(".");

  // Load config + profile
  const { config: chantConfig } = await loadChantConfig(projectPath);
  let profile;
  try {
    profile = resolveProfile(chantConfig as Record<string, unknown>, ctx.args.profile);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  // Handle --report flag: just print the last run report
  if (ctx.args.report) {
    let client, desc: WorkflowExecutionDescription, history: WorkflowHistoryRaw;
    try {
      ({ client } = await makeTemporalClient(ctx.args.profile, projectPath));
      const handle = client.workflow.getHandle(resolveWorkflowId(opName));
      desc = await handle.describe();
      history = await handle.fetchHistory();
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
    const md = generateReport(opName, config, desc, history);
    process.stdout.write(md);
    return 0;
  }

  // Check built worker exists
  const workerPath = join(projectPath, "dist", "ops", opName, "worker.ts");
  if (!existsSync(workerPath)) {
    console.error(formatError({
      message: `dist/ops/${opName}/worker.ts not found`,
      hint: "Run `chant build` first to generate the worker",
    }));
    return 1;
  }

  // autoStart: spin up temporal server if needed
  if (profile.autoStart) {
    console.error(formatInfo("autoStart: checking Temporal server..."));
    try {
      await waitForTemporalServer(profile.address, 2000);
      console.error(formatInfo("Temporal server already running."));
    } catch {
      console.error(formatInfo("Starting temporal server start-dev..."));
      spawnChild("temporal", ["server", "start-dev"], {
        cwd: projectPath,
        stdio: "ignore",
        detached: true,
      }).unref();
      await waitForTemporalServer(profile.address, 30_000);
      console.error(formatSuccess("Temporal server ready."));
    }
  }

  // Load Temporal client
  let client;
  try {
    ({ client } = await makeTemporalClient(ctx.args.profile, projectPath));
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  // On the autoStart dev server, register the search attributes the generated
  // workflow upserts (OpName/Phase + any op-declared) so the first workflow task
  // does not fail with BadSearchAttributes.
  if (profile.autoStart) {
    await ensureSearchAttributes(client, profile.namespace, [
      "OpName",
      "Phase",
      ...Object.keys((config as { searchAttributes?: Record<string, string> }).searchAttributes ?? {}),
    ]);
  }

  // Spawn worker process
  const profileName = ctx.args.profile ??
    (((chantConfig as Record<string, unknown>).temporal as Record<string, unknown> | undefined)?.defaultProfile as string | undefined) ??
    "local";

  console.error(formatInfo(`Spawning worker for Op "${opName}" (profile: ${profileName})...`));
  const workerProcess: ChildProcess = spawnChild("npx", ["tsx", workerPath], {
    cwd: projectPath,
    env: { ...process.env, TEMPORAL_PROFILE: profileName },
    stdio: ["ignore", "ignore", "inherit"],
  });

  // Submit workflow
  const workflowId = resolveWorkflowId(opName);
  const fnName = workflowFnName(opName);
  const taskQueue = profile.taskQueue ?? opName;

  let handle: WorkflowHandleRaw;
  try {
    handle = await client.workflow.start(fnName, {
      taskQueue,
      workflowId,
      workflowIdConflictPolicy: "FAIL",
    });
    console.error(formatSuccess(`Workflow started: ${workflowId}`));
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  // Poll for progress until terminal state
  let finalDesc: WorkflowExecutionDescription | undefined;
  let finalHistory: WorkflowHistoryRaw | undefined;

  try {
    while (true) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const desc = await handle.describe();
      const history = await handle.fetchHistory();

      renderProgress(opName, history);

      if (TERMINAL_STATUSES.has(desc.status.name)) {
        process.stderr.write("\n");
        finalDesc = desc;
        finalHistory = history;
        break;
      }
    }
  } catch (err) {
    process.stderr.write("\n");
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  } finally {
    // Kill worker process (best-effort)
    try { workerProcess.kill(); } catch { /* ignore */ }
  }

  if (!finalDesc || !finalHistory) return 1;

  const status = finalDesc.status.name;
  console.error(status === "COMPLETED"
    ? formatSuccess(`Op "${opName}" completed successfully.`)
    : formatError({ message: `Op "${opName}" ended with status: ${status}` }),
  );

  // Write deployment report
  const md = generateReport(opName, config, finalDesc, finalHistory);
  const reportPath = writeReport(opName, md);
  console.error(formatInfo(`Report written to ${reportPath}`));

  return status === "COMPLETED" ? 0 : 1;
}

// ── fallback ────────────────────────────────────────────────────────────────���─

export function runOpUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown run subcommand: ${ctx.args.extraPositional ?? ctx.args.path}`,
    hint: "Available: chant run <name>, run list, run status, run signal, run cancel, run log",
  }));
  return Promise.resolve(1);
}
