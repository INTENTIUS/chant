/**
 * Where records are read from. Only the working tree so far; reading a
 * commit's git objects (`--at <rev>`) is #2536's slice.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RecordSource {
  /** Appended to messages to say where the records were read. Empty for the working tree. */
  label: string;
  /** File names directly inside `dir` (relative to the root, `/`-separated), or undefined when `dir` is missing. */
  list(dir: string): string[] | undefined;
  /** The text of a file listed by `list`. */
  read(path: string): string;
}

/** Records in the working tree under `root`. */
export function workingTreeSource(root: string): RecordSource {
  return {
    label: "",
    list(dir) {
      try {
        return readdirSync(join(root, dir), { withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => d.name);
      } catch {
        return undefined;
      }
    },
    read(path) {
      return readFileSync(join(root, path), "utf-8");
    },
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The top of the git repository holding `cwd`, or undefined outside one. */
export function gitRoot(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return undefined;
  }
}
