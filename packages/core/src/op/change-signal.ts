/**
 * The wake gate between a substrate's change signal and `chant operator`'s
 * sleep (#1981, epic #1487).
 *
 * A lexicon that implements `subscribeChanges` (`../lexicon.ts`) can say
 * "something moved". This module is everything the loop does with that: it
 * shortens the current sleep, at most once per floor. It is deliberately the
 * only place a signal touches, so the rule that a signal is a trigger and
 * never a fact is a property of the code rather than a convention — nothing
 * here has a parameter, a return value or a field that could carry what
 * changed.
 *
 * ## Backpressure: the floor
 *
 * A watch on a busy namespace is not a trickle. A rollout, a Job sweep or a
 * controller resyncing its whole world produces hundreds of events in a
 * second, and each one is a truthful "something moved". Waking a tick per
 * event would turn a convergence loop into a load generator pointed at the
 * cluster it is meant to be watching.
 *
 * So the gate coalesces. Signals are collapsed into a single pending flag, and
 * a pending flag wakes the sleep no earlier than {@link
 * ChangeSignalGateOptions.floorMs} after the last round *started*. A storm of
 * a thousand signals inside one floor window costs exactly one early wake, and
 * a substrate that never stops sending settles into ticking on the floor
 * rather than on the interval — which is the fastest the loop is ever allowed
 * to run.
 *
 * The floor is measured from the start of the last round, not from the last
 * signal, so a steady stream can never push the wake further out (that would
 * be a debounce, and a debounce starves: the busier the cluster, the later the
 * tick). Measuring from the round start makes the guarantee a rate limit —
 * never more than one signal-driven tick per floor — which is the property the
 * loop actually needs.
 */

/**
 * The shortest gap between two rounds a change signal may produce. Signals
 * arriving inside this window of the last round's start are coalesced into one
 * wake at the end of it.
 *
 * Five seconds: long enough that a rollout's event storm costs one tick rather
 * than dozens, short enough that "wakes within a second or so of a change"
 * holds for the quiet case a signal exists for. The timer
 * (`DEFAULT_OPERATOR_INTERVAL_MS`, 60s) is unchanged and remains the ceiling.
 */
export const DEFAULT_SIGNAL_FLOOR_MS = 5_000;

/** Why {@link ChangeSignalGate.wait} returned. */
export type WakeReason =
  /** The full interval elapsed — an ordinary timer-driven round. */
  | "timer"
  /** A substrate signalled and the floor had passed. An early round. */
  | "signal"
  /** The operator is stopping. */
  | "aborted";

export interface ChangeSignalGateOptions {
  /** @default DEFAULT_SIGNAL_FLOOR_MS */
  floorMs?: number;
  /** Injectable clock, for tests. @default Date.now */
  now?: () => number;
}

/**
 * One operator loop's wake gate. Not reusable across loops: it carries the
 * time the current loop last started a round, which is what the floor is
 * measured from.
 */
export interface ChangeSignalGate {
  /**
   * A substrate said something moved. Takes nothing and returns nothing, and
   * that is the enforcement of "a trigger, never a fact" — there is no
   * argument for a watch event to ride in on.
   *
   * Safe to call at any time, including while no `wait` is in flight (the flag
   * is remembered and honoured by the next one) and after the loop has
   * stopped (it does nothing).
   */
  signal(): void;
  /** The loop is starting a round now. Resets the pending flag and the floor. */
  roundStarted(): void;
  /**
   * Sleep up to `intervalMs`, resolving early when a signal has passed the
   * floor. Resolves rather than throws on abort, like the timer-only sleep it
   * replaces, so Ctrl-C never surfaces as a loop failure.
   */
  wait(intervalMs: number, abortSignal?: AbortSignal): Promise<WakeReason>;
  /** How many signals have arrived, coalesced or not. Diagnostics and tests. */
  readonly signalCount: number;
  /** How many of those actually shortened a sleep. Diagnostics and tests. */
  readonly wakeCount: number;
}

export function createChangeSignalGate(options: ChangeSignalGateOptions = {}): ChangeSignalGate {
  const floorMs = options.floorMs ?? DEFAULT_SIGNAL_FLOOR_MS;
  const now = options.now ?? (() => Date.now());

  let pending = false;
  let lastRoundAt = now();
  let signalCount = 0;
  let wakeCount = 0;
  /** Set only while a `wait` is in flight. */
  let arm: (() => void) | undefined;

  return {
    get signalCount() {
      return signalCount;
    },
    get wakeCount() {
      return wakeCount;
    },

    signal() {
      signalCount++;
      pending = true;
      arm?.();
    },

    roundStarted() {
      lastRoundAt = now();
      pending = false;
    },

    wait(intervalMs: number, abortSignal?: AbortSignal): Promise<WakeReason> {
      return new Promise<WakeReason>((resolve) => {
        if (abortSignal?.aborted) return resolve("aborted");

        let settled = false;
        let floorTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (reason: WakeReason) => {
          if (settled) return;
          settled = true;
          clearTimeout(intervalTimer);
          if (floorTimer) clearTimeout(floorTimer);
          abortSignal?.removeEventListener("abort", onAbort);
          arm = undefined;
          if (reason === "signal") wakeCount++;
          resolve(reason);
        };

        const intervalTimer = setTimeout(() => finish("timer"), intervalMs);
        const onAbort = () => finish("aborted");
        abortSignal?.addEventListener("abort", onAbort, { once: true });

        // A pending signal wakes the sleep the moment the floor has passed,
        // and not one moment earlier. `remaining` is measured from the last
        // round's start, so repeated signals inside the window collapse onto
        // the same deadline instead of pushing it out.
        const consider = () => {
          if (settled || !pending) return;
          const remaining = lastRoundAt + floorMs - now();
          if (remaining <= 0) return finish("signal");
          if (floorTimer) return; // already waiting out this window
          floorTimer = setTimeout(() => {
            floorTimer = undefined;
            consider();
          }, remaining);
        };

        arm = consider;
        // A signal that arrived between rounds, while nothing was sleeping,
        // is honoured here rather than lost.
        consider();
      });
    },
  };
}
