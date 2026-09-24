/**
 * Where records are read from: the working tree, or a commit's git objects
 * (`--at <rev>`, #2536). Reading at a revision needs no checkout and no
 * network; it asks the local git object store only.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RecordReadError } from "./records";

export interface RecordSource {
  /** Appended to messages, such as " at 91c7547e". Empty for the working tree. */
  label: string;
  /** File names directly inside `dir` (relative to the root, `/`-separated), or undefined when `dir` is missing. */
  list(dir: string): string[] | undefined;
  /** The text of a file listed by `list`. */
  read(path: string): string;
  /** The bytes of a file listed by `list`, for a content-addressed id (ws-053). */
  bytes(path: string): Uint8Array;
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
    bytes(path) {
      return readFileSync(join(root, path));
    },
  };
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The top of the git repository holding `cwd`, or undefined outside one. */
export function gitRoot(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return undefined;
  }
}

/** The full commit id `rev` names in the repository at `root`. */
export function resolveRevision(root: string, rev: string): string {
  if (rev.startsWith("-")) throw new RecordReadError("revision-unknown", `--at ${rev} is not a revision`);
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim();
  } catch {
    throw new RecordReadError("revision-unknown", `--at ${rev} names no commit in this repository`);
  }
}

/** Records as they were at `commit`, read from the object store of the repository at `root`. */
export function gitRevisionSource(root: string, commit: string): RecordSource {
  const blobs = new Map<string, Buffer>();
  const blob = (path: string): Buffer => {
    const bytes = blobs.get(path);
    if (bytes === undefined) throw new Error(`${path} was not listed at ${commit}`);
    return bytes;
  };
  return {
    label: ` at ${commit.slice(0, 8)}`,
    list(dir) {
      const treeish = dir === "." ? `${commit}^{tree}` : `${commit}:${dir}`;
      try {
        if (git(root, ["cat-file", "-t", treeish]).trim() !== "tree") return undefined;
      } catch {
        return undefined;
      }
      const entries = git(root, ["ls-tree", "-z", treeish])
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          const [, type, oid] = line.slice(0, tab).split(" ");
          return { type, oid, name: line.slice(tab + 1) };
        })
        .filter((e) => e.type === "blob");
      // One `cat-file --batch` for the whole directory: records are small, and
      // one process beats one per file.
      if (entries.length > 0) {
        const out = Buffer.from(
          execFileSync("git", ["cat-file", "--batch"], {
            cwd: root,
            input: entries.map((e) => e.oid).join("\n") + "\n",
            maxBuffer: 256 * 1024 * 1024,
          }),
        );
        let at = 0;
        for (const e of entries) {
          const nl = out.indexOf(0x0a, at);
          const size = Number(out.subarray(at, nl).toString("utf-8").split(" ")[2]);
          const start = nl + 1;
          blobs.set(dir === "." ? e.name : `${dir}/${e.name}`, out.subarray(start, start + size));
          at = start + size + 1;
        }
      }
      return entries.map((e) => e.name);
    },
    read(path) {
      return blob(path).toString("utf-8");
    },
    bytes: blob,
  };
}
