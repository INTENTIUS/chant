/**
 * `chant operator` / `chant operator status` / `chant approve` (#1485,
 * epic #1487) — the CLI surface for the native durable-tick operator. See
 * `../../op/operator.ts` for the loop itself; this module is the thin CLI
 * shell around it (discover, load activities, print), mirroring
 * `run.ts`'s `runOpLocal` shape (SIGINT → AbortController, `loadActivities`/
 * `loadProfiles` from the project's configured lexicons).
 */
import { lexiconNames } from "../../lexicon-module";
import { loadChantConfig } from "../../config";
import { build } from "../../build";
import { isObservableDeclarable } from "../../declarable";
import { collectBuildRootContributors, collectChangeSubscribers } from "../plugins";
import { discoverOps, discoverStewards } from "../../op/discover";
import { pickSteward, stewardBesideOf, stewardFormFor, stewardLeaseName, stewardTurnOps, DEFAULT_STEWARD_ENV } from "../../op/steward";
import { loadActivities, loadProfiles } from "../../op/activity-registry";
import { parseDuration } from "../../op/local-executor";
import {
  discoverConvergeOps,
  runOperatorRound,
  runOperatorForever,
  formatRoundLine,
  formatSignalLine,
  DEFAULT_OPERATOR_INTERVAL_MS,
  acquireStewardLease,
  createBesideState,
  waitForBesideRuns,
  type ChangeSubscriber,
  type OperatorSignalEvent,
  type OperatorTickEvent,
} from "../../op/operator";
import { readLease, releaseLease, currentHolderId, DEFAULT_LEASE_TTL_MS } from "../../lifecycle/lease";
import { readConvergeLedger, type ConvergeTickRecord } from "../../lifecycle/converge-ledger";
import { readRunLedger, runEnvOf } from "../../lifecycle/run-ledger";
import type { OpRunRecord } from "../../op/runtime";
import type { GateResolutionRecord, PendingGateRecord } from "../../lifecycle/gate-ledger";
import { readGateResolutions, readGateLedger, latestResolutionSince, latestPendingGate, isPendingGateExpired } from "../../lifecycle/gate-ledger";
import { formatError, formatWarning, formatBold, formatInfo } from "../format";
import type { CommandContext } from "../registry";

/** Load the activities a local tick needs, the same way a local run does: core's base activities plus whatever the project's configured lexicons contribute. Best-effort on the lexicon list — an unreadable `chant.config.ts` falls back to base activities only. */
async function loadOperatorActivities() {
  let lexicons: string[] = [];
  try {
    lexicons = lexiconNames((await loadChantConfig(process.cwd())).config.lexicons ?? []);
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
      if (!isObservableDeclarable(entity)) continue;
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
  if (ctx.args.steward !== undefined) return runStewardOperator(ctx);
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
  // `process.on`, not `.once`: a `.once` listener is gone the instant it
  // fires, so a second SIGINT arriving while shutdown is still in flight
  // (the `finally` below hasn't run yet) has no listener left and takes
  // Node's default disposition — the process ends right there, before
  // whatever the `finally` was going to do. Kept registered for the whole
  // shutdown and only removed once it's actually over; `stopping` makes a
  // repeat signal a no-op rather than a second `abort()`/log line (#2872).
  let stopping = false;
  const onSigint = () => {
    if (stopping) return;
    stopping = true;
    console.error(formatWarning({ message: "interrupted — stopping operator" }));
    controller.abort();
  };
  process.on("SIGINT", onSigint);

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
    // Only when no signal started this shutdown. After one did, the process
    // exits right after this returns, and removing the listener would put
    // SIGINT back to its default disposition for that last stretch: a repeat
    // signal arriving there ends the process by signal instead of the exit
    // code (see the steward's `finally` below).
    if (!stopping) process.removeListener("SIGINT", onSigint);
  }
}

// ── chant operator --steward ────────────────────────────────────────────────

/**
 * `chant operator --steward [<name>] [--env <env>] [--interval] [--lease-ttl]
 * [--once]` (#2731) — a steward's local form. The same Ops the steward runs on
 * Fountain, on the same crons, one at a time, each under its operator lease,
 * and the whole process under the steward's own lease.
 *
 * Refuses, before ticking anything:
 * - an environment whose form is `fountain`, because there the composite's
 *   Agent and its conversation are the steward and this process would be a
 *   second writer beside them;
 * - a steward whose lease another live process holds (a second local
 *   operator for it).
 */
export async function runStewardOperator(ctx: CommandContext): Promise<number> {
  const { stewards, errors, conflicts } = await discoverStewards();
  for (const err of errors) console.error(formatWarning({ message: err }));
  for (const conflict of conflicts) console.error(formatError({ message: conflict }));

  const picked = pickSteward(stewards, ctx.args.steward ?? "");
  if (typeof picked === "string") {
    console.error(formatError({ message: picked }));
    return 1;
  }
  const steward = picked;
  const env = ctx.args.env ?? DEFAULT_STEWARD_ENV;
  const form = stewardFormFor(steward, env);
  if (form !== "local") {
    console.error(formatError({
      message: `steward "${steward.name}" runs on ${form} in environment "${env}", so a local operator for it would be a second writer`,
      hint: `Its turns run in the fountain steward "${steward.name}"'s conversation. Run this in an environment the declaration's form makes local, or change the form.`,
    }));
    return 1;
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
  const holder = currentHolderId();

  const controller = new AbortController();
  // `process.on`, not `.once` (#2872): a supervisor that signals both a
  // process group and a child sends a second SIGTERM close behind the
  // first. A `.once` listener has already unregistered itself by then, so
  // that second signal takes Node's default disposition and ends the
  // process immediately — before the `finally` below releases the
  // steward's lease. Kept registered for the whole shutdown and removed
  // only once it's over, so a second, third or later signal is a no-op
  // (`stopping` guards against re-aborting or re-logging) rather than a
  // fast exit that skips the release.
  //
  // Registered before the steward's lease is taken, not after: the lease is
  // visible to other readers as soon as its ref is written, and the acquire
  // goes on to push it. A SIGTERM in that stretch found no listener and ended
  // the process by signal with the lease still held (the
  // operator-steward-signal e2e test failed this way). Caught here, it aborts
  // the controller, the loop below starts no round, and the `finally`
  // releases the lease.
  let stopping = false;
  const onSigint = () => {
    if (stopping) return;
    stopping = true;
    console.error(formatWarning({ message: "interrupted — stopping steward" }));
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  // Refuse a second local operator up front rather than letting it loop on
  // `steward-busy` rounds: one steward is one writer.
  const first = await acquireStewardLease(steward.name, holder, { ttlMs: leaseTtlMs }).catch((err: unknown) => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigint);
    throw err;
  });
  if (!first.acquired) {
    console.error(formatError({
      message: `steward "${steward.name}" is already running (lease held by ${first.heldBy?.holder ?? "another process"} until ${first.heldBy?.expiresAt ?? "?"})`,
      hint: "One steward is one writer. Stop the other operator, or wait for its lease to expire.",
    }));
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigint);
    return 1;
  }

  const printRound = (events: OperatorTickEvent[]) => {
    for (const event of events) console.error(formatInfo(formatRoundLine(event)));
  };

  const turnOps = stewardTurnOps(steward);
  const scheduled = turnOps.filter((op) => op.schedule !== undefined);
  const beside = stewardBesideOf(steward).map((b) => b.op);
  try {
    if (ctx.args.once) {
      // One round, and the runs it started beside the turns (#2861) to their end.
      const besideState = createBesideState();
      const events = await runOperatorRound({ steward, holder, leaseTtlMs, activities, profiles, signal: controller.signal, besideState, stewardEnv: env });
      printRound(events);
      await waitForBesideRuns(besideState);
      const ended = besideState.ended.splice(0);
      printRound(ended);
      return events.some((e) => e.kind === "tick-failed" || e.kind === "steward-busy" || e.kind === "ready-failed") ||
        ended.some((e) => e.kind === "beside-ended" && e.code !== 0 && e.code !== 3)
        ? 1
        : 0;
    }
    console.error(formatInfo(
      `chant operator: steward ${steward.name} (local) runs ${scheduled.length} scheduled Op(s) of ${turnOps.length} as its turns` +
        (beside.length > 0 ? `, and ${beside.join(", ")} beside them` : "") +
        `, checking every ${intervalMs}ms (Ctrl-C to stop)`,
    ));
    await runOperatorForever({
      steward,
      stewardEnv: env,
      holder,
      intervalMs,
      leaseTtlMs,
      activities,
      profiles,
      signal: controller.signal,
      onRound: printRound,
    });
    return 0;
  } finally {
    // The listeners stay registered through this whole `finally`, not just
    // the `try` above (#2872): the lease release below is itself async (two
    // more git plumbing calls), and a repeat signal landing in that window
    // is exactly the shape the issue reported — removing the listeners
    // first, before awaiting the release, would reopen the same hole one
    // step later. `stopping` (set already) makes every repeat here a no-op.
    // A courtesy: the lease expires on its own if this never runs.
    const { record } = await readLease(stewardLeaseName(steward.name)).catch(() => ({ record: undefined }));
    if (record?.holder === holder) await releaseLease(stewardLeaseName(steward.name), holder, record.token).catch(() => false);
    // Removed only when no signal started this shutdown. After one did, the
    // CLI goes on to `flushAndExit` (../main.ts) and `process.exit`, and
    // removing the last SIGTERM listener hands the signal back to its
    // default disposition for that stretch: a repeat SIGTERM arriving there
    // ended the process by signal (exit code null) with the lease already
    // released. That was the operator-steward-signal e2e test's intermittent
    // failure; a SIGTERM every 2ms after the first hit it 8 runs of 8.
    if (!stopping) {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigint);
    }
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
  /**
   * The Op whose newest run stopped at this gate, when the gate is a
   * command's own rather than the Op's (#2779): a step running `chant
   * workspace upgrade` stops its run at `workspace-upgrade` / `<scope>`.
   */
  run?: string;
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

  // A gate a command decided inside an Op's step (#2779) is recorded under
  // the command's op, which is not an `*.op.ts`, so the loop above never
  // reads it. The Op's newest run names it; list it against that Op while it
  // still stands.
  for (const [opName, discovered] of [...allOps.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let newest: OpRunRecord | undefined;
    try {
      newest = (await readRunLedger(runEnvOf(discovered.config), opName)).records.at(-1);
    } catch {
      continue;
    }
    const gateOp = newest?.status === "gated" ? newest.gate?.op : undefined;
    if (!newest?.gate || !gateOp || gateOp === opName) continue;
    const record = (await pendingGatesFor(gateOp)).find((r) => r.gate === newest.gate!.name);
    if (!record || covered.has(`${gateOp} ${record.gate}`)) continue;
    covered.add(`${gateOp} ${record.gate}`);
    standalone.push({
      op: gateOp,
      gate: record.gate,
      run: opName,
      expiresAt: record.expiresAt,
      ...(record.description ? { description: record.description } : {}),
      ...(record.url ? { url: record.url } : {}),
    });
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
      console.log(`  - ${g.op} gate "${g.gate}"${g.run ? ` (Op ${g.run}'s run stopped here)` : ""} — resolve: chant approve ${g.op} ${g.gate}`);
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

// `chant approve` lives in ./approve.ts (#3896); these re-exports keep its importers unchanged.
export {
  runApprove,
  recordGateApproval,
  describeApprovalProgress,
  type GateApprovalOptions,
  type GateApprovalOutcome,
} from "./approve";
