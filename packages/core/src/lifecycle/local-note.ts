/**
 * What a ledger write shows when the checkout has no remote (#3677), kept
 * apart from `./git.ts` so the run renderers can name it without loading git.
 */

/**
 * The line a write shows when this checkout has no remote for the ledger.
 * Nothing went wrong: the record is in the local branch, and with no remote
 * the person who will approve or read it is the one at this machine. A
 * renderer prints it as a note, never as a warning ({@link isLifecycleLocalNote}).
 */
export const LIFECYCLE_LOCAL_NOTE = "recorded locally (no remote for chant/lifecycle)";

/** Whether a push warning is {@link LIFECYCLE_LOCAL_NOTE}: no remote, rather than a push that failed. */
export function isLifecycleLocalNote(warning: string | undefined): boolean {
  return warning === LIFECYCLE_LOCAL_NOTE;
}
