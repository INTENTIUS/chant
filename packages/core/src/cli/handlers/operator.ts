/**
 * `chant operator` / `chant operator status` / `chant approve` (#1485,
 * epic #1487) — the CLI surface for the native durable-tick operator. See
 * `../../op/operator.ts` for the loop itself; this module is the thin CLI
 * shell around it (discover, load activities, print), mirroring
 * `run.ts`'s `runOpLocal` shape (SIGINT → AbortController, `loadActivities`/
 * `loadProfiles` from the project's configured lexicons).
 */
import { loadChantConfig } from "../../config";
import { discoverOps } from "../../op/discover";
import { loadActivities, loadProfiles } from "../../op/activity-registry";
import { parseDuration } from "../../op/local-executor";
import {
  discoverConvergeOps,
  runOperatorRound,
  runOperatorForever,
  formatRoundLine,
  DEFAULT_OPERATOR_INTERVAL_MS,
  type OperatorTickEvent,
} from "../../op/operator";
import { readLease, DEFAULT_LEASE_TTL_MS } from "../../lifecycle/lease";
import { readConvergeLedger, type ConvergeTickRecord } from "../../lifecycle/converge-ledger";
import type { GateResolutionRecord } from "../../lifecycle/gate-ledger";
import { appendGateResolution, readGateResolutions, latestResolutionSince, resolveApprovalUrl, isApprovalUrl } from "../../lifecycle/gate-ledger";
import { pushLifecycle } from "../../lifecycle/git";
import { formatError, formatWarning, formatSuccess, formatBold, formatInfo } from "../format";
import type { CommandContext } from "../registry";

/** Load the activities a local tick needs, the same way `runOpLocal` does: base temporal activities plus whatever the project's configured lexicons contribute. Best-effort on the lexicon list — an unreadable `chant.config.ts` falls back to base activities only. */
async function loadOperatorActivities() {
  let lexicons: string[] = [];
  try {
    lexicons = (await loadChantConfig(process.cwd())).config.lexicons ?? [];
  } catch {
    // No/invalid chant.config — fall back to base activities only.
  }
  return Promise.all([loadActivities(lexicons), loadProfiles()]);
}

// ── chant operator ──────────────────────────────────────────────────────────

/**
 * `chant operator [--env <env>] [--interval <duration>] [--lease-ttl
 * <duration>] [--once]` — run scheduled ticks for this project's discovered
 * ConvergeOps, locally, with no Temporal installed (issue's own worked
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
    await runOperatorForever({
      env: ctx.args.env,
      intervalMs,
      leaseTtlMs,
      activities,
      profiles,
      signal: controller.signal,
      onRound: printRound,
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
  /** `url` (#2028) is the gate's approval surface, when the tick that recorded it knew one — what a renderer points its approve affordance at instead of a shell command. */
  pendingGates: { rule: string; op?: string; gate: string; url?: string }[];
  lease?: { holder: string; expiresAt: string };
}

async function statusFor(opName: string, env: string, cwd?: string): Promise<OpStatusLine> {
  const [{ records }, { record: lease }] = await Promise.all([
    readConvergeLedger(env, { cwd }),
    readLease(opName, { cwd }),
  ]);
  const ownRecords = records.filter((r) => r.op === opName);
  const lastTick = ownRecords.at(-1);

  const pendingGates: OpStatusLine["pendingGates"] = [];
  if (lastTick) {
    for (const outcome of lastTick.outcomes) {
      if (outcome.action !== "gated" || !outcome.gateName || !outcome.op) continue;
      const { records: resolutions } = await readGateResolutions(outcome.op, { cwd });
      const resolved = latestResolutionSince(resolutions, outcome.gateName, lastTick.timestamp);
      if (!resolved) {
        pendingGates.push({
          rule: outcome.ruleId,
          op: outcome.op,
          gate: outcome.gateName,
          ...(outcome.url ? { url: outcome.url } : {}),
        });
      }
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

/**
 * `chant operator status [--env <env>] [--json]` — last tick, outcome
 * counts, and pending gates, read from the `chant/lifecycle` orphan branch
 * alone (issue acceptance criterion). No live query, no daemon needs to be
 * running: everything here was already durably recorded by whichever
 * process (this operator, a bare `chant run <op>`, or another machine's
 * operator) ran the last tick.
 */
export async function runOperatorStatus(ctx: CommandContext): Promise<number> {
  const { ops, errors } = await discoverConvergeOps({ env: ctx.args.env });
  for (const err of errors) console.error(formatWarning({ message: err }));

  if (ops.length === 0) {
    console.error(formatWarning({ message: "No ConvergeOp declarations found" }));
    return 0;
  }

  const rows = await Promise.all(
    ops.map((d) => statusFor(d.config.name, d.config.searchAttributes?.Env ?? "unknown")),
  );

  if (ctx.args.json) {
    console.log(JSON.stringify(rows, null, 2));
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
        console.log(`    - ${g.op ?? row.op} gate "${g.gate}" (rule ${g.rule}) — resolve: chant approve ${g.op ?? row.op} ${g.gate}`);
        if (g.url) console.log(`      approve at: ${g.url}`);
      }
    }
    console.log("");
  }

  return 0;
}

// ── chant operator log ──────────────────────────────────────────────────────

/** One entry of the merged tick/gate timeline `chant operator log` prints. */
export type OperatorLogEntry =
  | { kind: "tick"; timestamp: string; record: ConvergeTickRecord }
  | { kind: "gate-resolution"; timestamp: string; record: GateResolutionRecord };

export interface OperatorLogResult {
  entries: OperatorLogEntry[];
  /**
   * Unreadable lines behind this answer, per ledger. `readConvergeLedger` and
   * `readGateResolutions` both skip a malformed line and count it rather than
   * throwing, so a corrupted ledger renders a shorter timeline; without this a
   * consumer could not tell that from a genuinely quiet environment.
   */
  malformed: { converge: number; gates: number };
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
  const malformed = { converge: 0, gates: 0 };

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

  let merged = entries.sort((a, b) => {
    const delta = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    // A gate resolution recorded in the same instant as a tick reads after it:
    // the tick is what made the gate pending in the first place.
    return delta !== 0 ? delta : (a.kind === b.kind ? 0 : a.kind === "tick" ? -1 : 1);
  });
  if (sinceMs !== undefined) merged = merged.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
  if (opts.limit !== undefined && merged.length > opts.limit) merged = merged.slice(-opts.limit);

  return { entries: merged, malformed };
}

function renderLogEntry(entry: OperatorLogEntry): string[] {
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
    ops.map((d) => ({ name: d.config.name, env: d.config.searchAttributes?.Env ?? "unknown" })),
    { op: ctx.args.op, since: ctx.args.since, limit: ctx.args.limit },
  );

  if (ctx.args.json) {
    console.log(JSON.stringify({ entries, malformed }, null, 2));
    return 0;
  }

  const unreadable = malformed.converge + malformed.gates;
  if (unreadable > 0) {
    console.error(formatWarning({
      message: `${unreadable} ledger line(s) were unreadable and are missing from this timeline ` +
        `(converge: ${malformed.converge}, gates: ${malformed.gates})`,
    }));
  }

  if (entries.length === 0) {
    console.error(formatWarning({ message: "No converge ticks recorded yet" }));
    return 0;
  }

  for (const entry of entries) {
    for (const line of renderLogEntry(entry)) console.log(line);
  }
  return 0;
}

// ── chant approve <op> <gate> ───────────────────────────────────────────────

/**
 * `chant approve <op> <gate> [--actor <name>] [--note <text>] [--url <url>]`
 * — record the
 * out-of-band resolution fact for a gate a converge tick recorded as gated
 * (issue: "resolution is an out-of-band act that writes the counterpart
 * fact"). Per the issue's own leaning on open question 3 ("local trust in
 * v1"), this performs no authorization check beyond "you can run `chant
 * approve` locally" — see `../../lifecycle/gate-ledger.ts`'s doc for what
 * this record does and, just as importantly, does not (yet) do: it does
 * not retroactively unblock the gated op's own local dispatch, which the
 * local executor still refuses unconditionally.
 */
export async function runApprove(ctx: CommandContext): Promise<number> {
  const opName = ctx.args.path;
  const gate = ctx.args.extraPositional;
  if (!opName || opName === "." || !gate) {
    console.error(formatError({ message: "Usage: chant approve <op> <gate>" }));
    return 1;
  }

  const { ops } = await discoverOps();
  if (!ops.has(opName)) {
    console.error(formatWarning({
      message: `Op "${opName}" was not found among discovered *.op.ts declarations — recording the resolution anyway`,
    }));
  }

  const resolvedBy = ctx.args.actor ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER ?? "unknown";

  // #2028: the resolution's link is typed. `--url` wins; otherwise, running
  // inside the PR/MR job that carries the change is itself the address, the
  // same env fallback `--actor` uses. `--note` stays free-text prose.
  const url = ctx.args.url ?? resolveApprovalUrl();
  if (url && !isApprovalUrl(url)) {
    console.error(formatError({
      message: `--url must be an absolute http/https URL (got "${url}")`,
      hint: "Pass the PR/MR link, or omit --url and put prose in --note.",
    }));
    return 1;
  }

  const { record } = await appendGateResolution({
    op: opName,
    gate,
    resolvedBy,
    timestamp: new Date().toISOString(),
    ...(ctx.args.note ? { note: ctx.args.note } : {}),
    ...(url ? { url } : {}),
  });
  await pushLifecycle().catch(() => undefined);

  console.error(formatSuccess(
    `Gate "${gate}" on "${opName}" resolved by ${record.resolvedBy} at ${record.timestamp}` +
      (record.url ? ` (${record.url})` : ""),
  ));
  console.error(formatInfo(
    "This records the resolution as a fact; it does not itself re-run the gated dispatch — " +
      "the local executor still refuses any op with a gate. Re-run it with --temporal, or via the PR that carries the change.",
  ));
  return 0;
}
