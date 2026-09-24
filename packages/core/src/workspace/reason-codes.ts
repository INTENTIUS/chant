/**
 * The workspace read contract's closed list of reason codes (#2536, #2524
 * D15, ws-017, ws-020).
 *
 * Every code a `chant workspace` read prints is here: the error that stops a
 * read, the reason an unreadable member, group, ledger or record is listed
 * with, and the lineage lock findings of `check`. Each command's own list
 * (`WORKSPACE_ERROR_CODES`, `MEMBER_REASON_CODES`, `STATUS_REASON_CODES`,
 * `RECORD_REASON_CODES` and the rest) is a subset of this one, which the
 * compiler checks through `satisfies`. `reason-codes.test.ts` checks that the
 * output schemas and the source emit nothing outside it.
 *
 * The list is closed: a reader may switch on a code, and a new code is a
 * contract change. Within contract version 1, before the floor release, codes
 * may still be added; after it, a new code means a new contract version.
 *
 * `chant workspace check` also reports `WSP` ids. Those are the declaration
 * check catalog (`checks.ts`), a separate closed list, and a finding whose
 * cause is one of the codes here carries that code too.
 */

/** The version of the read contract this chant writes: the declaration format, the output schemas and these codes. */
export const READ_CONTRACT_VERSION = 1;

/** The first chant release that writes contract version 1. A reader that needs the contract refuses an older chant. */
export const READ_CONTRACT_FLOOR = "0.81.0";

/** Each code and what it means. The key order is the order the docs list them in. */
export const REASONS = {
  // Reading the declaration (ls, graph, check, status).
  "declaration-missing": "No chant.workspace.json or .jsonc between the directory and the git root.",
  "declaration-ambiguous": "Both chant.workspace.json and chant.workspace.jsonc exist.",
  "declaration-unparseable": "The declaration is not valid JSON, or not valid JSONC for .jsonc.",
  "declaration-invalid": "The declaration does not match its schema, repeats a name, or --member names no entry.",
  "placement-invalid": "A member or group match breaks a placement rule.",
  "reader-too-old": "The declaration's minReader is newer than the chant reading it.",
  "root-chant-required": "The declaration pins a chant version other than the reader's, and that chant is not installed at the workspace root.",
  // --at and git.
  "not-a-git-repository": "--at, or a ledger read, needs a git repository and there is none.",
  "revision-unknown": "--at names no commit.",
  // status.
  "environment-invalid": "An environment name that can't name a ledger directory.",
  // A member or group that can't be read (ls, graph).
  "dir-missing": "The member's directory does not exist.",
  "unknown-kind": "No built-in kind or pinned package supplies the member's kind.",
  "kind-probe-failed": "The member's directory is not what its kind reads.",
  "no-matches": "An example group matches no directory holding a chant project.",
  // A member graph leaves out (graph, and the other per-member commands).
  "kind-not-run": "The member's kind is one the per-member commands don't run, such as other.",
  "command-failed": "The member's own command exited with a failure.",
  "output-unreadable": "The member's command printed something that isn't the document asked for.",
  "ir-version-unsupported": "The member's IR has a version this chant can't read.",
  // A ledger status can't fully read.
  "ledger-unreadable": "Reading the ledger failed, so nothing from it is listed.",
  "ledger-malformed": "Some lines of the ledger aren't release records; the rest are listed.",
  // A record that isn't valid (records).
  "record-unparseable": "No front matter, a YAML error, or a value outside the JSON subset of YAML.",
  "record-schema-invalid": "The front matter does not match the kind's schema.",
  "record-id-duplicate": "Another record earlier in path order has the same id.",
  "record-supersedes-unknown": "A supersedes link names an id no record has.",
  "record-supersedes-conflict": "A second closed record supersedes a record another one already superseded.",
  // A record that is valid but warned about (records, #2549).
  "asset-drift": "A file the record pins by hash has changed: its bytes no longer hash to the pinned sha256.",
  "asset-missing": "A file the record pins by hash does not exist in the tree read.",
  "asset-stale": "A file the record pins is unchanged at the hash a record it supersedes pinned: the decision changed and the artifact did not follow.",
  "record-supersedes-pending": "A supersedes link from a record whose state is weaker than the record it names, so the link has no effect yet.",
  // A records read that fails (records).
  "kind-unreadable": "The record kind file is missing or could not be imported.",
  "kind-invalid": "The record kind file exports no recordKind, or its shape is wrong.",
  "schema-unreadable": "The schema file the record kind names is missing or is not JSON.",
  "schema-id-mismatch": "The schema's $id differs from the id the record kind names.",
  "schema-invalid": "The record schema itself does not compile.",
  "location-missing": "The records directory does not exist, in the tree or at the revision.",
  // The lineage lock (check).
  "lock-invalid": "The lineage lock can't be read.",
  "manual-step-open": "A scope in the lineage lock has an open manual step.",
} as const;

export type ReasonCode = keyof typeof REASONS;

/** Every code, in the order of {@link REASONS}. */
export const REASON_CODES = Object.keys(REASONS) as ReasonCode[];

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REASONS, value);
}
