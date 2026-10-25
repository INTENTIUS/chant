/**
 * choudoufu's live-plan omission codes, in chant's vocabulary.
 *
 * Its own module so the observation reader (`./describe-resources.ts`) and
 * the drift adapters (`./drift-record.ts`) read one table, and the drift
 * adapters bundle without the reader's process and file-system imports.
 */

import type { UnobservedReason } from "@intentius/chant/observation";

/**
 * choudoufu's omission reason codes, mapped onto chant's total vocabulary
 * (`internal/live/projection/result.go`). `"absent"` is not an
 * {@link UnobservedReason}: it is the tri-state's OBSERVED-ABSENT, the one
 * omission that is a claim of knowledge rather than of ignorance.
 *
 * A code this table does not know maps to `read-failed`, which is the safe
 * direction: no NOT-OBSERVED verdict ever becomes a create or a delete.
 */
export const LIVE_PLAN_OMISSION_REASONS: Readonly<Record<string, UnobservedReason | "absent">> = {
  // The provider was asked and reported, normally, that nothing is there.
  ABSENT: "absent",
  // The provider errored, or could not be reached in a usable order.
  FAILED: "read-failed",
  PARENT_UNAVAILABLE: "read-failed",
  CYCLE: "read-failed",
  INCOMPLETE_BLOCK: "read-failed",
  LISTED_NOT_IMPORTABLE: "read-failed",
  // Something exists at the identity and does not carry this estate's marker.
  // Normally answered by the `unowned[]` section before this table is read;
  // this entry is what happens if a document ever carries the omission alone.
  UNOWNED: "read-failed",
  // The mode cannot name, list or tag this instance at all: a server-assigned
  // identity with no marker to find it by, a resource with no cloud object to
  // read, or an address another declared instance has taken over.
  NEEDS_DISCOVERY: "unsupported-kind",
  UNREADABLE: "unsupported-kind",
  SUPERSEDED: "unsupported-kind",
  // The run's own tag index saw an object at the identity and the import
  // read could not confirm it (choudoufu #1043). The read failed; the
  // object is not proposed for creation.
  VERIFIED_NOT_IMPORTABLE: "read-failed",
  // -target or -exclude left the block out of the plan graph (choudoufu
  // #1176): nothing was read because the caller asked for it not to be.
  OUT_OF_SCOPE: "filtered",
};

/** Does this text name a credentials or authorization failure rather than any other error? */
export function readsAsCredentials(text: string): boolean {
  return /\b(no valid credential|credentials?|not authorized|unauthorized|accessdenied|access denied|expiredtoken|invalidclienttokenid|signature)\b/i.test(
    text,
  );
}

