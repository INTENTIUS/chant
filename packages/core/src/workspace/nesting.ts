/**
 * The outer workspace never writes inside a nested one (#2524 D2, ws-007,
 * #2551). A member of kind `workspace` upgrades itself with its own
 * `chant workspace upgrade`; the outer side only reads it
 * (./nested-graph.ts).
 */

import { readDeclaration, WorkspaceReadError } from "./declaration";
import { workingTree } from "./tree";

/** The nested workspaces `dir` declares, as `{ name, dir }` with `dir` relative to `dir`. Empty without a readable declaration. */
export function nestedWorkspaces(dir: string): { name: string; dir: string }[] {
  try {
    return readDeclaration(workingTree(dir))
      .members.filter((m) => m.kind === "workspace")
      .map((m) => ({ name: m.name, dir: m.dir }));
  } catch (err) {
    if (err instanceof WorkspaceReadError) return [];
    throw err;
  }
}

/**
 * The paths, of `paths` (relative to the repository root), that lie inside a
 * nested workspace of the workspace at `dir`, whose own path from the
 * repository root is `rel` ("" for the root).
 */
export function pathsInsideNested(dir: string, rel: string, paths: readonly string[]): { member: string; path: string }[] {
  const nested = nestedWorkspaces(dir).map((n) => ({ member: n.name, prefix: `${[rel, n.dir].filter(Boolean).join("/")}/` }));
  if (nested.length === 0) return [];
  const out: { member: string; path: string }[] = [];
  for (const path of paths) {
    const hit = nested.find((n) => path.startsWith(n.prefix));
    if (hit) out.push({ member: hit.member, path });
  }
  return out;
}
