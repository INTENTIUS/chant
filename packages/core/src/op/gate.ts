/**
 * Gate-as-fact (#2119, epic #2114) — the one place that decides what happens
 * when a run reaches a `gate`, shared by the Op executor
 * (`./local-executor.ts`) and the component driver
 * (`../components/driver.ts`) so the two can never drift.
 *
 * A gate used to be a wait, which meant a runtime that cannot wait had to
 * refuse the whole op before its first step (`LocalGateUnsupportedError`,
 * deleted with this). It is a fact now: the run reads the gate ledger
 * (`../lifecycle/gate-ledger.ts`) for a resolution someone wrote with `chant
 * approve`, and either walks through carrying the approver, or records a
 * pending fact and ends. Nothing blocks, nothing is queued, nothing has to be
 * resumed — the next run re-evaluates from the ledger, which is exactly the
 * level-triggered shape a converge tick already has.
 *
 * The staleness rule is the same one `chant operator status` has applied since
 * #1485: a resolution counts only if it is newer than the newest pending fact
 * for that gate. Approving before the gate was ever reached does not
 * pre-authorize a future run's gate that has since been recorded pending; a
 * resolution from last month does not answer the fact this run just wrote.
 *
 * Ledger access goes through {@link GateLedgerPort} rather than straight to
 * git, so a test (and the operator's own in-memory paths) can drive the
 * decision without an orphan branch on disk.
 */

import {
  appendPendingGate,
  isPendingGateExpired,
  latestPendingGate,
  latestResolutionSince,
  readGateLedger,
  resolveApprovalUrl,
  DEFAULT_GATE_EXPIRY,
  type GateResolutionRecord,
  type PendingGateInput,
  type PendingGateRecord,
} from "../lifecycle/gate-ledger";
import { pushLifecycle, requireLifecycleLedger } from "../lifecycle/git";
import { parseDuration } from "./duration";

/**
 * What appending a pending fact learned about reaching the remote.
 *
 * The append to the local `chant/lifecycle` branch always lands — that half
 * was fixed by #2309's fetch-before-append. This is the other half: whether
 * the push that follows it did, and why not when it didn't, in one line a
 * renderer can show directly (#2310).
 */
export interface PendingGatePush {
  record: PendingGateRecord;
  /**
   * True when the push reached the remote. False when there was no remote
   * configured, or the push was rejected — `pushWarning` says which.
   */
  pushed: boolean;
  /** Set when `pushed` is false. */
  pushWarning?: string;
}

/** The gate ledger, as the two executors need it: read both kinds of line, append a pending fact. */
export interface GateLedgerPort {
  read(op: string): Promise<{ resolutions: GateResolutionRecord[]; pending: PendingGateRecord[] }>;
  appendPending(input: PendingGateInput): Promise<PendingGatePush>;
}

/**
 * The real port: the `chant/lifecycle` orphan branch.
 *
 * Appending is always local-first and always lands (#2309's fetch-before-
 * append). The push that follows is reported rather than swallowed (#2310):
 * a pending fact that never reaches the remote is still a correct local
 * answer — the run is right to gate, and does — but an operator elsewhere
 * cannot approve a gate whose pending record they cannot see, so the caller
 * gets `pushed: false` and a reason instead of silence. Mirrors the shape
 * `chant approve` reports through (`../cli/handlers/operator.ts`'s
 * `reportedPush`, #2309 review).
 */
export function gitGateLedgerPort(opts?: { cwd?: string }): GateLedgerPort {
  return {
    async read(op) {
      // The ledger branch has to be in the checkout before it is read
      // (#2303): a CI clone fetches the pipeline's own ref and nothing else,
      // and an unfetched branch reads as an empty ledger — which is
      // indistinguishable from "nothing has been approved" and makes a
      // retried job record a second pending fact for a gate that was already
      // approved. Refuses rather than guessing when the fetch cannot settle
      // it; see `requireLifecycleLedger`.
      await requireLifecycleLedger(opts);
      const { resolutions, pending } = await readGateLedger(op, opts);
      return { resolutions, pending };
    },
    async appendPending(input) {
      const { record } = await appendPendingGate(input, opts);
      try {
        const pushed = await pushLifecycle(opts);
        return pushed
          ? { record, pushed }
          : {
              record,
              pushed,
              pushWarning:
                "no remote is configured for chant/lifecycle — the pending fact was recorded locally only",
            };
      } catch (err) {
        return {
          record,
          pushed: false,
          pushWarning: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/** A gate ledger held in memory — what a test, or a caller that has already read the ledger, hands {@link evaluateGate}. */
export function memoryGateLedgerPort(
  seed: { resolutions?: GateResolutionRecord[]; pending?: PendingGateRecord[] } = {},
): GateLedgerPort & { appended: PendingGateRecord[] } {
  const resolutions = [...(seed.resolutions ?? [])];
  const pending = [...(seed.pending ?? [])];
  const appended: PendingGateRecord[] = [];
  return {
    appended,
    async read() {
      return { resolutions: [...resolutions], pending: [...pending] };
    },
    async appendPending(input) {
      const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
      pending.push(record);
      appended.push(record);
      // No remote in an in-memory ledger — there is nothing to fail to reach.
      return { record, pushed: true };
    },
  };
}

/** What a caller has to say about the gate it just reached. */
export interface GateCheckInput {
  /** The op the gate belongs to — the component's name, on the driver. */
  op: string;
  /** The gate's signal name. */
  gate: string;
  description?: string;
  /** The gate's authored `timeout`, which becomes the pending fact's expiry. Default {@link DEFAULT_GATE_EXPIRY}. */
  timeout?: string;
  /** Identifies the run that reached the gate, when the caller has one. */
  runId?: string;
  /** ISO-8601 "now" — supplied by the caller, so the decision is deterministic under test. */
  now?: string;
}

/** Either the gate is answered, or it is a standing fact. */
export type GateCheck =
  | { satisfied: true; resolution: GateResolutionRecord }
  | {
      satisfied: false;
      pending: PendingGateRecord;
      recorded: boolean;
      /**
       * Whether this run's own append reached the remote — set only when
       * `recorded` is true. A gate left standing from an earlier run pushed
       * (or didn't) on that run; this one wrote nothing, so it has nothing
       * new to report (#2310).
       */
      pushed?: boolean;
      /** Set when `pushed` is false. */
      pushWarning?: string;
    };

/** The beginning of time — the anchor for a gate that has never been recorded pending, so any resolution for it counts. */
const EPOCH = new Date(0).toISOString();

/**
 * Decide a gate against the ledger, recording the pending fact when it isn't
 * answered.
 *
 * - A resolution newer than the newest pending fact satisfies the gate.
 * - Otherwise, a pending fact that hasn't expired stands as it is: the run
 *   ends `gated` and the ledger is left alone, so an operator ticking every
 *   minute against an unapproved gate does not append a line a minute.
 * - Otherwise (no pending fact, or the newest one has expired) a fresh pending
 *   fact is appended and the run ends `gated`. `recorded` says which of the
 *   two happened, so a renderer can tell "just recorded" from "still standing".
 */
export async function evaluateGate(port: GateLedgerPort, input: GateCheckInput): Promise<GateCheck> {
  const now = input.now ?? new Date().toISOString();
  const { resolutions, pending } = await port.read(input.op);

  const standing = latestPendingGate(pending, input.gate);
  const resolution = latestResolutionSince(resolutions, input.gate, standing?.timestamp ?? EPOCH);
  if (resolution) return { satisfied: true, resolution };

  if (standing && !isPendingGateExpired(standing, now)) {
    return { satisfied: false, pending: standing, recorded: false };
  }

  const url = resolveApprovalUrl();
  const { record, pushed, pushWarning } = await port.appendPending({
    op: input.op,
    gate: input.gate,
    timestamp: now,
    expiresAt: new Date(
      new Date(now).getTime() + parseDuration(input.timeout ?? DEFAULT_GATE_EXPIRY),
    ).toISOString(),
    ...(input.description ? { description: input.description } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(url ? { url } : {}),
  });
  return {
    satisfied: false,
    pending: record,
    recorded: true,
    pushed,
    ...(pushWarning ? { pushWarning } : {}),
  };
}

/** The line every renderer prints to say how a pending gate is cleared. */
export function approveCommand(op: string, gate: string): string {
  return `chant approve ${op} ${gate}`;
}
