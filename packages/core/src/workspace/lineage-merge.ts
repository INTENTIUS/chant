/**
 * The three-way merge of one file (#2550, ws-005).
 *
 * ws-005 merges per file: a customised file takes the template's changes only
 * when every hunk merges cleanly. Otherwise the file stays as it was and the
 * upgrade records one manual step for it. So this answers with the merged
 * bytes or with null, never with conflict markers.
 *
 * The merge is `git merge-file`, run on three scratch files. It reads no
 * repository and reaches no network. A binary file never merges.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Merge `theirs` into `ours` against `base`. Null when any hunk conflicts, or the file is binary. */
export function mergeFile(base: Buffer, ours: Buffer, theirs: Buffer): Buffer | null {
  if ([base, ours, theirs].some(isBinary)) return null;
  const dir = mkdtempSync(join(tmpdir(), "chant-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(dir, n));
    writeFileSync(o, ours);
    writeFileSync(b, base);
    writeFileSync(t, theirs);
    try {
      // Exit 0: merged cleanly. A positive exit is the number of conflicts.
      execFileSync("git", ["merge-file", "-q", o, b, t], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (typeof status === "number" && status > 0 && status < 128) return null;
      throw err;
    }
    return readFileSync(o);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Git's own test: a NUL byte in the first 8000 bytes. */
function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0);
}
