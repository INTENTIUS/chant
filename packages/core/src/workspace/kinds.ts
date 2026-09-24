/**
 * Member kinds (#2524 D3), as far as #2534 needs them to list members.
 *
 * A kind is data: a name and a probe that says what its directory holds.
 * Probes run no code (K3). This module holds the three built-in member kinds
 * and the one group kind, `examples` (ws-051). Kinds from plugins, read from a
 * data-only `./workspace-kinds` subpath, arrive with #2535, which builds a
 * {@link KindRegistry} holding them next to these. Everything that asks about
 * kinds goes through a registry, so that change touches no caller.
 */

import type { WorkspaceTree } from "./tree";
import { joinPath, skippedDir } from "./tree";

/** What a kind's probe checks in a member directory. */
export type KindProbe =
  /** One of these files sits directly in the directory. */
  | { anyFile: string[] }
  /** The directory exists; nothing else is checked (`other`). */
  | { directory: true };

export interface MemberKind {
  name: string;
  /** One line for listings and error messages. */
  description: string;
  probe: KindProbe;
  /** Where the kind comes from: `builtin`, or the plugin that supplies it (#2535). */
  source: string;
}

export interface KindRegistry {
  get(name: string): MemberKind | undefined;
  /** Every known kind name, sorted, for "unknown kind" messages. */
  names(): string[];
}

/** The group kind (ws-051). It is an entry shape of its own, not a member kind. */
export const EXAMPLES_KIND = "examples";

export const BUILTIN_KINDS: readonly MemberKind[] = [
  {
    name: "chant",
    description: "a chant project, with a chant.config.ts or chant.config.json in its directory",
    probe: { anyFile: ["chant.config.ts", "chant.config.json"] },
    source: "builtin",
  },
  {
    name: "workspace",
    description: "a nested workspace, with its own chant.workspace.json; opaque to the outer one",
    probe: { anyFile: ["chant.workspace.json", "chant.workspace.jsonc"] },
    source: "builtin",
  },
  {
    name: "other",
    description: "a directory chant does not read; the entry says why in `because`",
    probe: { directory: true },
    source: "builtin",
  },
];

export function builtinKindRegistry(): KindRegistry {
  const byName = new Map(BUILTIN_KINDS.map((k) => [k.name, k]));
  return {
    get: (name) => byName.get(name),
    names: () => [...byName.keys()].sort(),
  };
}

/** Whether `dir` (tree-relative) passes `kind`'s probe. The directory is known to exist. */
export function probeKind(kind: MemberKind, tree: WorkspaceTree, dir: string): boolean {
  if ("directory" in kind.probe) return true;
  return kind.probe.anyFile.some((name) => tree.stat(joinPath(dir, name)) === "file");
}

const CONFIG_FILES = ["chant.config.ts", "chant.config.json"];
const PROJECT_SEARCH_DEPTH = 4;

/**
 * Whether directory `dir` holds a chant project, for an example group's
 * matches (ws-051). That is true when a chant config sits in it or up to four
 * levels below it (many examples keep theirs in `src/`), or when its own
 * `package.json` depends on `@intentius/chant` or a chant lexicon, which is
 * how an example with no config names its lexicon.
 */
export function holdsChantProject(tree: WorkspaceTree, dir: string): boolean {
  const pkg = joinPath(dir, "package.json");
  if (tree.stat(pkg) === "file") {
    try {
      const json = JSON.parse(tree.read(pkg)) as Record<string, unknown>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const deps = json[field];
        if (deps && typeof deps === "object" && Object.keys(deps).some(isChantPackage)) return true;
      }
    } catch {
      // An unreadable package.json names no lexicon; fall through to the config search.
    }
  }
  const search = (at: string, depth: number): boolean => {
    const entries = tree.list(at) ?? [];
    if (entries.some((e) => e.type === "file" && CONFIG_FILES.includes(e.name))) return true;
    if (depth === PROJECT_SEARCH_DEPTH) return false;
    return entries.some((e) => e.type === "dir" && !skippedDir(e.name) && search(joinPath(at, e.name), depth + 1));
  };
  return search(dir, 0);
}

function isChantPackage(name: string): boolean {
  return name === "@intentius/chant" || name.startsWith("@intentius/chant-lexicon-");
}
