/**
 * Stored change sets (#4022): each change-set document a gate binds, kept on
 * `chant/lifecycle` under its digest so the plan an approval bound can be read
 * once the run that planned it is gone.
 *
 * A pull-request gate, a release gate and an `empty` resolution (ws-104
 * question 2 and 6) bind the change-set document's `digest`
 * (`../change-set.ts`) in `planDigest`. Only that value reaches the gate
 * ledger, so this store keeps the document beside it:
 *
 *   _change-sets/<digest>.json    the document, written once and never rewritten
 *
 * `:` is written as `_` in the file name, as `_plans/`, `_builds/` and
 * `_releases/` do. A workspace member's copy sits under
 * `_members/<member>/_change-sets/` through the same `ledgerDir` prefix the
 * gate ledger uses, so a gate and its change set are read from one member.
 *
 * The stored document is the one the gate bound, with each entry's graph
 * `node` (`../change-set-graph.ts`) and the `graph` it came from. Neither is
 * hashed, so the stored document still verifies against its digest. A
 * component gate in a plain `run --components` binds a lifecycle-plan digest
 * and stores nothing here.
 *
 * `chant lifecycle gc` removes a stored change set from the branch's tree
 * once #4036's retention policy lets it go (./retention.ts); history keeps it.
 */

import { sortedJsonReplacer } from "../utils";
import { CHANGE_SET_CONTRACT, CHANGE_SET_SCHEMA_ID, verifyChangeSetDigest, type ChangeSetDocument } from "../change-set";
import { ledgerDir, readBlobFromPath, readPathSha, RefCASConflictError, writeLedgerFiles, type LedgerLocation } from "./git";

/** The directory on `chant/lifecycle` that holds stored change sets. */
export const CHANGE_SETS_DIR = "_change-sets";

/** The file a change set with `digest` is stored in, inside {@link CHANGE_SETS_DIR}. */
export function changeSetFile(digest: string): string {
  return `${digest.replace(/:/g, "_")}.json`;
}

/** Thrown when a document can't be stored: it is not a change-set document, or its content does not hash to its digest. */
export class ChangeSetStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeSetStoreError";
  }
}

/**
 * Store a change-set document under its digest. A document already stored
 * under the digest is never rewritten. Refuses a document whose content does
 * not hash to its own `digest`. Does not push: call `pushLifecycleReport`
 * (./git.ts) after, or let the gate's own pending fact push it.
 */
export async function persistChangeSet(
  doc: ChangeSetDocument,
  opts?: { cwd?: string },
): Promise<{ commit: string | null; written: boolean }> {
  if (doc?.$schema !== CHANGE_SET_SCHEMA_ID || doc.contract !== CHANGE_SET_CONTRACT) {
    throw new ChangeSetStoreError(`not a change-set document: its $schema is not ${CHANGE_SET_SCHEMA_ID} with contract ${CHANGE_SET_CONTRACT}`);
  }
  if (!verifyChangeSetDigest(doc)) {
    throw new ChangeSetStoreError(`change set ${doc.digest} does not hash to its own digest; refusing to store it`);
  }
  const file = changeSetFile(doc.digest);
  if ((await readPathSha(CHANGE_SETS_DIR, file, opts)) !== null) return { commit: null, written: false };
  const dir = await ledgerDir(CHANGE_SETS_DIR, opts);
  try {
    const commit = await writeLedgerFiles(
      [{ path: `${dir}/${file}`, content: `${JSON.stringify(doc, sortedJsonReplacer)}\n`, expectPriorSha: null }],
      `Change set ${doc.digest}`,
      opts,
    );
    return { commit, written: true };
  } catch (err) {
    // Another writer stored the same digest first; what is there is the same document.
    if (err instanceof RefCASConflictError) return { commit: null, written: false };
    throw err;
  }
}

/** What reading one stored change set found. */
export type StoredChangeSetRead =
  | { status: "found"; document: ChangeSetDocument }
  | { status: "missing" }
  /** A file is stored under the digest, and it is not a change-set document whose content hashes to that digest. */
  | { status: "malformed"; message: string };

/** Parse a stored file, checking it is the document `digest` names. */
export function parseStoredChangeSet(text: string, digest: string): StoredChangeSetRead {
  let doc: ChangeSetDocument;
  try {
    doc = JSON.parse(text) as ChangeSetDocument;
  } catch (err) {
    return { status: "malformed", message: `the file stored under ${digest} is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc || typeof doc !== "object" || doc.$schema !== CHANGE_SET_SCHEMA_ID || doc.contract !== CHANGE_SET_CONTRACT || !Array.isArray(doc.entries) || !Array.isArray(doc.members)) {
    return { status: "malformed", message: `the file stored under ${digest} is not a change-set document` };
  }
  if (doc.digest !== digest || !verifyChangeSetDigest(doc)) {
    return { status: "malformed", message: `the change set stored under ${digest} does not hash to that digest` };
  }
  return { status: "found", document: doc };
}

/**
 * Read the change set stored under `digest`. Reads the local `chant/lifecycle`
 * branch and never fetches. Throws only when git itself fails.
 */
export async function readStoredChangeSet(digest: string, opts?: LedgerLocation): Promise<StoredChangeSetRead> {
  const text = await readBlobFromPath(CHANGE_SETS_DIR, changeSetFile(digest), opts);
  if (text === null) return { status: "missing" };
  return parseStoredChangeSet(text, digest);
}
