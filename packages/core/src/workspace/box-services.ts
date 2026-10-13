/**
 * The services a box declares, read for the process that runs in the box
 * (#2880).
 *
 * A box member's block in the declaration lists the services the box runs
 * under its supervisor (`BoxService` in `declaration.ts`). The fly lexicon's
 * `spriteServicesObserve`, `spriteServiceRestart` and `spriteApplyServices`
 * take `box: true` to read that list instead of one passed to them: the list
 * of the member whose directory holds the working directory. They import
 * this module when they run, so it stays small: it finds the workspace root,
 * reads the declaration from the working tree and picks the member.
 */

import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { findWorkspaceRoot } from "../project-root";
import { ownerOf, readDeclaration, WorkspaceReadError, type BoxService } from "./declaration";
import { workingTree } from "./tree";

export type { BoxService } from "./declaration";

/** The box block's services, and whose they are. */
export interface DeclaredBoxServices {
  /** The workspace root, absolute. */
  root: string;
  /** The member whose directory holds the working directory. */
  member: string;
  /** In file order. */
  services: BoxService[];
}

/**
 * The services of the box block of the member whose directory holds `cwd`.
 * Throws a {@link WorkspaceReadError} when there is no workspace or its
 * declaration can't be read, and an Error when no member holds `cwd` or the
 * member has no box block. A block with no `services` gives an empty list.
 */
export function readBoxServices(cwd: string = process.cwd()): DeclaredBoxServices {
  const found = findWorkspaceRoot(cwd);
  if (!found) {
    throw new WorkspaceReadError("declaration-missing", `no chant.workspace.json or .jsonc between ${cwd} and the git root, so there is no box block to read services from`);
  }
  const root = realpathSync(found.dir);
  const declaration = readDeclaration(workingTree(root));
  const path = relative(root, realpathSync(cwd)).split("\\").join("/") || ".";
  const owner = ownerOf(declaration, [], path);
  if (!owner || !("member" in owner)) throw new Error(`no member of the workspace at ${root} holds ${cwd}, so there is no box block to read services from`);
  const m = owner.member;
  if (!m.box) throw new Error(`member ${m.name} (${m.dir}) has no box block in ${declaration.file}, so it declares no services`);
  return { root, member: m.name, services: m.box.services };
}
