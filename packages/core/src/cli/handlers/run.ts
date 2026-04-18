import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { loadChantConfig } from "../../config";
import { discoverOps } from "../../op/discover";
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

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function workflowFnName(opName: string): string {
  return kebabToCamel(opName) + "Workflow";
}

export async function makeTemporalClient(profileName: string | undefined, projectPath: string) {
  const { config } = await loadChantConfig(projectPath);
  const profile = resolveProfile(config as Record<string, unknown>, profileName);
  const { Connection, Client } = await loadTemporalClient();
  const connection = await Connection.connect(connectionOptions(profile));
  const client = new Client({ connection, namespace: profile.namespace });
  return { client, profile, config };
}

// ── chant run list ──────────────────────────────────���─────────────────────────

export async function runOpList(ctx: CommandContext): Promise<number> {
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

// ── chant run status <name> ───────────────────────────────────────────────────

export async function runOpStatus(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    console.error(formatError({ message: "Op name is required: chant run status <name>" }));
    return 1;
  }

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

// ── chant run log <name> ──────────────────────────────────────────────────────

export async function runOpLog(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    console.error(formatError({ message: "Op name is required: chant run log <name>" }));
    return 1;
  }

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

// ── chant run signal <name> <signal> ─────────────────────────────────────────

export async function runOpSignal(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  const signalName = ctx.args.extraPositional2;

  if (!name || !signalName) {
    console.error(formatError({ message: "Usage: chant run signal <op-name> <signal-name>" }));
    return 1;
  }

  const projectPath = resolve(".");
  let handle: WorkflowHandleRaw;
  try {
    const { client } = await makeTemporalClient(ctx.args.profile, projectPath);
    handle = client.workflow.getHandle(resolveWorkflowId(name));
    await handle.signal(signalName);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.error(formatSuccess(`Signal "${signalName}" sent to Op "${name}"`));
  return 0;
}

// ── chant run cancel <name> ───────────────────────────────────────────────────

export async function runOpCancel(ctx: CommandContext): Promise<number> {
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
  let handle: WorkflowHandleRaw;
  try {
    const { client } = await makeTemporalClient(ctx.args.profile, projectPath);
    handle = client.workflow.getHandle(resolveWorkflowId(name));
    await handle.cancel();
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  console.error(formatSuccess(`Cancellation requested for Op "${name}"`));
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

export async function runOp(ctx: CommandContext): Promise<number> {
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
