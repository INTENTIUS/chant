/**
 * Expand an example group's globs to directories (ws-051).
 *
 * The walk goes one path segment at a time, so a glob such as
 * `lexicons/*\/examples/*` reads only the directories it can match, never the
 * whole tree. Within a segment, picomatch does the matching; `**` matches zero
 * or more directories. `node_modules` and dot-directories are never entered
 * by a wildcard, though a literal segment may name them.
 */

// @ts-ignore — picomatch has no types declaration
import picomatch from "picomatch";
import { joinPath, skippedDir, type WorkspaceTree } from "./tree";

type Matcher = (name: string) => boolean;

const isLiteral = (segment: string): boolean => !/[*?[\]{}()!+@]/.test(segment);

/** Every directory `glob` matches in `tree`, sorted. */
export function expandGlob(tree: WorkspaceTree, glob: string): string[] {
  const segments = glob.split("/");
  const matchers: (Matcher | "**" | string)[] = segments.map((s) =>
    s === "**" ? "**" : isLiteral(s) ? s : (picomatch(s, { dot: false }) as Matcher),
  );
  const found = new Set<string>();
  const subdirs = (dir: string): string[] =>
    (tree.list(dir) ?? []).filter((e) => e.type === "dir" && !skippedDir(e.name)).map((e) => e.name);

  const walk = (dir: string, index: number): void => {
    if (index === matchers.length) {
      if (dir !== "") found.add(dir);
      return;
    }
    const m = matchers[index];
    if (m === "**") {
      walk(dir, index + 1);
      for (const name of subdirs(dir)) walk(joinPath(dir, name), index);
      return;
    }
    if (typeof m === "string") {
      const next = joinPath(dir, m);
      if (tree.stat(next) === "dir") walk(next, index + 1);
      return;
    }
    for (const name of subdirs(dir)) if (m(name)) walk(joinPath(dir, name), index + 1);
  };
  walk("", 0);
  return [...found].sort();
}
