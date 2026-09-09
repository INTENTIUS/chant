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
import { pushLifecycle, requireLifecycleLedgerReadable } from "../lifecycle/git";
import { parseDuration } from "./duration";

/** The gate ledger, as the two executors need it: read both kinds of line, append a pending fact. */
export interface GateLedgerPort {
  read(op: string): Promise<{ resolutions: GateResolutionRecord[]; pending: PendingGateRecord[] }>;
  appendPending(input: PendingGateInput): Promise<PendingGateRecord>;
}

/**
 * The real port: the `chant/lifecycle` orphan branch. Pushes best-effort after
 * appending, the same two-step-collapsed-into-one shape `chant approve` uses
 * (`../cli/handlers/operator.ts` calls `pushLifecycle().catch(...)` right after
 * its append) — a pending fact that only ever reaches the local branch is still
 * a correct local answer, so a missing remote never fails the run.
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
      // it; see `requireLifecycleLedgerReadable`.
      await requireLifecycleLedgerReadable(opts);
      const { resolutions, pending } = await readGateLedger(op, opts);
      return { resolutions, pending };
    },
    async appendPending(input) {
      const { record } = await appendPendingGate(input, opts);
      await pushLifecycle(opts).catch(() => undefined);
      return record;
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
      return record;
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
  | { satisfied: false; pending: PendingGateRecord; recorded: boolean };

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
  const record = await port.appendPending({
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
  return { satisfied: false, pending: record, recorded: true };
}

/** The line every renderer prints to say how a pending gate is cleared. */
export function approveCommand(op: string, gate: string): string {
  return `chant approve ${op} ${gate}`;
}
