/**
 * Where a project's lifecycle ledger lives on the `chant/lifecycle` branch
 * (#2538, #2524 D7, ws-036).
 *
 * A workspace member writes every lifecycle store under
 * `_members/<member>/` on the one existing branch: releases, snapshots, runs,
 * converge records and observation baselines under `<env>/`, gates under
 * `_gates/`, build records under `_builds/`. Its operator leases move the same
 * way, to `refs/chant/lease/_members/<member>/<op>`. Push, fetch, lease and
 * staleness code are untouched: they still see one branch and plain refs.
 *
 * Everything else keeps today's flat layout, byte for byte:
 *
 * - a project with no `chant.workspace.json` between it and the git root
 *   (level 0);
 * - the root member `.`;
 * - a directory no member owns;
 * - an example group's match, since a group has no ledger of its own (ws-051).
 *
 * A member of kind `workspace` holds a nested declaration. The nested
 * workspace's ledgers sit inside the outer member's, so its member `api` in
 * the outer member `platform` writes under `_members/platform/_members/api/`,
 * and the nested root member `.` writes under `_members/platform/`.
 *
 * Level 0 pays one upward `existsSync` walk here and nothing more. The
 * declaration reader under `../workspace/` is imported only once a
 * declaration has been found, so a project without one never loads workspace
 * code (#2525 rule 5, pinned by #2526's goldens).
 */

import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findWorkspaceRoot } from "../project-root";

/** The directory on `chant/lifecycle` that holds every member's ledger. */
export const MEMBERS_DIR = "_members";

/**
 * The first chant that writes member ledgers. A member whose own toolchain
 * resolves an older chant still writes the flat layout; `chant workspace
 * check` fails when two flat writers share an environment name (#2524 D7).
 */
export const MEMBER_LEDGER_FLOOR = "0.81.0";

/** Where one project's ledger lives. */
export interface MemberLedger {
  /**
   * The owning member's path of names, outermost first: `["api"]`, or
   * `["platform", "api"]` inside a nested workspace. Empty for the flat
   * layout.
   */
  members: string[];
  /** The directory prefix on the branch: `""`, or `_members/<member>/` per level. */
  prefix: string;
}

const FLAT: MemberLedger = { members: [], prefix: "" };

/** The branch prefix for a path of member names. */
export function memberLedgerPrefix(members: readonly string[]): string {
  return members.map((m) => `${MEMBERS_DIR}/${m}/`).join("");
}

/**
 * Thrown when a project sits in a workspace whose declaration cannot be read.
 * Writing the flat layout then could land in another member's ledger, so no
 * lifecycle store guesses.
 */
export class MemberLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberLedgerError";
  }
}

const cache = new Map<string, Promise<MemberLedger>>();

/**
 * The ledger of the project at `projectDir` (any directory inside it will do;
 * ownership goes to the deepest member directory holding it). Results are
 * cached per directory for the life of the process.
 */
export function resolveMemberLedger(projectDir: string): Promise<MemberLedger> {
  const dir = resolve(projectDir);
  let hit = cache.get(dir);
  if (!hit) {
    hit = resolveUncached(dir);
    cache.set(dir, hit);
    // A failure is not remembered: the next call reads the declaration again.
    hit.catch(() => cache.delete(dir));
  }
  return hit;
}

/** Forget cached resolutions, for tests that write a declaration mid-run. */
export function clearMemberLedgerCache(): void {
  cache.clear();
}

function treePath(root: string, dir: string): string {
  const rel = relative(root, dir);
  return rel === "" ? "" : rel.split(sep).join("/");
}

async function resolveUncached(dir: string): Promise<MemberLedger> {
  const found = findWorkspaceRoot(dir);
  if (!found) return FLAT;
  return ledgerIn(found.dir, dir);
}

/**
 * The ledger of `dir` in the workspace whose declaration sits in `root`. When
 * that workspace is nested, its whole ledger sits inside the ledger of the
 * outer member holding `root`. The git root ends the walk outwards, as it
 * ends {@link findWorkspaceRoot}'s.
 */
async function ledgerIn(root: string, dir: string): Promise<MemberLedger> {
  // Only now does workspace code load.
  const { readDeclaration, resolveGroups, ownerOf, WorkspaceReadError } = await import("../workspace/declaration");
  const { workingTree } = await import("../workspace/tree");

  let own: string[];
  try {
    const tree = workingTree(root);
    const declaration = readDeclaration(tree);
    const owner = ownerOf(declaration, resolveGroups(declaration, tree), treePath(root, dir));
    own = owner && "member" in owner && owner.member.dir !== "." ? [owner.member.name] : [];
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    throw new MemberLedgerError(
      `cannot place this project's lifecycle ledger: ${err.describe()}. ` +
        `A project inside a workspace writes under ${MEMBERS_DIR}/<member>/ on chant/lifecycle, ` +
        `and chant does not guess the member. Fix the declaration and retry.`,
    );
  }

  let outer: MemberLedger = FLAT;
  const parent = dirname(root);
  if (parent !== root && !existsSync(join(root, ".git"))) {
    const outerFound = findWorkspaceRoot(parent);
    if (outerFound) outer = await ledgerIn(outerFound.dir, root);
  }
  const members = [...outer.members, ...own];
  return { members, prefix: memberLedgerPrefix(members) };
}
