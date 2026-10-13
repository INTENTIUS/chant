/**
 * A run that records nothing on `chant/lifecycle` (#3955): `chant run
 * --no-record`, or `CHANT_NO_RECORD=1` in the environment.
 *
 * Test and claim runs used to leave real records on the ledger and push them
 * to origin, because every write path in `./git.ts` appends and pushes. In
 * this mode the run still executes every step, and every ledger write still
 * builds its commit, but the commit goes onto an in-memory tip instead of the
 * branch ref:
 *
 * - `refs/heads/chant/lifecycle` is never updated, so the branch is exactly
 *   what it was before the run.
 * - Nothing is pushed: neither the ledger branch nor a lease ref.
 * - Reads in the same process see the run's own writes, so a step that reads
 *   back what an earlier step wrote (an effect receipt, a work lease) behaves
 *   as it would in a recorded run. The tip is dropped when the process exits.
 *
 * A gate cannot be passed in this mode ({@link GateNotRecordableError}). An
 * approval lives on the ledger, and passing a gate spends it: a run that
 * passed a gate here would apply under an approval while leaving it unspent
 * for the next run, and a pending fact it wrote could never be approved.
 *
 * The state is per process and keyed by the repository's git directory, so a
 * workspace member and the root share one tip. A child `chant` process gets
 * the mode through the environment and keeps its own tip.
 *
 * Kept free of git and the runtime adapter so the gate deciders and the run
 * renderers can import it without loading `./git.ts`.
 */

/** The environment variable that turns recording off for every chant process that inherits it. */
export const NO_RECORD_ENV = "CHANT_NO_RECORD";

/** Whether this process records nothing on `chant/lifecycle`: `CHANT_NO_RECORD` set to anything but empty, `0` or `false`. */
export function ledgerRecordingOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[NO_RECORD_ENV]?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/** The line a run prints before its first step when it records nothing. `source` is what turned recording off. */
export function noRecordStartNote(source: string): string {
  return `not recording (${source}): nothing this run writes goes on chant/lifecycle, and nothing is pushed. A gate step fails.`;
}

/** The push warning a ledger write reports in this mode, in place of a push. */
export const NO_RECORD_PUSH_NOTE = "not recorded (--no-record): chant/lifecycle was not written or pushed";

/** What the in-memory ledger holds for one repository: its tip, and the files written to it. */
interface Overlay {
  tip: string | null;
  writes: { path: string; message: string }[];
}

const overlays = new Map<string, Overlay>();

/** The tip this process's writes have built for the repository at `key`, or `undefined` before its first write. */
export function overlayTip(key: string): string | null | undefined {
  return overlays.get(key)?.tip;
}

/** Move the in-memory tip for `key` to `commit`, noting what the commit wrote. */
export function setOverlayTip(key: string, commit: string, paths: readonly string[], message: string): void {
  const overlay = overlays.get(key) ?? { tip: null, writes: [] };
  overlay.tip = commit;
  for (const path of paths) overlay.writes.push({ path, message });
  overlays.set(key, overlay);
}

/** Every ledger file this process wrote and did not record, in write order, across repositories. */
export function unrecordedWrites(): { path: string; message: string }[] {
  return [...overlays.values()].flatMap((o) => o.writes);
}

/** The line a run prints after its last step: that nothing was recorded, and how many ledger writes it dropped. */
export function noRecordEndNote(source: string): string {
  const writes = unrecordedWrites();
  const files = new Set(writes.map((w) => w.path)).size;
  const dropped =
    writes.length === 0
      ? "the run made no ledger writes"
      : `${writes.length} ledger write${writes.length === 1 ? " was" : "s were"} dropped (${files} file${files === 1 ? "" : "s"})`;
  return `not recorded (${source}): nothing went on chant/lifecycle and nothing was pushed; ${dropped}.`;
}

/** Forget every in-memory tip. For tests, and for an in-process caller that runs twice. */
export function resetNoRecordLedger(): void {
  overlays.clear();
}

/** Thrown when a run that records nothing reaches a gate. The executor turns it into a failing gate step. */
export class GateNotRecordableError extends Error {
  constructor(
    public readonly op: string,
    public readonly gate: string,
  ) {
    super(
      `gate "${gate}" of "${op}" cannot be passed under --no-record: a gate is decided and approved on ` +
        "chant/lifecycle, which this run does not write. " +
        "Run without --no-record (and without CHANT_NO_RECORD) to stop at the gate for approval.",
    );
    this.name = "GateNotRecordableError";
  }
}

/** Throw {@link GateNotRecordableError} when recording is off. Called by every gate decider before it reads the ledger. */
export function refuseGateWithoutRecording(op: string, gate: string): void {
  if (ledgerRecordingOff()) throw new GateNotRecordableError(op, gate);
}
