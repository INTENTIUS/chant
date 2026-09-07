/**
 * `chant operator` (#1485, epic #1487) — durable ticks with no service behind
 * them. A deliberately small daemon: a timer, a lease
 * (../lifecycle/lease.ts), and the existing local executor
 * (./local-executor.ts) in a loop. No new service, no new state store — the
 * lease lives on a git ref, tick state lives on the `chant/lifecycle`
 * orphan branch via the same `convergeTick` activity `chant run <op>`
 * already calls for a single one-shot tick.
 *
 * One round: discover every `ConvergeOp` (label `Converge:
 * "true"`, optionally filtered to one env), and for each one, try to
 * acquire (or renew) its lease. Win it — run one tick via `runOpLocally` on
 * the Op's own Observe → Converge phases, the identical path `chant run
 * <name>` takes for a single tick (issue: "chant run fountain-converge —
 * one tick, by hand — unchanged, and also the test story"). Lose it — skip
 * and report, never queue (issue: "a tick that finds the lease held skips
 * and reports ... never queues").
 *
 * Crash recovery needs no special code: a killed operator simply stops
 * renewing its lease, which expires on its own TTL; the next round (from
 * this process restarted, a different machine's operator, or a bare `chant
 * run <name>` invoked by cron) re-acquires and re-ticks. A converge tick
 * re-observes and re-derives everything every time (ConvergeOp's own
 * design, #1484) — re-ticking after a crash and ticking on a normal
 * schedule are the same act, not two different code paths.
 *
 * One crash *does* need a distinct report, though (#1959 finding 2): if the
 * killed operator's own `git update-ref` was interrupted mid-write, it can
 * leave a stale `.lock` file behind that blocks every future acquire
 * attempt for that op's lease until someone removes it — TTL expiry doesn't
 * help, since the ref update itself can't land. `acquireLease` surfaces
 * that case as a `StaleLockError` rather than ordinary "lease held by
 * someone else" contention, and a round reports it per-op as
 * `{ kind: "lease-error" }` (never aborting the whole round) so `chant
 * operator`'s log names the fix instead of quietly skipping that op
 * forever.
 */
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import { discoverOps, type DiscoveredOp } from "./discover";
import { runOpLocally, OpRunFailure, type OpRunResult } from "./local-executor";
import { acquireLease, stillHoldsLease, currentHolderId, DEFAULT_LEASE_TTL_MS, type LeaseRecord, type AcquireLeaseResult } from "../lifecycle/lease";
import { StaleLockError } from "../lifecycle/git";
import { cronMatches, cronDueBetween } from "./cron";
import { createChangeSignalGate, DEFAULT_SIGNAL_FLOOR_MS, type WakeReason } from "./change-signal";
import type { ChangeSubscription } from "../lexicon";

/**
 * Poll interval between rounds — the operator's own cadence, and the fallback
 * for an Op that declares none. Since #2120 an Op can carry its own
 * `schedule.cron` (`./composites/converge-op.ts`), which this loop honours per
 * Op: the round still wakes every `intervalMs`, but an Op with a cron is
 * ticked only on the minutes that cron fires. Chosen short enough to converge
 * promptly, long enough not to hammer `chant lifecycle plan --live` every few
 * seconds — and short enough that a per-minute cron is not missed.
 */
export const DEFAULT_OPERATOR_INTERVAL_MS = 60_000;

/** One ConvergeOp's own `labels.Env` (`./composites/converge-op.ts` always sets it). `undefined` for a non-ConvergeOp or a hand-built one missing it — filtered out by `isConvergeOp` before this is trusted. */
function envOf(config: DiscoveredOp["config"]): string | undefined {
  return config.labels?.Env;
}

function isConvergeOp(config: DiscoveredOp["config"]): boolean {
  return config.labels?.Converge === "true";
}

/** Discover every `ConvergeOp` in the project (`labels.Converge === "true"`), optionally filtered to one environment. Ops that don't declare an `Env` label are excluded from an `--env`-filtered discovery (there's nothing to match), but included when no `env` filter is given. */
export async function discoverConvergeOps(
  opts?: { cwd?: string; env?: string },
): Promise<{ ops: DiscoveredOp[]; errors: string[] }> {
  const { ops, errors } = await discoverOps({ cwd: opts?.cwd });
  const converge = [...ops.values()].filter((d) => isConvergeOp(d.config));
  const filtered = opts?.env ? converge.filter((d) => envOf(d.config) === opts.env) : converge;
  return { ops: filtered.sort((a, b) => a.config.name.localeCompare(b.config.name)), errors };
}

/** One discovered ConvergeOp's outcome for one round — what `chant operator`'s one-line-per-tick log (and its tests) key off of. */
export type OperatorTickEvent =
  | { kind: "ticked"; op: string; env: string; result: OpRunResult }
  | { kind: "skipped-lease-held"; op: string; env: string; heldBy?: string }
  /** The Op declares its own `schedule.cron` (#2120) and this round did not land on a firing minute — the lease was never touched. An Op without a cron is never reported this way: it ticks every round, on `--interval`. */
  | { kind: "skipped-not-due"; op: string; env: string; cron: string }
  | { kind: "tick-failed"; op: string; env: string; error: string }
  /** The lease was lost between acquiring it and the tick finishing (e.g. this process stalled past its TTL and another operator reclaimed it) — the tick's own ledger record (written inside `convergeTick`) still landed, since a converge tick is idempotent by design; this event exists purely so `chant operator`'s log and the ledger-independent test surface can see the fencing violation happened. Never a hard failure. */
  | { kind: "fenced"; op: string; env: string }
  /**
   * `acquireLease` itself threw — a `StaleLockError` (#1959 finding 2: a
   * previous `chant operator` was killed mid-write and left a `.lock` file
   * behind, so this op's lease can no longer be acquired or renewed by
   * anyone until the file is removed) or any other unexpected failure. A
   * distinct outcome from `skipped-lease-held` on purpose — this is not
   * ordinary contention with a live holder, it's wreckage that needs a
   * human, and reading it as "someone else has it" would make the operator
   * back off silently forever instead of surfacing the fix. One op's lease
   * error never aborts the round for every other op.
   */
  | { kind: "lease-error"; op: string; env: string; error: string };

export interface OperatorRoundOptions {
  cwd?: string;
  /** Restrict ticking to ConvergeOps for this environment. Omit to tick every discovered ConvergeOp. */
  env?: string;
  /** @default DEFAULT_LEASE_TTL_MS */
  leaseTtlMs?: number;
  /** This process's lease identity. @default currentHolderId() — a fresh identity per process, deliberately: two ticks from what could plausibly be two different processes should behave like two different holders even in a test that reuses one process, unless the caller wants to simulate "same process, later round" by passing a stable value. */
  holder?: string;
  /** Injected activity implementations — the CLI loads the real ones the same way `chant run` does (`loadActivities`); tests inject fakes so a round never shells out. */
  activities: Map<string, ActivityFn>;
  profiles: Record<string, ActivityProfile>;
  now?: () => Date;
  signal?: AbortSignal;
  /**
   * When each Op with its own `schedule.cron` was last considered (#2120) —
   * the state a round needs to answer "has a firing minute passed since I
   * last looked at this Op?". `runOperatorForever` owns one map across
   * rounds; a bare `runOperatorRound` with none given falls back to "is this
   * minute a firing minute", which is what a single round can know on its
   * own. Every considered Op's entry is updated, ticked or not, so a late
   * round makes up exactly one tick rather than a backlog.
   */
  scheduleState?: Map<string, Date>;
}

/**
 * Run exactly one round: for every discovered ConvergeOp (filtered per
 * `opts.env`), try its lease; tick the ones this holder wins. Returns one
 * event per discovered op, in discovery order — deterministic, so tests can
 * assert on it directly without depending on log output.
 */
export async function runOperatorRound(opts: OperatorRoundOptions): Promise<OperatorTickEvent[]> {
  const holder = opts.holder ?? currentHolderId();
  const { ops } = await discoverConvergeOps({ cwd: opts.cwd, env: opts.env });
  const events: OperatorTickEvent[] = [];

  for (const { config } of ops) {
    const env = envOf(config) ?? "unknown";

    // An Op that declares its own cadence (#2120) is ticked on that cron
    // rather than on every round. Level-triggered: the question is whether a
    // firing minute has passed since this Op was last looked at, so a round
    // that arrives late still owes exactly one tick — a converge tick
    // re-observes everything anyway, and several missed fires are one tick's
    // worth of work.
    const cron = config.schedule?.cron;
    if (cron) {
      const now = (opts.now ?? (() => new Date()))();
      const lastSeen = opts.scheduleState?.get(config.name);
      const due = lastSeen === undefined ? cronMatches(cron, now) : cronDueBetween(cron, lastSeen, now);
      opts.scheduleState?.set(config.name, now);
      if (!due) {
        events.push({ kind: "skipped-not-due", op: config.name, env, cron });
        continue;
      }
    }

    let acquired: AcquireLeaseResult;
    try {
      acquired = await acquireLease(config.name, holder, {
        cwd: opts.cwd,
        ttlMs: opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
        now: opts.now,
      });
    } catch (err) {
      // Not lease contention — the acquire attempt itself failed (most
      // likely a StaleLockError, ./lifecycle/git.ts's diagnosable
      // stand-in for "a previous operator was killed mid-write"). Report it
      // for this op and move on to the next; never abort the whole round.
      const message =
        err instanceof StaleLockError ? err.message : err instanceof Error ? err.message : String(err);
      events.push({ kind: "lease-error", op: config.name, env, error: message });
      continue;
    }

    if (!acquired.acquired) {
      events.push({ kind: "skipped-lease-held", op: config.name, env, heldBy: acquired.heldBy?.holder });
      continue;
    }

    const lease = acquired.lease as LeaseRecord;
    try {
      const result = await runOpLocally(config, opts.activities, opts.profiles, opts.signal, {
        ledger: { cwd: opts.cwd },
      });
      const held = await stillHoldsLease(config.name, holder, lease.token, { cwd: opts.cwd });
      events.push(held ? { kind: "ticked", op: config.name, env, result } : { kind: "fenced", op: config.name, env });
    } catch (err) {
      const message =
        err instanceof OpRunFailure
          ? `Op "${config.name}" failed — see its ledger record for step-level detail`
          : err instanceof Error
            ? err.message
            : String(err);
      events.push({ kind: "tick-failed", op: config.name, env, error: message });
    }
  }

  return events;
}

/** Abortable sleep — resolves early (without throwing) if `signal` fires mid-wait, so the operator loop can stop promptly on Ctrl-C rather than finishing out a long interval. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One lexicon's change-signal seam, already bound to an environment (#1981).
 *
 * The loop never sees a `LexiconPlugin`: core's operator does not import
 * plugins, and binding happens where plugins are already loaded
 * (`collectChangeSubscribers` in `../cli/plugins.ts`), the same extract-then-
 * thread shape `collectBuildRootContributors` uses for build roots.
 */
export interface ChangeSubscriber {
  /** Which lexicon supplies the signal. Log lines only; never a fact. */
  lexicon: string;
  subscribe(ctx: {
    onChange: () => void;
    onError: (message: string) => void;
    signal: AbortSignal;
  }): Promise<ChangeSubscription>;
}

/**
 * What the loop's change-signal machinery reports, alongside the per-op tick
 * events. Separate from {@link OperatorTickEvent} on purpose: none of this is
 * about an Op, and none of it is an observation.
 */
export type OperatorSignalEvent =
  /** A lexicon's subscription is live and the loop may now wake early. */
  | { kind: "subscribed"; lexicon: string }
  /** Establishing it failed. The loop keeps its timer and retries next round. */
  | { kind: "subscribe-failed"; lexicon: string; error: string }
  /** A live subscription died. Reported once; the next round re-subscribes. */
  | { kind: "subscription-lost"; lexicon: string; error: string }
  /** A signal shortened the sleep. The round that follows is an ordinary round. */
  | { kind: "woken"; afterMs: number };

/** Render one signal event as `chant operator`'s log line shape. */
export function formatSignalLine(event: OperatorSignalEvent): string {
  switch (event.kind) {
    case "subscribed":
      return `operator: ${event.lexicon} change signal subscribed (the timer still runs)`;
    case "subscribe-failed":
      return `operator: ${event.lexicon} change signal unavailable, polling on the timer (${event.error})`;
    case "subscription-lost":
      return `operator: ${event.lexicon} change signal lost, polling on the timer until the next round re-subscribes (${event.error})`;
    case "woken":
      return `operator: woken by a change signal after ${event.afterMs}ms, running an ordinary round`;
  }
}

export interface OperatorLoopOptions extends OperatorRoundOptions {
  /** @default DEFAULT_OPERATOR_INTERVAL_MS */
  intervalMs?: number;
  /** Called after every round completes — the CLI's one-line-per-tick log lives here, not inside the loop itself, so a test can drive rounds without capturing stdout. */
  onRound?: (events: OperatorTickEvent[]) => void;
  /**
   * Change-signal seams to keep subscribed for the life of the loop (#1981).
   * Omitted, or empty, and the loop is exactly what it was: a timer.
   */
  subscribers?: readonly ChangeSubscriber[];
  /** @default DEFAULT_SIGNAL_FLOOR_MS. The shortest gap a signal may force between two rounds. */
  signalFloorMs?: number;
  /** Called for every subscription and wake event. The CLI logs one line each. */
  onSignalEvent?: (event: OperatorSignalEvent) => void;
}

/**
 * Run rounds forever, sleeping `intervalMs` between them, until
 * `opts.signal` aborts. The daemon is a convenience, never a requirement
 * (issue: "if it dies, nothing breaks and nothing is lost") — this function
 * is exactly `while (!aborted) { round(); sleep(); }`, nothing durable lives
 * in its own memory that a restart would need to recover.
 *
 * With `subscribers` (#1981) the sleep gains a second wake source, and only a
 * wake source. A signal aborts the current sleep; the round that follows is
 * the same round the timer would have run, deriving everything from a fresh
 * observation. Nothing a subscription reports reaches a tick, because the
 * seam has nowhere to put it: `onChange` takes no arguments.
 */
export async function runOperatorForever(opts: OperatorLoopOptions): Promise<void> {
  const holder = opts.holder ?? currentHolderId();
  // Per-op cron state (#2120) lives for the life of the loop. A restart starts
  // it empty, which means the first round ticks a scheduled Op only if it
  // lands on a firing minute — a fresh operator owes no catch-up for the ticks
  // it was not running for.
  const scheduleState = opts.scheduleState ?? new Map<string, Date>();
  const intervalMs = opts.intervalMs ?? DEFAULT_OPERATOR_INTERVAL_MS;
  const subscribers = opts.subscribers ?? [];

  // Nothing to subscribe to: the loop below is byte for byte the loop that
  // shipped before #1981, and takes none of the machinery's cost.
  if (subscribers.length === 0) {
    while (!opts.signal?.aborted) {
      const events = await runOperatorRound({ ...opts, holder, scheduleState });
      opts.onRound?.(events);
      if (opts.signal?.aborted) break;
      await sleepAbortable(intervalMs, opts.signal);
    }
    return;
  }

  const gate = createChangeSignalGate({ floorMs: opts.signalFloorMs ?? DEFAULT_SIGNAL_FLOOR_MS });
  // The subscriptions the loop currently holds, by lexicon. A lexicon absent
  // from this map is one to (re-)subscribe on the next round, which is how a
  // killed watch comes back without a special retry path.
  const live = new Map<string, ChangeSubscription>();
  // Stops every subscription at once when the loop ends, whatever ends it.
  const subscriptionsAbort = new AbortController();

  const closeAll = async (): Promise<void> => {
    subscriptionsAbort.abort();
    const open = [...live.values()];
    live.clear();
    // A close that throws must not mask why the loop is unwinding.
    await Promise.allSettled(open.map((s) => s.close()));
  };

  const ensureSubscribed = async (): Promise<void> => {
    for (const subscriber of subscribers) {
      if (live.has(subscriber.lexicon) || subscriptionsAbort.signal.aborted) continue;
      try {
        const subscription = await subscriber.subscribe({
          onChange: () => gate.signal(),
          onError: (error) => {
            // Reported once, then forgotten: dropping it from `live` is what
            // makes the next round re-subscribe. The loop itself is untouched.
            if (!live.delete(subscriber.lexicon)) return;
            opts.onSignalEvent?.({ kind: "subscription-lost", lexicon: subscriber.lexicon, error });
          },
          signal: subscriptionsAbort.signal,
        });
        live.set(subscriber.lexicon, subscription);
        opts.onSignalEvent?.({ kind: "subscribed", lexicon: subscriber.lexicon });
      } catch (err) {
        // A subscription that cannot be established is a slower loop, never a
        // stopped one: report it and fall through to the timer.
        opts.onSignalEvent?.({
          kind: "subscribe-failed",
          lexicon: subscriber.lexicon,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  try {
    while (!opts.signal?.aborted) {
      gate.roundStarted();
      const startedAt = Date.now();
      const events = await runOperatorRound({ ...opts, holder, scheduleState });
      opts.onRound?.(events);
      if (opts.signal?.aborted) break;

      await ensureSubscribed();
      if (opts.signal?.aborted) break;

      const reason: WakeReason = await gate.wait(intervalMs, opts.signal);
      if (reason === "signal") {
        opts.onSignalEvent?.({ kind: "woken", afterMs: Date.now() - startedAt });
      }
    }
  } finally {
    await closeAll();
  }
}

/** Render one round's events as `chant operator`'s log line shape — one line per ticked/skipped/failed op, reusing each ticked op's own `convergeTick` log line (`OpRunResult`'s outcome attribute doesn't carry it, so this reads the tick's step record's `Remediated`... actually the human-readable summary comes from the ledger, not the run result — see `../cli/handlers/operator.ts` for where `chant operator status` reads it back). This formats what's available from the round itself: which op, which env, and whether it ticked, skipped, or failed. */
export function formatRoundLine(event: OperatorTickEvent): string {
  switch (event.kind) {
    case "ticked":
      return `operator: ${event.op}@${event.env} ticked=1 status=${event.result.status}` +
        (event.result.gate ? ` gate="${event.result.gate.gate}"` : "");
    case "skipped-lease-held":
      return `operator: ${event.op}@${event.env} skipped=1(lease-held${event.heldBy ? `:${event.heldBy}` : ""})`;
    case "skipped-not-due":
      return `operator: ${event.op}@${event.env} skipped=1(not-due:${event.cron})`;
    case "tick-failed":
      return `operator: ${event.op}@${event.env} failed=1 error="${event.error}"`;
    case "fenced":
      return `operator: ${event.op}@${event.env} fenced=1(lease lost mid-tick — ledger record still written)`;
    case "lease-error":
      return `operator: ${event.op}@${event.env} error=1(lease acquire failed — ${event.error})`;
  }
}
