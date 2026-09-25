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
import { acquireLease, releaseLease, stillHoldsLease, currentHolderId, DEFAULT_LEASE_TTL_MS, type LeaseRecord, type AcquireLeaseResult } from "../lifecycle/lease";
import { randomUUID } from "node:crypto";
import { readRunLedger, runEnvOf } from "../lifecycle/run-ledger";
import { enterStewardTurn } from "./steward-turn";
import { stewardLeaseName, stewardTurnLeaseName, type StewardDeclaration } from "./steward";
import { stewardWorkHolder } from "./work-lease-run";
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
  /**
   * The Op ran. `resumed` names the decision point question it was waiting on
   * (#2749) when a steward ran it because that question is now answered,
   * rather than because its cron fired.
   */
  | { kind: "ticked"; op: string; env: string; result: OpRunResult; resumed?: string }
  /**
   * A steward's Op whose last run stopped on an open decision point (#2749),
   * and the question is still open, so the Op is not run this round. A person
   * answers it through hud or `points answer`; the steward never does.
   */
  | { kind: "waiting-on-point"; op: string; env: string; point: string; question: string; state: string }
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
  | { kind: "lease-error"; op: string; env: string; error: string }
  /**
   * A local steward's round (#2731) found the steward's own lease held by
   * another live holder: another `chant operator --steward` for the same
   * steward. Nothing ticked. `op` is the steward's lease name and `env` is
   * `-`, so a log line keyed on either still reads.
   */
  | { kind: "steward-busy"; op: string; env: string; steward: string; heldBy?: string }
  /**
   * A local steward's round (#2750) found its turn lease
   * (`stewardTurnLeaseName`) held by someone else already mid-run — a `chant
   * run <op>` typed by hand, or another round somehow still finishing one.
   * Nothing ticked: the round stops here rather than trying its remaining
   * ops, since every one of them would fail the same check (the turn is one
   * lease for the whole steward, not one per op). The next round tries
   * again.
   */
  | { kind: "turn-busy"; op: string; env: string; steward: string; heldBy?: string };

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
  /**
   * Run a local steward's Ops instead of every discovered ConvergeOp (#2731).
   * Only its scheduled Ops tick, each on its own cron, because that is what
   * the same steward does on Fountain: an Op with no schedule runs when
   * someone asks for it. The round first takes (or renews) the steward's own
   * lease, and ticks nothing when another holder has it.
   */
  steward?: StewardDeclaration;
  /**
   * How a steward's round reads the state of the questions its waiting runs
   * stopped on (#2749): question id to state, or null when they can't be
   * read. Defaults to the workspace's `points` read; a test injects one.
   */
  readQuestions?: (cwd: string) => Promise<Map<string, string> | null>;
}

/** A steward's Op whose last run waits on a decision point (#2749). */
interface WaitState {
  /** The answer record's id. */
  question: string;
  point: string;
  /** The question's state now, or the one the run recorded when it can't be read. */
  state: string;
  /** The question is answered, or its record is gone, so the Op runs again. */
  answered: boolean;
}

/**
 * The steward's Ops whose newest run is the steward's own and stopped on a
 * decision point, with that question's state now. The questions are read
 * from the workspace the way `points` reads them; a workspace that can't be
 * read leaves every run waiting.
 */
async function stewardWaits(steward: StewardDeclaration, opts: OperatorRoundOptions): Promise<Map<string, WaitState>> {
  const out = new Map<string, WaitState>();
  const runs: { op: string; question: string; point: string; state: string }[] = [];
  for (const op of steward.ops) {
    try {
      const newest = (await readRunLedger(runEnvOf(op), op.name, { cwd: opts.cwd })).records.at(-1);
      if (newest?.status === "waiting" && newest.point && newest.steward === steward.name) {
        runs.push({ op: op.name, question: newest.point.id, point: newest.point.point, state: newest.point.state });
      }
    } catch {
      // A ledger that can't be read has no waiting run to resume.
    }
  }
  if (runs.length === 0) return out;
  const states = await (opts.readQuestions ?? readQuestionStates)(opts.cwd ?? process.cwd());
  for (const r of runs) {
    const now = states?.get(r.question);
    const answered = states !== null && (now === undefined || now === "answered");
    out.set(r.op, { question: r.question, point: r.point, state: now ?? r.state, answered });
  }
  return out;
}

/** Every question's state in the workspace, by id, or null when the workspace's points can't be read. */
async function readQuestionStates(cwd: string): Promise<Map<string, string> | null> {
  try {
    const { workspacePoints } = await import("../workspace/points-cli");
    const doc = await workspacePoints({ cwd });
    if (!("questions" in doc)) return null;
    // An answer kind that could not be read might hold the question: say
    // nothing rather than resume a run whose question may still be open.
    if (doc.sources.some((s) => s.reason !== null)) return null;
    return new Map(doc.questions.map((q) => [q.id, q.state]));
  } catch {
    return null;
  }
}

/** Take or renew a local steward's own lease (#2731). */
export async function acquireStewardLease(
  steward: string,
  holder: string,
  opts: { cwd?: string; ttlMs?: number; now?: () => Date } = {},
): Promise<AcquireLeaseResult> {
  return acquireLease(stewardLeaseName(steward), holder, { ...opts, ttlMs: opts.ttlMs ?? DEFAULT_LEASE_TTL_MS });
}

/**
 * How long a caller contending for a steward's turn lease
 * (`acquireStewardTurn`) retries before giving up (#2750). Long enough to
 * ride out a race with a turn that is just ending; short enough that a
 * genuinely busy steward is reported back promptly. A round never waits
 * (`waitMs` omitted there): it already runs on its own timer and simply
 * tries the turn again next round, exactly as it already does for a busy
 * per-op lease. `chant run <op>` (`../cli/handlers/run.ts`) is the caller
 * that waits, since a human is standing at the terminal for the answer.
 */
export const STEWARD_TURN_WAIT_MS = 2_000;

/** How often {@link acquireStewardTurn} retries while it waits. */
const STEWARD_TURN_POLL_MS = 150;

/**
 * Take the steward's turn lease (#2750): the lease every run of one of its
 * Ops — a round's scheduled tick, or `chant run <op>` typed by hand — holds
 * for exactly as long as that one run takes, so the two are never beside each
 * other. Distinct from {@link acquireStewardLease}, which one `chant operator
 * --steward` process holds for its whole life: this one is held per-run, so a
 * hand run succeeds the moment a round's tick ends, not only once the daemon
 * itself stops.
 *
 * Contention never queues past `waitMs` (0 by default): consistent with a
 * round's own leases, which skip and report rather than wait (see this
 * module's doc), and with the fountain form, whose busy teammate is likewise
 * refused rather than retried. A caller that wants to ride out a race with a
 * turn about to end passes `waitMs`, and this polls every
 * {@link STEWARD_TURN_POLL_MS} until it acquires or the wait runs out.
 */
export async function acquireStewardTurn(
  steward: string,
  holder: string,
  opts: { cwd?: string; ttlMs?: number; now?: () => Date; waitMs?: number } = {},
): Promise<AcquireLeaseResult> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  for (;;) {
    const result = await acquireLease(stewardTurnLeaseName(steward), holder, {
      cwd: opts.cwd,
      ttlMs: opts.ttlMs ?? DEFAULT_LEASE_TTL_MS,
      now: opts.now,
    });
    if (result.acquired || result.reason !== "held" || Date.now() >= deadline) return result;
    await new Promise((r) => setTimeout(r, STEWARD_TURN_POLL_MS));
  }
}

/** Release a steward's turn lease, best-effort — a run whose turn was never actually acquired (or already lost) has nothing to release. */
async function releaseStewardTurn(steward: string, holder: string, token: string, opts: { cwd?: string } = {}): Promise<void> {
  await releaseLease(stewardTurnLeaseName(steward), holder, token, opts).catch(() => false);
}

/**
 * The Ops one round considers: a steward's Ops, or every ConvergeOp. A
 * steward's Op with no schedule is considered only to resume a run of the
 * steward's that waits on a decision point.
 */
async function roundOps(opts: OperatorRoundOptions): Promise<DiscoveredOp["config"][]> {
  if (opts.steward) return [...opts.steward.ops];
  const { ops } = await discoverConvergeOps({ cwd: opts.cwd, env: opts.env });
  return ops.map((d) => d.config);
}

/**
 * Run exactly one round: for every discovered ConvergeOp (filtered per
 * `opts.env`), try its lease; tick the ones this holder wins. Returns one
 * event per discovered op, in discovery order — deterministic, so tests can
 * assert on it directly without depending on log output.
 */
export async function runOperatorRound(opts: OperatorRoundOptions): Promise<OperatorTickEvent[]> {
  const holder = opts.holder ?? currentHolderId();
  const events: OperatorTickEvent[] = [];
  const steward = opts.steward;
  const leaseOpts = { cwd: opts.cwd, ttlMs: opts.leaseTtlMs, now: opts.now };

  // A local steward is one writer (#2731): its round runs only while it holds
  // its own lease, renewed here and again after every tick, so a turn longer
  // than the lease's TTL still keeps it.
  const holdSteward = async (): Promise<boolean> => {
    if (!steward) return true;
    let acquired: AcquireLeaseResult;
    try {
      acquired = await acquireStewardLease(steward.name, holder, leaseOpts);
    } catch (err) {
      events.push({
        kind: "lease-error",
        op: stewardLeaseName(steward.name),
        env: "-",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (acquired.acquired) return true;
    events.push({
      kind: "steward-busy",
      op: stewardLeaseName(steward.name),
      env: "-",
      steward: steward.name,
      ...(acquired.heldBy?.holder ? { heldBy: acquired.heldBy.holder } : {}),
    });
    return false;
  };

  if (!(await holdSteward())) return events;

  // A steward's Ops whose last run waits on a decision point (#2749), read
  // once per round, and the state of those questions now.
  const waiting = steward ? await stewardWaits(steward, opts) : new Map<string, WaitState>();

  for (const config of await roundOps(opts)) {
    const env = steward ? runEnvOf(config) : (envOf(config) ?? "unknown");
    const wait = waiting.get(config.name);
    let resumed: string | undefined;

    // A run waiting on a question that is now answered is resumed on this
    // round, whatever its cron says. One whose question is still open is left
    // until a person answers it, unless its cron fires, which asks again.
    if (wait?.answered) resumed = wait.question;

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
      if (!due && resumed === undefined) {
        events.push(
          wait
            ? { kind: "waiting-on-point", op: config.name, env, point: wait.point, question: wait.question, state: wait.state }
            : { kind: "skipped-not-due", op: config.name, env, cron },
        );
        continue;
      }
    } else if (steward && resumed === undefined) {
      // An unscheduled Op runs when someone asks for it; the steward runs it
      // only to resume its own waiting run.
      if (wait) events.push({ kind: "waiting-on-point", op: config.name, env, point: wait.point, question: wait.question, state: wait.state });
      continue;
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

    // A local steward is one turn at a time (#2750): a hand run (`chant run
    // <op>`) holds this same lease for as long as it runs, so a round never
    // ticks beside one. It is one lease for the whole steward, not one per
    // op, so finding it held stops the round outright — every op still ahead
    // of it in `roundOps` would fail the identical check.
    let turn: AcquireLeaseResult | undefined;
    if (steward) {
      turn = await acquireStewardTurn(steward.name, holder, { cwd: opts.cwd, ttlMs: opts.leaseTtlMs, now: opts.now });
      if (!turn.acquired) {
        await releaseLease(config.name, holder, lease.token, { cwd: opts.cwd }).catch(() => false);
        events.push({ kind: "turn-busy", op: config.name, env, steward: steward.name, heldBy: turn.heldBy?.holder });
        break;
      }
    }

    // The run is the steward's turn (#2749): a decision point it asks names the
    // steward and makes its model call through the steward's broker, and an
    // answer from inside the turn is refused.
    const runId = randomUUID();
    const restoreTurn = steward
      ? enterStewardTurn({ steward: steward.name, capabilities: steward.capabilities, vault: steward.vault, run: runId })
      : undefined;
    try {
      const result = await runOpLocally(config, opts.activities, opts.profiles, opts.signal, {
        runId,
        ...(steward ? { steward: steward.name } : {}),
        ledger: { cwd: opts.cwd },
        // A steward's turn claims work leases as `<steward>/<op>@<holder>`
        // (#2748), which is how `workspace status` finds the lease it holds.
        ...(steward ? { work: { holder: stewardWorkHolder(steward.name, config.name, holder) } } : {}),
        // #2301: without a sink, `settle` catches a failed ledger append and
        // drops it. That is the failure this tick can least afford to lose —
        // the message below points the reader at the ledger record, which is
        // exactly the artifact a failed append means is not there.
        onLedgerError: (err) =>
          events.push({
            kind: "tick-failed",
            op: config.name,
            env,
            error:
              `Op "${config.name}" ran, but its record could not be appended to the run ledger: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          }),
      });
      const held = await stillHoldsLease(config.name, holder, lease.token, { cwd: opts.cwd });
      events.push(
        held
          ? { kind: "ticked", op: config.name, env, result, ...(resumed !== undefined ? { resumed } : {}) }
          : { kind: "fenced", op: config.name, env },
      );
    } catch (err) {
      // #2301: "see its ledger record" was the whole message, and it sent the
      // reader to an artifact that a failed ledger append means is missing —
      // while `err.result` was carrying the failing steps all along. Name the
      // failing steps here, and fall back to `cause` for a failure that
      // produced no step record at all.
      const message =
        err instanceof OpRunFailure
          ? failureDetail(config.name, err)
          : err instanceof Error
            ? err.message
            : String(err);
      events.push({ kind: "tick-failed", op: config.name, env, error: message });
    } finally {
      restoreTurn?.();
      if (steward && turn?.acquired) await releaseStewardTurn(steward.name, holder, turn.lease!.token, { cwd: opts.cwd });
    }
    if (!(await holdSteward())) break;
  }

  return events;
}

/**
 * What a failed tick says about itself (#2301).
 *
 * `chant operator` renders its own events rather than going through
 * `renderHuman`, so the executor's step records reached nobody here even after
 * the executor stopped dropping them. Every failing step's message, in order,
 * or the underlying error when the run failed without producing one.
 */
function failureDetail(op: string, err: OpRunFailure): string {
  const failed = err.result.records.filter((r) => r.status === "fail" && r.error);
  if (failed.length > 0) {
    return `Op "${op}" failed: ${failed.map((r) => `${r.fn}: ${r.error}`).join("; ")}`;
  }
  const cause = err.cause;
  if (cause !== undefined) {
    return `Op "${op}" failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return `Op "${op}" failed — see its ledger record for step-level detail`;
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
        (event.result.gate ? ` gate="${event.result.gate.gate}"` : "") +
        (event.result.point ? ` point="${event.result.point.id}"` : "") +
        (event.resumed ? ` resumed="${event.resumed}"` : "");
    case "waiting-on-point":
      return `operator: ${event.op}@${event.env} waiting=1(point:${event.question}:${event.state})`;
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
    case "steward-busy":
      return `operator: steward ${event.steward} skipped=1(steward-lease-held${event.heldBy ? `:${event.heldBy}` : ""})`;
    case "turn-busy":
      return `operator: ${event.op}@${event.env} skipped=1(turn-held${event.heldBy ? `:${event.heldBy}` : ""}, steward "${event.steward}" is already mid-turn)`;
  }
}
