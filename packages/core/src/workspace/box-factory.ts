/**
 * The factory and listing on a box block, and whether a workspace is
 * plantable (#3146, ws-077), as `chant workspace status --json` and
 * `chant workspace graph --json` print them.
 *
 * Every field here is opt-in (#3174): a workspace with no box, or a box with
 * no `factory` or `listing`, reads as `null` for each, and plantability is a
 * fact about the declaration, never a check that fails. A records-only
 * workspace and an infra workspace with a factory and no box services both
 * read and check cleanly; they just aren't plantable.
 */

import { createHash } from "node:crypto";
import type { BoxFactory, BoxListing, Declaration, FactoryCheckKind, FactoryTier } from "./declaration";
import type { ReasonCode } from "./reason-codes";
import type { WorkspaceTree } from "./tree";

/** Why a workspace isn't plantable. Closed. */
export const PLANTABLE_REASON_CODES = ["box-none", "box-several"] as const satisfies readonly ReasonCode[];
export type PlantableReasonCode = (typeof PLANTABLE_REASON_CODES)[number];

/**
 * Whether a host such as a studio's planter can plant the workspace as one
 * box: exactly one member's box block declares services. `box` names that
 * member, and is null when the workspace isn't plantable.
 */
export interface Plantable {
  plantable: boolean;
  box: string | null;
  reason: { code: PlantableReasonCode; message: string } | null;
}

/** A box's factory as the read contract prints it: every field present, defaults filled in. */
export interface FactoryView {
  builds: string[];
  check: { run: string; kind: FactoryCheckKind } | null;
  checks: string | null;
  builders: string | null;
  /** Which builder agent builds at which tier, as declared (#3152, ws-094); empty when none is. */
  tiers: FactoryTier[];
  /**
   * The builder for each member the factory builds, by tier (#3152): the
   * entry for the tier that names the member's kind, else the tier's entry
   * with no kinds. A tier with no entry for the member is left out, so a
   * reader resolves a work item's tier with one lookup, without studio.
   */
  builderFor: Record<string, Record<string, { agent: string; session: string | null }>>;
  publish: { forge: "github"; repo: string; base: string | null; branchPrefix: string; head: string | null } | null;
}

/** A box's listing as the read contract prints it, with the cover's hash when the file is there. */
export interface ListingView {
  published: boolean;
  title: string;
  line: string;
  /** The cover file from the workspace root and the sha256 of its bytes, null when the file can't be read; null when none is declared. */
  cover: { path: string; sha256: string | null } | null;
}

/** Whether the declaration is plantable (#3146): exactly one member's box block declares services. */
export function plantability(declaration: Declaration): Plantable {
  const boxes = declaration.members.filter((m) => (m.box?.services.length ?? 0) > 0);
  if (boxes.length === 1) return { plantable: true, box: boxes[0].name, reason: null };
  if (boxes.length === 0) {
    return { plantable: false, box: null, reason: { code: "box-none", message: "no member's box block declares services, so there is no box to plant" } };
  }
  return {
    plantable: false,
    box: null,
    reason: { code: "box-several", message: `members ${boxes.map((m) => m.name).join(", ")} each declare box services, and a planted workspace runs one box` },
  };
}

/** A box's factory as the read contract prints it. `members` gives each built member's kind, for `builderFor`. */
export function factoryView(f: BoxFactory | null, members: readonly { name: string; kind: string }[] = []): FactoryView | null {
  if (f === null) return null;
  return {
    builds: [...f.builds],
    check: f.check === null ? null : { ...f.check },
    checks: f.checks,
    builders: f.builders,
    tiers: f.tiers.map((t) => ({ ...t, kinds: t.kinds === null ? null : [...t.kinds] })),
    builderFor: builderTable(f, members),
    publish: f.publish === null ? null : { ...f.publish },
  };
}

/** The builder table (#3152): for each built member, each tier's agent, by the member's kind first and the tier's default second. */
export function builderTable(f: BoxFactory, members: readonly { name: string; kind: string }[]): FactoryView["builderFor"] {
  const tiers = [...new Set(f.tiers.map((t) => t.tier))];
  const out: FactoryView["builderFor"] = {};
  for (const name of f.builds) {
    const kind = members.find((m) => m.name === name)?.kind;
    const row: Record<string, { agent: string; session: string | null }> = {};
    for (const tier of tiers) {
      const entry =
        f.tiers.find((t) => t.tier === tier && kind !== undefined && t.kinds?.includes(kind)) ?? f.tiers.find((t) => t.tier === tier && t.kinds === null);
      if (entry) row[tier] = { agent: entry.agent, session: entry.session };
    }
    out[name] = row;
  }
  return out;
}

/** The listing, hashing the cover through `read` (bytes, or null when the file can't be read). */
export function listingView(l: BoxListing | null, read: (path: string) => Uint8Array | null): ListingView | null {
  if (l === null) return null;
  let cover: ListingView["cover"] = null;
  if (l.cover !== null) {
    const bytes = read(l.cover);
    cover = { path: l.cover, sha256: bytes === null ? null : createHash("sha256").update(bytes).digest("hex") };
  }
  return { published: l.published, title: l.title, line: l.line, cover };
}

/** A reader of a file's bytes in `tree` for {@link listingView}: null when the file can't be read. */
export function treeBytes(tree: WorkspaceTree): (path: string) => Uint8Array | null {
  return (path) => {
    try {
      if (tree.stat(path) !== "file") return null;
      return tree.bytes ? tree.bytes(path) : new TextEncoder().encode(tree.read(path));
    } catch {
      return null;
    }
  };
}

/** The box fields the graph prints on a member (#3146): its factory and listing, or null when the member's box declares neither. */
export function graphBox(
  box: { factory: BoxFactory | null; listing: BoxListing | null } | null,
  tree: WorkspaceTree,
  members: readonly { name: string; kind: string }[] = [],
): { factory: FactoryView | null; listing: ListingView | null } | null {
  if (box === null || (box.factory === null && box.listing === null)) return null;
  return { factory: factoryView(box.factory, members), listing: listingView(box.listing, treeBytes(tree)) };
}
