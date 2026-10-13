/**
 * The commit that decided a record: the commit reachable from a revision that
 * last moved the record's file into an approved state and kept it there. A
 * record added in an approved state was decided by the commit that added it.
 *
 * "Approved" is `isDecided` from `work.ts`: a state the kind's `approval`
 * ranks above 0, or, for a kind with no `approval`, one of its
 * `closedStates`. For the decision kind that is decided, ratified and
 * superseded, and not proposed or withdrawn. Walking the file's history
 * newest first, the commit is the oldest one in the unbroken run of approved
 * versions that ends at the revision: a record decided, then ratified, keeps
 * the commit that decided it, and one withdrawn and decided again gets the
 * second decision.
 *
 * The intent graph's windows open here (`intent.ts`): a commit made while a
 * record was only proposed is not in its window. A record that is not
 * approved at the revision has no deciding commit, and its window opens at
 * the commit that added it, as it always did.
 *
 * History is read with two git processes for any number of records: one
 * `git log` over their paths and one `git cat-file --batch` for the versions.
 */

import { execFileSync } from "node:child_process";
import { parseRecord, type LoadedRecordKind } from "./records";
import { isDecided } from "./work";

export interface DecidedIn {
  sha: string;
  /** The author date, ISO 8601. */
  date: string;
  subject: string;
}

function tryGit(top: string, args: string[], input?: string): Buffer | undefined {
  try {
    return execFileSync("git", args, { cwd: top, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** Each `sha:path` blob's text, or undefined when git has none. */
function blobs(top: string, names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (names.length === 0) return out;
  const buf = tryGit(top, ["cat-file", "--batch"], `${names.join("\n")}\n`);
  if (!buf) return out;
  let at = 0;
  for (const name of names) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString("utf-8");
    at = nl + 1;
    const m = header.match(/^[0-9a-f]+ (\w+) (\d+)$/);
    if (!m) continue; // "<name> missing"
    const size = Number(m[2]);
    if (m[1] === "blob") out.set(name, buf.subarray(at, at + size).toString("utf-8"));
    at += size + 1;
  }
  return out;
}

/**
 * For each record path (from the repository root), the commit reachable from
 * `rev` that decided it, or null when the record is not approved at `rev` or
 * has no history there.
 */
export function decidedCommits(top: string, rev: string, paths: string[], kind: LoadedRecordKind["kind"]): Map<string, DecidedIn | null> {
  const out = new Map<string, DecidedIn | null>(paths.map((p) => [p, null]));
  const stateField = kind.stateField;
  if (!stateField || paths.length === 0) return out;
  const log = tryGit(top, ["log", "--no-renames", "--format=%x00%H%x1f%aI%x1f%s", "--name-only", rev, "--", ...paths])?.toString("utf-8");
  if (log === undefined) return out;
  const wanted = new Set(paths);
  const commits = new Map<string, { date: string; subject: string }>();
  /** Each path's commits, newest first. */
  const history = new Map<string, string[]>();
  for (const chunk of log.split("\0")) {
    if (!chunk) continue;
    const nl = chunk.indexOf("\n");
    const [sha, date, subject] = (nl < 0 ? chunk : chunk.slice(0, nl)).split("\x1f");
    commits.set(sha, { date, subject });
    for (const f of (nl < 0 ? "" : chunk.slice(nl + 1)).split("\n")) {
      if (!wanted.has(f)) continue;
      const list = history.get(f) ?? [];
      list.push(sha);
      history.set(f, list);
    }
  }
  const texts = blobs(
    top,
    [...history].flatMap(([p, shas]) => shas.map((s) => `${s}:${p}`)),
  );
  for (const [path, shas] of history) {
    let decided: string | null = null;
    for (const sha of shas) {
      const text = texts.get(`${sha}:${path}`);
      const fm = text === undefined ? undefined : parseRecord(kind.format, text);
      const state = fm?.ok ? fm.value[stateField] : undefined;
      if (typeof state !== "string" || !isDecided(kind, state)) break;
      decided = sha;
    }
    if (decided) out.set(path, { sha: decided, ...commits.get(decided)! });
  }
  return out;
}
