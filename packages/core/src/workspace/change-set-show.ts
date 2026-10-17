/**
 * The stored change-set read (#4022): `chant change-set show <digest> --json`.
 *
 * Prints the change-set document a gate bound, as `components pr-apply`
 * stored it, or as a release gate stores it with #4045
 * (`../lifecycle/change-set-store.ts`). Each entry carries the graph `node`
 * it changes, as `chant workspace graph` names nodes. It reads the local
 * `chant/lifecycle` branch and never fetches.
 *
 * A digest with nothing stored under it is a result with `changeSet: null`,
 * since a component gate binds a lifecycle-plan digest and stores no
 * document. A stored file that is not the document its digest names is also
 * `changeSet: null`, with the reason `ledger-malformed`. A read that fails
 * outright is the failure `ledger-unreadable`.
 */

import { execFileSync } from "node:child_process";
import type { ChangeSetDocument } from "../change-set";
import { readStoredChangeSet } from "../lifecycle/change-set-store";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { readerVersion } from "./declaration";

export const CHANGE_SET_SHOW_CONTRACT_VERSION = 1;
export const CHANGE_SET_SHOW_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/change-set-show/v1/change-set-show.schema.json";

/** Why the read stopped. Closed; each code is in `reason-codes.ts`. */
export const CHANGE_SET_SHOW_ERROR_CODES = ["not-a-git-repository", "ledger-unreadable"] as const;
/** Why a stored file was not shown. */
export const CHANGE_SET_SHOW_REASON_CODES = ["ledger-malformed"] as const;

/** What a change-set digest looks like: a plan digest's form. */
export const CHANGE_SET_DIGEST_PATTERN = /^(?:jcs1-)?sha256:[0-9a-f]{64}$/;

export type ChangeSetShowDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      /** The member whose ledger was read, its path of names joined with `/`, or null outside a workspace. */
      member: string | null;
      digest: string;
      /** The stored document, or null when none is stored under the digest. */
      changeSet: ChangeSetDocument | null;
      reason: { code: (typeof CHANGE_SET_SHOW_REASON_CODES)[number]; message: string } | null;
    }
  | { $schema: string; contract: number; chant: string; error: { code: (typeof CHANGE_SET_SHOW_ERROR_CODES)[number]; message: string } };

/**
 * Read the change set stored under `digest` in the ledger of the member at
 * `cwd`, or of `member` (its path of names, outermost first) when given.
 */
export async function changeSetShowDocument(req: { cwd: string; digest: string; member?: readonly string[] }): Promise<ChangeSetShowDocument> {
  const head = { $schema: CHANGE_SET_SHOW_SCHEMA_ID, contract: CHANGE_SET_SHOW_CONTRACT_VERSION, chant: readerVersion() };
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: req.cwd, stdio: "ignore" });
  } catch {
    return { ...head, error: { code: "not-a-git-repository", message: "change sets are read from the chant/lifecycle branch, and this directory is not in a git repository" } };
  }
  try {
    const members = req.member ? [...req.member] : (await resolveMemberLedger(req.cwd)).members;
    const read = await readStoredChangeSet(req.digest, { cwd: req.cwd, member: members });
    return {
      ...head,
      member: members.length > 0 ? members.join("/") : null,
      digest: req.digest,
      changeSet: read.status === "found" ? read.document : null,
      reason: read.status === "malformed" ? { code: "ledger-malformed", message: read.message } : null,
    };
  } catch (err) {
    return { ...head, error: { code: "ledger-unreadable", message: `reading the change set failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
}
