/**
 * Finding review-session kinds and the commits a session names (#2693), for
 * the commands that act on a session by its id: `records review --session`,
 * `records close` and `records --since <session id>`.
 *
 * A session kind is found through the workspace declaration nearest above
 * the working directory, or named directly. Nothing here writes.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { WorkspaceReadError } from "./declaration";
import { gitRoot, resolveRevision } from "./record-source";
import { loadRecordKind, RecordReadError, type LoadedRecordKind } from "./records";
import { declaredKindFiles, realpathOr } from "./records-cli";

/** The shape of an id `records --since` looks up as a session before reading it as a revision: `S-0002`, `ws-052`. */
export const SESSION_ID = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;

/**
 * Every session kind among `extra` (kind files, resolved against `cwd`) and
 * the kinds the declaration nearest above `cwd` names, each once, in that
 * order. A kind that can't be loaded, or a declaration that can't be read,
 * adds nothing: the read of that kind reports it.
 */
export async function findSessionKinds(cwd: string, extra: string[] = []): Promise<LoadedRecordKind[]> {
  const files = [...extra.map((f) => resolve(cwd, f))];
  try {
    files.push(...declaredKindFiles(cwd).map((k) => k.file));
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
  }
  const seen = new Set<string>();
  const out: LoadedRecordKind[] = [];
  for (const f of files) {
    const real = realpathOr(f);
    if (seen.has(real)) continue;
    seen.add(real);
    try {
      const loaded = await loadRecordKind(f, cwd);
      if (loaded.kind.session) out.push(loaded);
    } catch (err) {
      if (!(err instanceof RecordReadError)) throw err;
    }
  }
  return out;
}

/** The session kinds whose `session.subjects.kind` is the kind file `subjectFile`. */
export async function sessionKindsFor(subjectFile: string, cwd: string): Promise<LoadedRecordKind[]> {
  const target = realpathOr(resolve(cwd, subjectFile));
  return (await findSessionKinds(cwd)).filter((k) => realpathOr(resolve(dirname(k.file), k.kind.session!.subjects.kind)) === target);
}

/** The full commit id HEAD names in the repository holding `dir`, or null outside git or before the first commit. */
export function headCommit(dir: string): string | null {
  const top = gitRoot(realpathOr(dir));
  if (!top) return null;
  try {
    return resolveRevision(top, "HEAD");
  } catch (err) {
    if (err instanceof RecordReadError) return null;
    throw err;
  }
}

/**
 * Commit ids from `git log <args> --format=%H -- <path>` in the repository at
 * `top`, newest first; empty when git knows nothing of the path.
 */
export function commitsTouching(top: string, path: string, args: string[]): string[] {
  try {
    return execFileSync("git", ["log", ...args, "--format=%H", "--", path], { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}
