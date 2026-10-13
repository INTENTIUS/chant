/**
 * Which `terraform.roots` a change touched (#3183), from the changed files
 * alone.
 *
 * A root is hand-written HCL, not chant source, so `chant lifecycle affected`
 * never sees it move: its artifact diff covers what chant builds. A pull
 * request's plan needs the roots a change reaches, and this answers that
 * from paths: a root is touched when a changed file sits in its directory,
 * in a local module it calls (followed through modules that call modules),
 * or is one of its var files.
 *
 * The module calls are read with a regex over the root's `.tf` and `.tofu`
 * files, the way `./op/activities/live-detect.ts` reads a live block, so
 * this stays out of the HCL parser's dependency graph. Only a `source` that
 * starts with `./` or `../` is followed; a registry or git source is a
 * version pin in the root's own files, which a change to it already touches.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import type { TerraformRootConfig } from "./config";

/** `source = "./..."` or `"../..."` inside a module block. Other sources are not on disk here. */
const LOCAL_SOURCE = /\bsource\s*=\s*"(\.{1,2}\/[^"]*)"/g;

const toPosix = (p: string): string => p.split(sep).join("/");

/** `dir` relative to `projectRoot`, `/`-separated, without a trailing slash; `.` for the root itself. */
function projectRelative(projectRoot: string, dir: string): string {
  const rel = toPosix(relative(projectRoot, dir));
  return rel === "" ? "." : posix.normalize(rel).replace(/\/+$/, "");
}

/** Local module directories `dir` calls, read from its HCL files. */
function localModuleDirs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".tf") && !name.endsWith(".tofu")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(LOCAL_SOURCE)) {
      // A `//subdir` suffix names a directory inside the source.
      const target = resolve(dir, m[1].replace("//", "/"));
      if (existsSync(target) && statSync(target).isDirectory()) out.push(target);
    }
  }
  return out;
}

/**
 * Every path, relative to `projectRoot`, whose change touches `root`: its
 * directory, each local module it reaches, and its var files.
 */
export function rootWatchPaths(projectRoot: string, root: Pick<TerraformRootConfig, "dir" | "varFiles">): string[] {
  const rootDir = resolve(projectRoot, root.dir);
  const seen = new Set<string>();
  const queue = [rootDir];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    queue.push(...localModuleDirs(dir));
  }
  const paths = [...seen].map((d) => projectRelative(projectRoot, d));
  for (const file of root.varFiles ?? []) paths.push(projectRelative(projectRoot, resolve(rootDir, file)));
  return [...new Set(paths)].sort();
}

/** Whether `file` is `path` or sits under it. Both relative to the project, `/`-separated. */
function covers(path: string, file: string): boolean {
  if (path === ".") return !file.startsWith("../");
  return file === path || file.startsWith(`${path}/`);
}

/**
 * The names of the roots in `roots` that a change to `changedFiles` touches,
 * sorted. `changedFiles` are relative to `projectRoot` with `/` separators,
 * as `git diff --name-only --relative` prints them.
 */
export function changedRoots(
  projectRoot: string,
  roots: Record<string, Pick<TerraformRootConfig, "dir" | "varFiles">>,
  changedFiles: readonly string[],
): string[] {
  const files = changedFiles.map((f) => posix.normalize(f));
  const touched: string[] = [];
  for (const [name, root] of Object.entries(roots)) {
    const watch = rootWatchPaths(projectRoot, root);
    if (files.some((f) => watch.some((p) => covers(p, f)))) touched.push(name);
  }
  return touched.sort();
}
