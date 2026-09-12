/**
 * `chant operator` / `chant operator status` / `chant approve` (#1485,
 * epic #1487) — the CLI surface for the native durable-tick operator. See
 * `../../op/operator.ts` for the loop itself; this module is the thin CLI
 * shell around it (discover, load activities, print), mirroring
 * `run.ts`'s `runOpLocal` shape (SIGINT → AbortController, `loadActivities`/
 * `loadProfiles` from the project's configured lexicons).
 */
import { loadChantConfig } from "../../config";
import { build } from "../../build";
import { isResourceDeclarable } from "../../declarable";
import { collectBuildRootContributors, collectChangeSubscribers } from "../plugins";
import { discoverOps } from "../../op/discover";
import { loadActivities, loadProfiles } from "../../op/activity-registry";
import { parseDuration } from "../../op/local-executor";
import {
  discoverConvergeOps,
  runOperatorRound,
  runOperatorForever,
  formatRoundLine,
  formatSignalLine,
  DEFAULT_OPERATOR_INTERVAL_MS,
  type ChangeSubscriber,
  type OperatorSignalEvent,
  type OperatorTickEvent,
} from "../../op/operator";
import { readLease, DEFAULT_LEASE_TTL_MS } from "../../lifecycle/lease";
import { readConvergeLedger, type ConvergeTickRecord } from "../../lifecycle/converge-ledger";
import { readRunLedger } from "../../lifecycle/run-ledger";
import type { OpRunRecord } from "../../op/runtime";
import type { GateResolutionRecord, PendingGateRecord } from "../../lifecycle/gate-ledger";
import {
  appendGateResolution, appendPendingGate, readGateResolutions, readGateLedger,
  latestResolutionSince, latestPendingGate, isPendingGateExpired,
  resolveApprovalUrl, isApprovalUrl,
} from "../../lifecycle/gate-ledger";
import { isPlanDigest } from "../../lifecycle/plan-digest";
import { FAN_OUT_GATE_OP } from "../../op/gate-name";
import { pushLifecycle, requireLifecycleLedger } from "../../lifecycle/git";
import { formatError, formatWarning, formatSuccess, formatBold, formatInfo } from "../format";
import type { CommandContext } from "../registry";

/** Load the activities a local tick needs, the same way a local run does: core's base activities plus whatever the project's configured lexicons contribute. Best-effort on the lexicon list — an unreadable `chant.config.ts` falls back to base activities only. */
async function loadOperatorActivities() {
  let lexicons: string[] = [];
  try {
    lexicons = (await loadChantConfig(process.cwd())).config.lexicons ?? [];
  } catch {
    // No/invalid chant.config — fall back to base activities only.
  }
  return Promise.all([loadActivities(lexicons), loadProfiles()]);
}

/**
 * Bind the change-signal seams (#1981) the daemon will keep subscribed, or an
 * empty list.
 *
 * Three gates, in cost order, so a project that gains nothing from this pays
 * nothing for it:
 *
 * 1. No configured lexicon implements `subscribeChanges`. Return immediately,
 *    without loading config or building anything. This is every project today.
 * 2. No `--env`. A subscription resolves the same cluster binding a read
 *    does, and there is no binding to resolve without an environment. Said out
 *    loud rather than silently skipped, because "why did it not wake" is
 *    otherwise unanswerable.
 * 3. The build that supplies the declared entities failed. Warn and fall back
 *    to the timer. A subscription is an optimization; a build error here must
 *    not stop the operator, which has its own per-tick build inside the tick.
 */
async function collectOperatorSubscribers(
  ctx: CommandContext,
  env: string | undefined,
): Promise<ChangeSubscriber[]> {
  if (!ctx.plugins.some((p) => typeof p.subscribeChanges === "function")) return [];

  if (!env) {
    console.error(formatWarning({
      message: "a change signal needs an environment to resolve its binding, so this runs on the timer alone",
      hint: "pass --env <env> to let a lexicon's subscribeChanges wake a tick early",
    }));
    return [];
  }

  const cwd = process.cwd();
  try {
    const { config } = await loadChantConfig(cwd);
    const buildRoots = collectBuildRootContributors(
      ctx.plugins,
      config as unknown as Record<string, unknown>,
      cwd,
    );
    const buildResult = await build(config.sourceDir ?? ".", ctx.serializers, undefined, { buildRoots });
    if (buildResult.errors.length > 0) {
      console.error(formatWarning({
        message: "build failed while scoping the change signal, so this runs on the timer alone",
      }));
      return [];
    }

    // The declared estate, sliced per lexicon: the same slice
    // `takeSnapshot` hands `describeResources`, and the bound on what any
    // subscription may watch.
    const entities = new Map<string, Map<string, { entityType: string; props: Record<string, unknown> }>>();
    for (const [name, entity] of buildResult.entities) {
      if (!isResourceDeclarable(entity)) continue;
      let perLexicon = entities.get(entity.lexicon);
      if (!perLexicon) entities.set(entity.lexicon, (perLexicon = new Map()));
      perLexicon.set(name, {
        entityType: entity.entityType,
        props: (entity.props != null ? entity.props : {}) as Record<string, unknown>,
      });
    }

    return collectChangeSubscribers(ctx.plugins, { environment: env, cwd, entities });
  } catch (err) {
    console.error(formatWarning({
      message: `could not scope the change signal, so this runs on the timer alone (${err instanceof Error ? err.message : String(err)})`,
    }));
    return [];
  }
}

// ── chant operator ──────────────────────────────────────────────────────────

/**
 * `chant operator [--env <env>] [--interval <duration>] [--lease-ttl
 * <duration>] [--once]` — run scheduled ticks for this project's discovered
 * ConvergeOps, locally, with no service to install (issue's own worked
 * example). `--once` runs a single round and exits (also the offline test
 * story, and what a cron/systemd-timer/k8s-CronJob invoker uses instead of
 * leaving the daemon running); omitted, the daemon loops until Ctrl-C.
 */
export async function runOperator(ctx: CommandContext): Promise<number> {
  const { ops, errors } = await discoverConvergeOps({ env: ctx.args.env });
  for (const err of errors) console.error(formatWarning({ message: err }));

  if (ops.length === 0) {
    console.error(formatWarning({
      message: ctx.args.env
        ? `No ConvergeOp declarations found for env "${ctx.args.env}"`
        : "No ConvergeOp declarations found (*.op.ts built with ConvergeOp(...))",
    }));
    return 0;
  }

  let activities, profiles;
  try {
    [activities, profiles] = await loadOperatorActivities();
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  const intervalMs = ctx.args.interval ? parseDuration(ctx.args.interval) : DEFAULT_OPERATOR_INTERVAL_MS;
  const leaseTtlMs = ctx.args.leaseTtl ? parseDuration(ctx.args.leaseTtl) : DEFAULT_LEASE_TTL_MS;

  const controller = new AbortController();
  const onSigint = () => {
    console.error(formatWarning({ message: "interrupted — stopping operator" }));
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  const printRound = (events: OperatorTickEvent[]) => {
    for (const event of events) console.error(formatInfo(formatRoundLine(event)));
  };

  try {
    if (ctx.args.once) {
      const events = await runOperatorRound({ env: ctx.args.env, leaseTtlMs, activities, profiles, signal: controller.signal });
      printRound(events);
      return events.some((e) => e.kind === "tick-failed") ? 1 : 0;
    }

    console.error(formatInfo(
      `chant operator: watching ${ops.length} ConvergeOp(s) every ${intervalMs}ms (Ctrl-C to stop)`,
    ));
    // A change signal (#1981) only ever shortens the sleep above. Every round
    // it wakes is the round the timer would have run.
    const subscribers = await collectOperatorSubscribers(ctx, ctx.args.env);
    await runOperatorForever({
      env: ctx.args.env,
      intervalMs,
      leaseTtlMs,
      activities,
      profiles,
      signal: controller.signal,
      onRound: printRound,
      subscribers,
      onSignalEvent: (event: OperatorSignalEvent) => console.error(formatInfo(formatSignalLine(event))),
    });
    return 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

// ── chant operator status ───────────────────────────────────────────────────

interface OpStatusLine {
  op: string;
  env: string;
  lastTick?: ConvergeTickRecord;
  /** `url` (#2028) is the gate's approval surface, when whatever recorded it knew one — what a renderer points its approve affordance at instead of a shell command. `rule` is present only for a gate a converge rule's dispatch reached; a gate an ordinary `chant run` stopped at has none. */
  pendingGates: { rule?: string; op?: string; gate: string; url?: string; expiresAt?: string; description?: string }[];
  lease?: { holder: string; expiresAt: string };
}

/**
 * Every gate an op is currently standing at, read from its own gate ledger
 * (#2119) — a live (unexpired) pending fact with no resolution newer than it.
 *
 * Ledger-first, so `chant operator status` sees a gate any run recorded, not
 * only one a converge tick's dispatch reached. Before this, a plain `chant run
 * <op>` could not produce a pending gate at all (the executor refused the op
 * outright), so reading the converge ledger's `gated` outcomes was the whole
 * story; now it is one source among the ops' own.
 */
export async function pendingGatesFor(
  opName: string,
  opts: { cwd?: string; now?: string } = {},
): Promise<PendingGateRecord[]> {
  const now = opts.now ?? new Date().toISOString();
  const { resolutions, pending } = await readGateLedger(opName, { cwd: opts.cwd });
  const standing: PendingGateRecord[] = [];
  for (const gate of new Set(pending.map((p) => p.gate))) {
    const latest = latestPendingGate(pending, gate);
    if (!latest || isPendingGateExpired(latest, now)) continue;
    if (latestResolutionSince(resolutions, gate, latest.timestamp)) continue;
    standing.push(latest);
  }
  return standing.sort((a, b) => a.gate.localeCompare(b.gate));
}

async function statusFor(opName: string, env: string, cwd?: string): Promise<OpStatusLine> {
  const [{ records }, { record: lease }] = await Promise.all([
    readConvergeLedger(env, { cwd }),
    readLease(opName, { cwd }),
  ]);
  const ownRecords = records.filter((r) => r.op === opName);
  const lastTick = ownRecords.at(-1);

  const pendingGates: OpStatusLine["pendingGates"] = [];
  const seen = new Set<string>();

  // The dispatched ops this ConvergeOp's last tick recorded as gated, plus the
  // ConvergeOp itself — a gate can sit on either.
  const gateOps = new Set<string>([opName]);
  const ruleFor = new Map<string, string>();
  for (const outcome of lastTick?.outcomes ?? []) {
    if (outcome.action !== "gated" || !outcome.gateName || !outcome.op) continue;
    gateOps.add(outcome.op);
    ruleFor.set(`${outcome.op}\0${outcome.gateName}`, outcome.ruleId);
  }

  for (const gateOp of [...gateOps].sort()) {
    for (const record of await pendingGatesFor(gateOp, { cwd })) {
      seen.add(`${gateOp}\0${record.gate}`);
      pendingGates.push({
        op: gateOp,
        gate: record.gate,
        expiresAt: record.expiresAt,
        ...(ruleFor.get(`${gateOp}\0${record.gate}`) ? { rule: ruleFor.get(`${gateOp}\0${record.gate}`) } : {}),
        ...(record.description ? { description: record.description } : {}),
        ...(record.url ? { url: record.url } : {}),
      });
    }
  }

  // A tick that recorded a `gated` outcome before the executor started writing
  // pending facts (#2119) still has nothing in `_gates` to read; fall back to
  // the outcome itself so an in-flight gate isn't dropped on upgrade.
  if (lastTick) {
    for (const outcome of lastTick.outcomes) {
      if (outcome.action !== "gated" || !outcome.gateName || !outcome.op) continue;
      if (seen.has(`${outcome.op}\0${outcome.gateName}`)) continue;
      const { records: resolutions } = await readGateResolutions(outcome.op, { cwd });
      if (latestResolutionSince(resolutions, outcome.gateName, lastTick.timestamp)) continue;
      pendingGates.push({
        rule: outcome.ruleId,
        op: outcome.op,
        gate: outcome.gateName,
        ...(outcome.url ? { url: outcome.url } : {}),
      });
    }
  }

  return {
    op: opName,
    env,
    lastTick,
    pendingGates,
    lease: lease ? { holder: lease.holder, expiresAt: lease.expiresAt } : undefined,
  };
}

/** One op standing at a gate that no ConvergeOp row above already reported (#2119) — an ordinary `chant run <op>` records these now, so they belong on this page even where no converge tick was ever involved. */
export interface StandaloneGateLine {
  op: string;
  gate: string;
  description?: string;
  expiresAt: string;
  url?: string;
}

/**
 * `chant operator status [--env <env>] [--json]` — last tick, outcome
 * counts, and pending gates, read from the `chant/lifecycle` orphan branch
 * alone (issue acceptance criterion). No live query, no daemon needs to be
 * running: everything here was already durably recorded by whichever
 * process (this operator, a bare `chant run <op>`, or another machine's
 * operator) ran the last tick.
 *
 * Pending gates are read from every discovered op's own gate ledger, not only
 * from a converge tick's `gated` outcomes (#2119) — a gate an ordinary `chant
 * run <op>` stopped at is the same standing fact and shows up the same way,
 * under "pending gates" for ops with no converge tick behind them.
 */
export async function runOperatorStatus(ctx: CommandContext): Promise<number> {
  const { ops, errors } = await discoverConvergeOps({ env: ctx.args.env });
  for (const err of errors) console.error(formatWarning({ message: err }));

  const rows = await Promise.all(
    ops.map((d) => statusFor(d.config.name, d.config.labels?.Env ?? "unknown")),
  );

  // Every other discovered op that is standing at a gate. `discoverOps` sees
  // the whole project, so an ApplyOp someone ran by hand this morning is here
  // even though no ConvergeOp ever dispatched it.
  const covered = new Set(rows.flatMap((r) => r.pendingGates.map((g) => `${g.op ?? r.op} ${g.gate}`)));
  const { ops: allOps } = await discoverOps();
  const standalone: StandaloneGateLine[] = [];
  for (const opName of [...allOps.keys()].sort()) {
    for (const record of await pendingGatesFor(opName)) {
      if (covered.has(`${opName} ${record.gate}`)) continue;
      standalone.push({
        op: opName,
        gate: record.gate,
        expiresAt: record.expiresAt,
        ...(record.description ? { description: record.description } : {}),
        ...(record.url ? { url: record.url } : {}),
      });
    }
  }

  if (ops.length === 0 && standalone.length === 0) {
    console.error(formatWarning({ message: "No ConvergeOp declarations found" }));
    return 0;
  }

  if (ctx.args.json) {
    console.log(JSON.stringify(standalone.length > 0 ? { rows, pendingGates: standalone } : rows, null, 2));
    return 0;
  }

  for (const row of rows) {
    console.log(formatBold(`${row.op} (${row.env})`));
    if (!row.lastTick) {
      console.log("  no ticks recorded yet");
    } else {
      console.log(`  last tick : ${row.lastTick.timestamp}`);
      console.log(`  ${row.lastTick.log}`);
    }
    console.log(`  lease     : ${row.lease ? `held by ${row.lease.holder} (expires ${row.lease.expiresAt})` : "free"}`);
    if (row.pendingGates.length > 0) {
      console.log(`  pending gates:`);
      for (const g of row.pendingGates) {
        const op = g.op ?? row.op;
        console.log(
          `    - ${op} gate "${g.gate}"${g.rule ? ` (rule ${g.rule})` : ""} — resolve: chant approve ${op} ${g.gate}`,
        );
        if (g.expiresAt) console.log(`      expires: ${g.expiresAt}`);
        if (g.url) console.log(`      approve at: ${g.url}`);
      }
    }
    console.log("");
  }

  if (standalone.length > 0) {
    console.log(formatBold("pending gates (no converge tick)"));
    for (const g of standalone) {
      console.log(`  - ${g.op} gate "${g.gate}" — resolve: chant approve ${g.op} ${g.gate}`);
      if (g.description) console.log(`    ${g.description}`);
      console.log(`    expires: ${g.expiresAt}`);
      if (g.url) console.log(`    approve at: ${g.url}`);
    }
    console.log("");
  }

  return 0;
}

// ── chant operator log ──────────────────────────────────────────────────────

/** One entry of the merged tick/gate timeline `chant operator log` prints. */
export type OperatorLogEntry =
  | { kind: "tick"; timestamp: string; record: ConvergeTickRecord }
  | { kind: "gate-resolution"; timestamp: string; record: GateResolutionRecord }
  /** One Op run (#2118), timestamped at the instant it ended — the tick that dispatched it precedes it. */
  | { kind: "run"; timestamp: string; record: OpRunRecord };

export interface OperatorLogResult {
  entries: OperatorLogEntry[];
  /**
   * Unreadable lines behind this answer, per ledger. `readConvergeLedger`,
   * `readGateResolutions` and `readRunLedger` all skip a malformed line and
   * count it rather than throwing, so a corrupted ledger renders a shorter
   * timeline; without this a consumer could not tell that from a genuinely
   * quiet environment.
   */
  malformed: { converge: number; gates: number; runs: number };
}

/**
 * Gather the converge/gate history a set of ConvergeOps has recorded, merged
 * into one timestamp-ordered timeline, oldest first.
 *
 * `since` (inclusive) and `limit` are applied after the merge — `limit` keeps
 * the *newest* n entries, since that is what a log is asked for, and then
 * prints them oldest-first like every other log.
 */
export async function collectOperatorLog(
  ops: { name: string; env: string }[],
  opts: { op?: string; since?: string; limit?: number; cwd?: string } = {},
): Promise<OperatorLogResult> {
  const wanted = opts.op ? ops.filter((o) => o.name === opts.op) : ops;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : undefined;

  const entries: OperatorLogEntry[] = [];
  const malformed = { converge: 0, gates: 0, runs: 0 };

  // One read per distinct environment — several ConvergeOps can share one
  // `<env>/converge.jsonl`, and re-reading it per op would both cost more and
  // double-count its malformed lines.
  const envs = [...new Set(wanted.map((o) => o.env))].sort();
  const opNames = new Set(wanted.map((o) => o.name));
  const gateOps = new Set<string>();

  for (const env of envs) {
    const { records, malformed: bad } = await readConvergeLedger(env, { cwd: opts.cwd });
    malformed.converge += bad;
    for (const record of records) {
      if (!opNames.has(record.op)) continue;
      for (const outcome of record.outcomes) {
        if (outcome.action === "gated" && outcome.op) gateOps.add(outcome.op);
      }
      entries.push({ kind: "tick", timestamp: record.timestamp, record });
    }
  }

  for (const gateOp of [...gateOps].sort()) {
    const { records, malformed: bad } = await readGateResolutions(gateOp, { cwd: opts.cwd });
    malformed.gates += bad;
    for (const record of records) {
      entries.push({ kind: "gate-resolution", timestamp: record.timestamp, record });
    }
  }

  // The runs each discovered Op recorded (#2118). Keyed `<env>/runs__<op>`,
  // so unlike the converge ledger this is one read per (env, op) pair rather
  // than per env — a ConvergeOp's own ticks and its own runs interleave here.
  for (const { name, env } of wanted) {
    const { records, malformed: bad } = await readRunLedger(env, name, { cwd: opts.cwd });
    malformed.runs += bad;
    for (const record of records) {
      entries.push({ kind: "run", timestamp: record.ended, record });
    }
  }

  // Within one instant: the tick first (it is what dispatched anything else),
  // then the run it dispatched, then the gate resolution against that run.
  const rank: Record<OperatorLogEntry["kind"], number> = { tick: 0, run: 1, "gate-resolution": 2 };
  let merged = entries.sort((a, b) => {
    const delta = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    return delta !== 0 ? delta : rank[a.kind] - rank[b.kind];
  });
  if (sinceMs !== undefined) merged = merged.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
  if (opts.limit !== undefined && merged.length > opts.limit) merged = merged.slice(-opts.limit);

  return { entries: merged, malformed };
}

function renderLogEntry(entry: OperatorLogEntry): string[] {
  if (entry.kind === "run") {
    const { record } = entry;
    const id = `[${record.id.slice(0, 8)}]`;
    const outcomes = Object.entries(record.outcomes).map(([k, v]) => `${k}=${String(v)}`).join(" ");
    const steps = record.phases.reduce((n, p) => n + p.steps.length, 0);
    return [
      `${record.ended}  ${record.op}@${record.env}  ${id}  run ${record.status} ` +
        `phases=${record.phases.length} steps=${steps}${outcomes ? `  ${outcomes}` : ""}`,
    ];
  }

  if (entry.kind === "gate-resolution") {
    const { record } = entry;
    return [
      `${record.timestamp}  gate-resolved  ${record.op}/${record.gate} by ${record.resolvedBy}` +
        (record.url ? `  ${record.url}` : ""),
    ];
  }

  const { record } = entry;
  const id = record.id ? `[${record.id.slice(0, 8)}]` : "[--------]";
  const lines = [`${record.timestamp}  ${record.op}@${record.env}  ${id}  ${record.log}`];
  for (const outcome of record.outcomes) {
    if (outcome.action !== "gated" || !outcome.gateName) continue;
    lines.push(
      `    gated  ${outcome.ruleId} → ${outcome.op ?? "?"} gate "${outcome.gateName}"` +
        (outcome.url ? `  ${outcome.url}` : ""),
    );
  }
  return lines;
}

/**
 * `chant operator log [--env <env>] [--op <name>] [--since <iso>] [--limit
 * <n>] [--json]` (#2029) — the converge tick history and the gate resolutions
 * against it, read from the `chant/lifecycle` orphan branch alone.
 *
 * `readConvergeLedger` has always returned every tick for an environment;
 * until this its only caller was `operator status`, which threw the history
 * away and kept `.at(-1)`. A consumer wanting more than the newest row had to
 * `git show chant/lifecycle:<env>/converge.jsonl` and parse it — which pins it
 * to the orphan branch's name, the `<env>/converge.jsonl` path convention, the
 * `_gates/<op>.jsonl` convention and the on-disk encoding, none of which are
 * promised contracts. This is the read surface that makes those private again.
 *
 * Read-only: no lease, no dispatch, no daemon. Same `--json` discipline as
 * `operator status` — one JSON document on stdout, diagnostics on stderr.
 */
export async function runOperatorLog(ctx: CommandContext): Promise<number> {
  const { ops, errors } = await discoverConvergeOps({ env: ctx.args.env });
  for (const err of errors) console.error(formatWarning({ message: err }));

  if (ops.length === 0) {
    console.error(formatWarning({ message: "No ConvergeOp declarations found" }));
    return 0;
  }

  if (ctx.args.since && Number.isNaN(new Date(ctx.args.since).getTime())) {
    console.error(formatError({
      message: `--since must be an ISO-8601 timestamp (got "${ctx.args.since}")`,
      hint: "e.g. --since 2026-01-01T00:00:00Z",
    }));
    return 1;
  }
  if (ctx.args.limit !== undefined && (!Number.isInteger(ctx.args.limit) || ctx.args.limit < 1)) {
    console.error(formatError({ message: `--limit must be a positive integer (got "${ctx.args.limit}")` }));
    return 1;
  }

  const { entries, malformed } = await collectOperatorLog(
    ops.map((d) => ({ name: d.config.name, env: d.config.labels?.Env ?? "unknown" })),
    { op: ctx.args.op, since: ctx.args.since, limit: ctx.args.limit },
  );

  if (ctx.args.json) {
    console.log(JSON.stringify({ entries, malformed }, null, 2));
    return 0;
  }

  const unreadable = malformed.converge + malformed.gates + malformed.runs;
  if (unreadable > 0) {
    console.error(formatWarning({
      message: `${unreadable} ledger line(s) were unreadable and are missing from this timeline ` +
        `(converge: ${malformed.converge}, gates: ${malformed.gates}, runs: ${malformed.runs})`,
    }));
  }

  if (entries.length === 0) {
    console.error(formatWarning({ message: "No converge ticks or Op runs recorded yet" }));
    return 0;
  }

  for (const entry of entries) {
    for (const line of renderLogEntry(entry)) console.log(line);
  }
  return 0;
}

// ── chant approve <op> <gate> ───────────────────────────────────────────────

/**
 * `chant approve <op> <gate> [--actor <name>] [--note <text>] [--url <url>]
 * [--expire]` — record the out-of-band resolution fact for a gate a run
 * stopped at (issue #1485: "resolution is an out-of-band act that writes the
 * counterpart fact"). Per that issue's leaning on open question 3 ("local
 * trust in v1"), this performs no authorization check beyond "you can run
 * `chant approve` locally".
 *
 * Since #2119 this closes the loop rather than just narrating it: the next
 * `chant run <op>` reads the resolution, finds it newer than the gate's
 * pending fact, and walks through.
 *
 * `--expire` is the other half — clear a standing pending fact *without*
 * approving anything, for a gate that was recorded against a run nobody
 * intends to finish. It writes no resolution; it appends a pending fact that
 * is already expired, which supersedes the standing one on an append-only
 * ledger, so the next run decides the gate from scratch.
 */
/** The ledger branch, named in the warnings below so a reader can go look at it. */
const LIFECYCLE_BRANCH = "chant/lifecycle";

/**
 * Push the ledger and say so when it does not land (#2309 review, refs #2310).
 *
 * Both write paths here used `pushLifecycle().catch(() => undefined)` and then
 * printed unconditional success and exited 0. A rejected push — a stale lease,
 * no credentials, no network — therefore read as a completed approval, which
 * is the one thing an approval must never do: the operator walks away
 * believing the gate is answered for everybody, while the resolution exists
 * only in their own checkout.
 *
 * The append is still a correct *local* fact, so this is a warning and not a
 * failure; the exit code is unchanged.
 */
async function reportedPush(consequence: string): Promise<boolean> {
  try {
    const pushed = await pushLifecycle();
    if (pushed) return true;
    console.error(formatWarning({
      message: `No remote is configured, so nothing was pushed. ${consequence}`,
    }));
    return false;
  } catch (err) {
    console.error(formatWarning({
      message: `The push to the remote was rejected: ${err instanceof Error ? err.message : String(err)}`,
      hint: consequence,
    }));
    return false;
  }
}

export async function runApprove(ctx: CommandContext): Promise<number> {
  const opName = ctx.args.path;
  const gate = ctx.args.extraPositional;
  if (!opName || opName === "." || !gate) {
    console.error(formatError({ message: "Usage: chant approve <op> <gate>" }));
    return 1;
  }

  if (ctx.args.expire) {
    // Same guard as the approve path below (#2303): `--expire` reads the
    // standing fact and appends beside it, so a clone that never fetched the
    // branch would both fail to see the fact it is expiring and replace the
    // branch with the expiry alone.
    try {
      await requireLifecycleLedger();
    } catch (err) {
      console.error(formatError({
        message: `Cannot expire the gate: ${err instanceof Error ? err.message : String(err)}`,
      }));
      return 1;
    }
    const now = new Date().toISOString();
    const standing = latestPendingGate((await readGateLedger(opName)).pending, gate);
    if (!standing || isPendingGateExpired(standing, now)) {
      console.error(formatWarning({
        message: `Gate "${gate}" on "${opName}" has no standing pending fact — nothing to expire`,
      }));
      return 0;
    }
    await appendPendingGate({
      op: opName,
      gate,
      timestamp: now,
      expiresAt: now,
      ...(standing.description ? { description: standing.description } : {}),
    });
    const pushed = await reportedPush(
      `The expiry is recorded locally on ${LIFECYCLE_BRANCH}. Until it reaches the remote, ` +
        `a run in another checkout still sees the old pending fact.`,
    );
    console.error(formatSuccess(
      `Gate "${gate}" on "${opName}" expired at ${now} — not approved` +
        (pushed ? "" : " (local only — the push did not land)"),
    ));
    console.error(formatInfo(
      opName === FAN_OUT_GATE_OP
        ? `The next \`chant components fan-out\` decides this gate from scratch and records a fresh pending fact.`
        : `The next \`chant run ${opName}\` decides this gate from scratch and records a fresh pending fact.`,
    ));
    return 0;
  }

  // `--approver` wins over `--actor`, the same precedence `chant run approve`
  // has applied since #2126 (`../handlers/run.ts`'s `runOpApprove`). Reading
  // only `--actor` here meant every README that teaches `--approver you`
  // recorded the shell user instead (#2192).
  const outcome = await recordGateApproval(opName, gate, {
    actor: ctx.args.approver ?? ctx.args.actor,
    note: ctx.args.note,
    url: ctx.args.url,
    plan: ctx.args.plan,
  });
  if (!outcome.ok) return 1;

  console.error(formatInfo(
    `This records the resolution as a fact; it does not itself re-run anything. ` +
      (opName === FAN_OUT_GATE_OP
        ? `Repeat the \`chant components fan-out\` command and it walks through gate "${gate}".`
        : `Run \`chant run ${opName}\` and it walks through gate "${gate}".`),
  ));
  return 0;
}

/** What a caller supplies alongside the op and gate names. */
export interface GateApprovalOptions {
  /** `--actor`/`--approver`; falls back to the CI or shell identity. */
  actor?: string;
  /** `--note` — free-text prose. */
  note?: string;
  /** `--url` — the approval surface, validated as absolute http/https. */
  url?: string;
  /**
   * `--plan <digest>` (#2300) — the plan this approval is for. Omitted, the
   * digest is read off the gate's standing pending fact, so the common path
   * stays one command: run, read what it planned, approve it.
   */
  plan?: string;
}

export type GateApprovalOutcome =
  | { ok: true; record: GateResolutionRecord }
  | { ok: false };

/**
 * The ledger write behind `chant approve` — extracted so `chant run approve`
 * (#2121) records the identical fact before waking the runtime that hosts the
 * gated run, instead of growing a second, drifting writer.
 *
 * Prints the same warning for an undiscovered op and the same success line as
 * `chant approve` always did; the caller adds whatever it does next.
 *
 * Since #2300 the resolution names the plan it approves. By default that is
 * the standing pending fact's plan — the one the gated run produced — so the
 * common path is still `chant run`, read, `chant approve`. With no pending
 * fact and no `--plan`, this refuses: there is nothing on the ledger saying
 * what would be approved, and writing a resolution anyway is what made an
 * approval mean "the next run" instead of "this plan".
 */
export async function recordGateApproval(
  opName: string,
  gate: string,
  opts: GateApprovalOptions,
): Promise<GateApprovalOutcome> {
  const { ops } = await discoverOps();
  // `fan-out` is the op name every `chant components fan-out` gate is recorded
  // under (../handlers/fan-out.ts). It is a command rather than a declaration,
  // so there is no `*.op.ts` to find and nothing is wrong when none is there.
  if (!ops.has(opName) && opName !== FAN_OUT_GATE_OP) {
    console.error(formatWarning({
      message: `Op "${opName}" was not found among discovered *.op.ts declarations — recording the resolution anyway`,
    }));
  }

  // Read the branch before appending to it (#2303 finding 2). Without this,
  // an approve in a clone that never fetched `chant/lifecycle` builds its
  // commit from an empty tree with no parent and replaces the branch with a
  // single commit holding only this resolution — the pending fact it is
  // answering is discarded rather than appended to.
  try {
    await requireLifecycleLedger();
  } catch (err) {
    console.error(formatError({
      message: `Cannot record the approval: ${err instanceof Error ? err.message : String(err)}`,
      hint: "The pending fact this answers lives on that branch; appending without it would drop it.",
    }));
    return { ok: false };
  }

  // #2028: the resolution's link is typed. `--url` wins; otherwise, running
  // inside the PR/MR job that carries the change is itself the address, the
  // same env fallback `--actor` uses. `--note` stays free-text prose.
  const url = opts.url ?? resolveApprovalUrl();
  if (url && !isApprovalUrl(url)) {
    console.error(formatError({
      message: `--url must be an absolute http/https URL (got "${url}")`,
      hint: "Pass the PR/MR link, or omit --url and put prose in --note.",
    }));
    return { ok: false };
  }

  // #2300: an approval is for a plan, so this command has to know which one.
  // `--plan` names it outright; otherwise it comes off the gate's standing
  // pending fact — the plan the run that stopped at this gate produced, which
  // is the plan whoever is typing this just read. There is deliberately no
  // third fallback: approving with no plan in sight is the behaviour
  // INTENTIUS/choudoufu#1026 measured, where the resolution authorised the
  // next run rather than anything anyone had seen.
  let planDigest: string | undefined;
  if (opts.plan !== undefined) {
    if (!isPlanDigest(opts.plan)) {
      console.error(formatError({
        message: `--plan must be a plan digest ("sha256:" and 64 hex characters), got "${opts.plan}"`,
        hint: "Copy it from the gated run's `plan :` line, or from the pending-gate summary. It is not a plan file path.",
      }));
      return { ok: false };
    }
    planDigest = opts.plan;
  } else {
    const standing = latestPendingGate((await readGateLedger(opName)).pending, gate);
    if (!standing) {
      console.error(formatError({
        message: `Gate "${gate}" on "${opName}" has no pending fact, so there is no plan to approve`,
        hint:
          `Run \`chant run ${opName}\` first — it plans, stops at the gate, and records the plan this ` +
          `approval would be for. To approve a plan you already have the digest for, pass ` +
          `\`--plan <digest>\`.`,
      }));
      return { ok: false };
    }
    planDigest = standing.planDigest;
  }

  const resolvedBy = opts.actor ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER ?? "unknown";

  const { record } = await appendGateResolution({
    op: opName,
    gate,
    resolvedBy,
    timestamp: new Date().toISOString(),
    ...(opts.note ? { note: opts.note } : {}),
    ...(url ? { url } : {}),
    ...(planDigest !== undefined ? { planDigest } : {}),
  });
  const pushed = await reportedPush(
    `The resolution is recorded locally on ${LIFECYCLE_BRANCH}. Until it reaches the remote, ` +
      `a run in another checkout will not see it.`,
  );

  console.error(formatSuccess(
    `Gate "${gate}" on "${opName}" resolved by ${record.resolvedBy} at ${record.timestamp}` +
      (record.url ? ` (${record.url})` : "") +
      (pushed ? "" : " (local only — the push did not land)"),
  ));
  if (record.planDigest) {
    console.error(formatInfo(
      `This approves the plan ${record.planDigest}, and only that plan. A run whose fresh plan ` +
        "differs refuses rather than applying it.",
    ));
  }
  return { ok: true, record };
}
