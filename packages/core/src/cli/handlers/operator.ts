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
import { appendGateResolution, readGateResolutions, latestResolutionSince } from "../../lifecycle/gate-ledger";
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
  pendingGates: { rule: string; op?: string; gate: string }[];
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
      if (!resolved) pendingGates.push({ rule: outcome.ruleId, op: outcome.op, gate: outcome.gateName });
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
      }
    }
    console.log("");
  }

  return 0;
}

// ── chant approve <op> <gate> ───────────────────────────────────────────────

/**
 * `chant approve <op> <gate> [--actor <name>] [--note <text>]` — record the
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

  const { record } = await appendGateResolution({
    op: opName,
    gate,
    resolvedBy,
    timestamp: new Date().toISOString(),
    ...(ctx.args.note ? { note: ctx.args.note } : {}),
  });
  await pushLifecycle().catch(() => undefined);

  console.error(formatSuccess(
    `Gate "${gate}" on "${opName}" resolved by ${record.resolvedBy} at ${record.timestamp}`,
  ));
  console.error(formatInfo(
    "This records the resolution as a fact; it does not itself re-run the gated dispatch — " +
      "the local executor still refuses any op with a gate. Re-run it with --temporal, or via the PR that carries the change.",
  ));
  return 0;
}
