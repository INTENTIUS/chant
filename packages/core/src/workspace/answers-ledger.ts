/**
 * Answer records held on the lifecycle ledger (#2786).
 *
 * A steward's writes never touch the checkout's index or working tree
 * (`../op/steward.ts`): the working tree is the coding agent's. A decision
 * point asked in a steward's turn still has to leave its question somewhere a
 * person finds it after the turn ends, and an Op's leased worktree is removed
 * with the run. So a question asked in a steward's turn is written to
 * `chant/lifecycle`, beside the lease histories and run records, under
 * `_answers/<kind name>/<id>.md` in the ledger of the member that owns the
 * answer kind. The file is the same Markdown record the kind's directory
 * would hold, and it is written with git plumbing, like every ledger write.
 *
 * Readers see the ledger's answers as if they sat in the kind's directory:
 * {@link withLedgerAnswers} lays them over the working tree, so `points`,
 * `points --open`, a later `points ask` of the same question and `points
 * answer` all find them. A record on the ledger wins over a file of the same
 * name in the tree, because the ledger copy is the one a steward rewrote.
 * People's answer to a question held on the ledger is written back there, so
 * answering through hud in a box does not touch the checkout either.
 *
 * `points --at <rev>` reads a revision of the working branch, which the
 * ledger is not part of, so it lists the tree's records only.
 */

import { basename, dirname } from "node:path";
import { fetchLifecycleStatus, ledgerDir, listFilesInDir, pushLifecycle, readBlobBySha, readPathSha, writeBlobToPath } from "../lifecycle/git";
import type { RecordSource } from "./record-source";
import { overlay } from "./records-write";

/** The directory on `chant/lifecycle`, under the member's prefix, that holds answer records. */
export const ANSWERS_LEDGER_DIR = "_answers";

const BRANCH = "chant/lifecycle";

/** One answer record on the ledger. */
export interface LedgerAnswer {
  /** Where the record reads as being: the kind's directory, from the repository root. */
  path: string;
  /** Where it is: `chant/lifecycle:<path on the branch>`, which `git show` reads. */
  ledger: string;
  text: string;
  /** Its blob sha, for a compare-and-set rewrite. */
  sha: string;
}

/** The answer records one kind holds on the ledger. */
export interface LedgerAnswers {
  /** Where the ledger is resolved from: the kind file's directory, so the member owning the kind owns its answers. */
  cwd: string;
  /** The directory on the branch, relative to the member's prefix. */
  dir: string;
  /** The kind's records directory, from the repository root. */
  dirRel: string;
  /** By the path each record reads as. */
  byPath: Map<string, LedgerAnswer>;
}

/** The ledger directory of the kind named `kindName`. */
export function answersLedgerDir(kindName: string): string {
  return `${ANSWERS_LEDGER_DIR}/${kindName.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

function treePath(dirRel: string, name: string): string {
  return dirRel === "." ? name : `${dirRel}/${name}`;
}

/**
 * Read the answer records the kind at `kindFile` holds on the ledger. Empty
 * when there are none, when there is no ledger branch, and outside a git
 * repository.
 */
export async function readLedgerAnswers(kind: { file: string; name: string; dirRel: string }): Promise<LedgerAnswers> {
  const cwd = dirname(kind.file);
  const dir = answersLedgerDir(kind.name);
  const out: LedgerAnswers = { cwd, dir, dirRel: kind.dirRel, byPath: new Map() };
  try {
    const names = (await listFilesInDir(dir, { cwd })).filter((n) => n.endsWith(".md"));
    if (names.length === 0) return out;
    const full = await ledgerDir(dir, { cwd });
    for (const name of names) {
      const sha = await readPathSha(dir, name, { cwd });
      const text = sha ? await readBlobBySha(sha, { cwd }) : null;
      if (sha === null || text === null) continue;
      const path = treePath(kind.dirRel, name);
      out.byPath.set(path, { path, ledger: `${BRANCH}:${full}/${name}`, text, sha });
    }
  } catch {
    // No repository, or a member ledger that can't be placed: the tree's records are all there is.
  }
  return out;
}

/** `base` with each ledger answer at the path it reads as, over any file of the same name. */
export function withLedgerAnswers(base: RecordSource, answers: LedgerAnswers): RecordSource {
  let source = base;
  for (const a of answers.byPath.values()) source = overlay(source, a.path, a.text);
  return source;
}

/** Fetch `chant/lifecycle` before a ledger write when it fast-forwards, so a question another clone asked is found. Best effort. */
export async function refreshLedger(kindFile: string): Promise<void> {
  await fetchLifecycleStatus({ cwd: dirname(kindFile) }).catch(() => undefined);
}

/**
 * Write the record read as `path` to the ledger, expecting the blob it had
 * when it was read (`prior`, null for a new record), then push the branch.
 * A changed blob throws `RefCASConflictError` from `../lifecycle/git`. The
 * push is best effort: a question that did not reach the remote is still
 * open here. Returns where the record went.
 */
export async function writeLedgerAnswer(answers: LedgerAnswers, path: string, text: string, message: string, prior: string | null): Promise<{ ledger: string; pushed: boolean }> {
  const name = basename(path);
  await writeBlobToPath(answers.dir, name, text, message, { cwd: answers.cwd, expectPriorPathSha: prior });
  const pushed = await pushLifecycle({ cwd: answers.cwd }).catch(() => false);
  return { ledger: `${BRANCH}:${await ledgerDir(answers.dir, { cwd: answers.cwd })}/${name}`, pushed };
}
