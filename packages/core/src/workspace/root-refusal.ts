/**
 * `chant build` and `chant lint` at the root of a declared workspace (#2537,
 * #2524 D0 and D12, ws-023).
 *
 * Once `chant.workspace.json` declares members, their directories leave the
 * root project. A top-level `chant build` there would quietly build less than
 * it did before the file existed, so both commands refuse with `WSP000` and
 * point to `chant workspace build` and `chant workspace lint`. `--root-only`,
 * or `rootOnly: true` in the root's `chant.config`, lets them run on the root
 * project alone, with the member directories and example-group matches left
 * out of discovery.
 *
 * `main.ts` decides with `findWorkspaceRoot` and `findProjectRoot`, which only
 * test whether files exist, and imports this module only when the command's
 * project is a declared root. A project with no declaration never loads it.
 */

import { relative } from "node:path";
import { excludeFromRootDiscovery } from "../config";
import { formatError } from "../cli/format";
import { ownerOf, readDeclaration, resolveGroups, rootExclusions, WorkspaceReadError } from "./declaration";
import { workingTree } from "./tree";

/** The code a refusal carries. `WSP` ids name workspace findings (#2524 D16); `000` is the refusal itself. */
export const ROOT_REFUSAL_CODE = "WSP000";

export interface RootGuardInput {
  verb: "build" | "lint";
  /** The command's target, absolute. */
  target: string;
  /** The directory holding the declaration, absolute. */
  workspaceDir: string;
  /** `--root-only` on the command line, or `rootOnly: true` in the root's chant.config. */
  rootOnly: boolean;
}

export type RootGuardResult =
  /** The target belongs to a member or an example group, so it is not the root project; nothing changes. */
  | { action: "not-root" }
  /** The command runs on the root project with these directories (relative to the root) left out. */
  | { action: "root-only"; excluded: string[] }
  /** The command stops; `message` says why and what to run instead. */
  | { action: "refuse"; message: string };

/** Decide what a root `build` or `lint` does. Pure apart from reading the declaration. */
export function decideRootCommand(input: RootGuardInput): RootGuardResult {
  const tree = workingTree(input.workspaceDir);
  let declaration;
  let groups;
  try {
    declaration = readDeclaration(tree);
    groups = resolveGroups(declaration, tree);
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    return {
      action: "refuse",
      message:
        `${ROOT_REFUSAL_CODE}: ${input.workspaceDir} holds a workspace declaration that can't be read, so chant ${input.verb} ` +
        `can't tell which directories belong to the root project. ${err.code}: ${err.describe()}`,
    };
  }
  const rel = relative(input.workspaceDir, input.target).split("\\").join("/") || ".";
  const owner = ownerOf(declaration, groups, rel === "." ? "." : rel);
  if (owner && ("group" in owner || owner.member.dir !== ".")) return { action: "not-root" };

  const excluded = rootExclusions(declaration, groups).map((e) => e.dir);
  if (input.rootOnly) return { action: "root-only", excluded };

  const members = declaration.members.filter((m) => m.dir !== ".").length;
  const matches = groups.reduce((n, g) => n + g.matches.length, 0);
  const moved = [
    `${members} member${members === 1 ? "" : "s"}`,
    ...(matches > 0 ? [`${matches} example project${matches === 1 ? "" : "s"}`] : []),
  ].join(" and ");
  return {
    action: "refuse",
    message:
      `${ROOT_REFUSAL_CODE}: this is the root of workspace ${declaration.name} (${declaration.file}), which moves ` +
      `${moved} out of the root project. Run chant workspace ${input.verb} to ${input.verb} each member with its own ` +
      `toolchain, or pass --root-only (or set rootOnly: true in chant.config) to ${input.verb} the root project alone.`,
  };
}

/**
 * Apply {@link decideRootCommand}: print the refusal and return 1, or set the
 * root-only exclusions and return undefined so the command goes on.
 */
export function guardRootCommand(input: RootGuardInput): number | undefined {
  const result = decideRootCommand(input);
  if (result.action === "refuse") {
    console.error(formatError({ message: result.message }));
    return 1;
  }
  if (result.action === "root-only") excludeFromRootDiscovery(input.workspaceDir, result.excluded);
  return undefined;
}
