/**
 * Where a workspace read starts, and which chant does it (#2536; #2524 D15,
 * ws-016, ws-021).
 *
 * {@link locateWorkspace} finds the declaration from a directory, in the
 * working tree or in one commit's git objects (`--at <rev>`), and gives the
 * tree every read-contract command reads from.
 *
 * Which chant reads the declaration: the root's. The root names its chant by
 * pinning `@intentius/chant` in the declaration's `pins`. When it pins one,
 * that version reads the declaration, and any other chant refuses with
 * `root-chant-required` (`parseDeclaration`'s `rootChant` option). The CLI
 * first hands the whole command to the pinned chant when the root has it
 * installed ({@link handToRootChant}), so a user sees the refusal only when
 * it isn't. When the root pins no chant, the reader's own chant reads the
 * declaration if it meets `minReader`, and refuses with `reader-too-old`
 * otherwise. Members are always read by their own toolchains.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { findWorkspaceRoot } from "../project-root";
import { CHANT_PACKAGE, DECLARATION_FILES, findDeclarationDir, pinnedChant, readerVersion, WorkspaceReadError } from "./declaration";
import { parseJsonText } from "./jsonc";
import { findInstalledPackage } from "./kinds";
import { gitTop, gitTree, resolveCommit, workingTree, type WorkspaceTree } from "./tree";

export interface LocatedWorkspace {
  /** The files, rooted at the workspace root. */
  tree: WorkspaceTree;
  /** The workspace root relative to the git root, `"."` for the git root itself. Absolute outside git. */
  root: string;
  /** The workspace root on disk, where pinned packages and toolchains are installed. Also for `--at`. */
  rootOnDisk: string;
  /** The full commit id for `--at`, or null for the working tree. */
  at: string | null;
  /** The top of the git repository, when there is one. */
  top: string | undefined;
}

const posix = (p: string) => p.split("\\").join("/");

/**
 * Find the workspace whose declaration is nearest above `cwd`, in the working
 * tree or at revision `at`. Throws a {@link WorkspaceReadError}:
 * `declaration-missing`, or for `--at`, `not-a-git-repository` and
 * `revision-unknown`.
 */
export function locateWorkspace(cwd: string, at?: string): LocatedWorkspace {
  const top = gitTop(cwd);
  if (at !== undefined) {
    if (!top) throw new WorkspaceReadError("not-a-git-repository", "--at reads git objects, and this directory is not in a git repository");
    const commit = resolveCommit(top, at);
    if (!commit) throw new WorkspaceReadError("revision-unknown", `--at ${at} names no commit in this repository`);
    const whole = gitTree(top, commit);
    const start = posix(relative(top, realpathSync(resolve(cwd))));
    const found = findDeclarationDir(whole, start.startsWith("..") ? "" : start);
    if (found === undefined) {
      throw new WorkspaceReadError("declaration-missing", `no chant.workspace.json or .jsonc between ${start || "."} and the git root at ${commit.slice(0, 8)}`);
    }
    return {
      tree: found === "" ? whole : gitTree(top, commit, found),
      root: found === "" ? "." : found,
      rootOnDisk: join(top, ...found.split("/")),
      at: commit,
      top,
    };
  }
  const found = findWorkspaceRoot(cwd);
  if (!found) {
    throw new WorkspaceReadError(
      "declaration-missing",
      top
        ? "no chant.workspace.json or .jsonc between this directory and the git root; chant workspace init proposes one"
        : "no chant.workspace.json or .jsonc in this directory; chant workspace init proposes one",
    );
  }
  // git reports the top with symlinks resolved (/private/var on macOS), so compare like with like.
  const rel = top ? posix(relative(top, realpathSync(found.dir))) : found.dir;
  return { tree: workingTree(found.dir), root: rel === "" ? "." : rel, rootOnDisk: found.dir, at: null, top };
}

/**
 * The `bin/chant` of `@intentius/chant` at `version`, installed where the
 * workspace root resolves packages. Undefined when it isn't installed there,
 * or is installed at another version.
 */
export function rootChantBin(rootOnDisk: string, version: string): string | undefined {
  const dir = findInstalledPackage(CHANT_PACKAGE, rootOnDisk);
  if (!dir) return undefined;
  let pkg: { version?: unknown; bin?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as typeof pkg;
  } catch {
    return undefined;
  }
  if (pkg.version !== version) return undefined;
  const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.chant;
  if (typeof rel !== "string") return undefined;
  const bin = join(dir, rel);
  return existsSync(bin) ? bin : undefined;
}

/** Set in the environment of a command handed to the root's chant, so it is handed on once at most. */
export const HANDED_TO_ROOT_ENV = "CHANT_WORKSPACE_ROOT_CHANT";

/** The version the declaration at `located` pins for `@intentius/chant`, or undefined. Never throws. */
export function declaredChantPin(located: LocatedWorkspace): string | undefined {
  const file = DECLARATION_FILES.find((f) => located.tree.stat(f) === "file");
  if (!file) return undefined;
  let text: string;
  try {
    text = located.tree.read(file);
  } catch {
    return undefined;
  }
  const parsed = parseJsonText(text, { jsonc: file.endsWith(".jsonc") });
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return undefined;
  return pinnedChant(parsed.value as Record<string, unknown>)?.version;
}

/**
 * Hand a read-contract command to the root's chant (ws-021). When the
 * declaration above `cwd` (at `at`, for `--at`) pins a chant other than this
 * one, and the root has that chant installed, run the same command line
 * under it and return its exit code. Otherwise return undefined, and this
 * chant runs the command: it reads the declaration itself, or refuses with
 * `root-chant-required` when the pinned chant isn't installed.
 */
export async function handToRootChant(cwd: string, at: string | undefined, argv: string[] = process.argv.slice(2)): Promise<number | undefined> {
  if (process.env[HANDED_TO_ROOT_ENV]) return undefined;
  let located: LocatedWorkspace;
  try {
    located = locateWorkspace(cwd, at);
  } catch {
    return undefined;
  }
  const pinned = declaredChantPin(located);
  if (pinned === undefined || pinned === readerVersion()) return undefined;
  const bin = rootChantBin(located.rootOnDisk, pinned);
  if (!bin) return undefined;
  return new Promise((done) => {
    const child = spawn(bin, argv, { stdio: "inherit", env: { ...process.env, [HANDED_TO_ROOT_ENV]: pinned } });
    child.on("error", (e) => {
      process.stderr.write(`could not start the root's chant ${pinned} at ${bin}: ${e.message}\n`);
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}
