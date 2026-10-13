/**
 * The files a workspace read looks at: the working tree, or one commit's git
 * objects (`--at <rev>`, #2524 D15). Reading a revision needs no checkout and
 * no network; the whole tree is listed once from the local object store.
 *
 * Paths are relative to the tree's root, `/`-separated, and `""` is the root.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceTree {
  /** Appended to messages, such as " at 91c7547e". Empty for the working tree. */
  label: string;
  /** Whether `path` is a file, a directory, or missing. */
  stat(path: string): "file" | "dir" | undefined;
  /** The names of the entries directly inside directory `path`, or undefined when it is missing. */
  list(path: string): { name: string; type: "file" | "dir" }[] | undefined;
  /** The text of the file at `path`. Throws when it can't be read. */
  read(path: string): string;
  /**
   * The bytes of the file at `path`, for hashing (#2549). Throws when it can't
   * be read. A tree without it is read as UTF-8 text.
   */
  bytes?(path: string): Uint8Array;
}

/** Join tree-relative path parts, leaving out `""` and `"."`. */
export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== "" && p !== ".").join("/");
}

/** The working tree under `root`. */
export function workingTree(root: string): WorkspaceTree {
  return {
    label: "",
    stat(path) {
      try {
        const s = statSync(join(root, path));
        return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined;
      } catch {
        return undefined;
      }
    },
    list(path) {
      let dirents;
      try {
        dirents = readdirSync(join(root, path), { withFileTypes: true });
      } catch {
        return undefined;
      }
      const out: { name: string; type: "file" | "dir" }[] = [];
      for (const d of dirents) {
        let type: "file" | "dir" | undefined = d.isDirectory() ? "dir" : d.isFile() ? "file" : undefined;
        if (!type && d.isSymbolicLink()) {
          try {
            const s = statSync(join(root, path, d.name));
            type = s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined;
          } catch {
            // A dangling link is no entry.
          }
        }
        if (type) out.push({ name: d.name, type });
      }
      return out;
    },
    read(path) {
      return readFileSync(join(root, path), "utf-8");
    },
    bytes(path) {
      return readFileSync(join(root, path));
    },
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
}

/** The top of the git repository holding `cwd`, or undefined outside one. */
export function gitTop(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return undefined;
  }
}

/** The full commit id `rev` names in the repository at `top`, or undefined. */
export function resolveCommit(top: string, rev: string): string | undefined {
  if (rev.startsWith("-")) return undefined;
  try {
    return git(top, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim();
  } catch {
    return undefined;
  }
}

/**
 * The tree of `commit` in the repository at `top`, rooted at `prefix` (a
 * directory relative to `top`, `""` for the top itself).
 */
export function gitTree(top: string, commit: string, prefix = ""): WorkspaceTree {
  const entries = new Map<string, "file" | "dir">([["", "dir"]]);
  const children = new Map<string, { name: string; type: "file" | "dir" }[]>([["", []]]);
  const out = git(top, ["ls-tree", "-r", "-t", "-z", "--full-tree", commit]);
  for (const line of out.split("\0")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const type = line.slice(0, tab).split(" ")[1];
    const full = line.slice(tab + 1);
    let path: string;
    if (prefix === "") path = full;
    else if (full.startsWith(`${prefix}/`)) path = full.slice(prefix.length + 1);
    else continue;
    const kind = type === "tree" ? "dir" : type === "blob" ? "file" : undefined;
    if (!kind) continue;
    entries.set(path, kind);
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push({ name: path.slice(slash + 1), type: kind });
    if (kind === "dir" && !children.has(path)) children.set(path, []);
  }
  return {
    label: ` at ${commit.slice(0, 8)}`,
    stat: (path) => entries.get(path),
    list: (path) => (entries.get(path) === "dir" ? [...(children.get(path) ?? [])] : undefined),
    read(path) {
      if (entries.get(path) !== "file") throw new Error(`${path} is not a file${` at ${commit.slice(0, 8)}`}`);
      return git(top, ["cat-file", "blob", `${commit}:${joinPath(prefix, path)}`]);
    },
    bytes(path) {
      if (entries.get(path) !== "file") throw new Error(`${path} is not a file${` at ${commit.slice(0, 8)}`}`);
      return execFileSync("git", ["cat-file", "blob", `${commit}:${joinPath(prefix, path)}`], { cwd: top, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
    },
  };
}

/** Directory names a workspace walk never enters. */
export function skippedDir(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}
