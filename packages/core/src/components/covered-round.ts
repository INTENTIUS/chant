/**
 * Covered rounds (#4419): a round planned after an upstream applied is
 * covered by the pull request's first approval when it does only what that
 * approval previewed.
 *
 * A member that reads an output an upstream in the same change has not
 * created yet is previewed with a hole: the input is marked unknown
 * (`PrMember.unknownInputs`). Once the upstream applied, the apply plans the
 * member again with the real value. That fresh plan is covered when
 *
 * - it touches only components the first plan previewed,
 * - within each, only the logical ids and actions previewed (and no
 *   replacement the preview did not show), and
 * - the only inputs that differ are the ones the preview marked unknown.
 *
 * A lexicon that can say more than the change set's entries (CloudFormation
 * previews the member with placeholder parameters and reads the real change
 * set afterwards) supplies a {@link PlanShape} on its `CapabilityPlan`.
 * Core decides coverage; the lexicon only reports what it planned.
 *
 * A shape may go below the entry, to the properties a change touches and the
 * ones an unknown input drives. Where it does, a property may drop out when
 * an unknown input drives it (the real value turned out equal to the current
 * one), and never otherwise, and a property may never be added.
 *
 * Coverage binds to the digest of the first approval. {@link coveredRound}
 * takes that digest and records it, so a round planned for a different
 * composition never counts as covered by an approval of another one.
 */

import type { ChangeSetAction, ChangeSetDocument } from "../change-set";
import { computePlanDigest } from "../lifecycle/plan-digest";

/** CloudFormation's `Replacement`, in lower case. */
export type ShapeReplacement = "true" | "false" | "conditional";

/** One resource a plan touches. */
export interface PlanShapeEntry {
  /** The resource's id in the lexicon's own terms: a CloudFormation logical id, a Terraform address. */
  logicalId: string;
  action: ChangeSetAction;
  /**
   * Whether the change replaces the resource, for an `update` or `replace`.
   * `conditional` is the preview not knowing, because a parameter it
   * depends on was a placeholder. Absent means the lexicon does not say.
   */
  replacement?: ShapeReplacement;
  /** The resource's type, when the lexicon says. Compared for equality when both sides carry it. */
  type?: string;
  /**
   * The properties the change touches, when the lexicon lists them. Present
   * on both sides, the fresh plan may touch fewer where an unknown input
   * drives them, and never more.
   */
  properties?: string[];
  /**
   * The properties an unknown input drives. On an update a subset of
   * `properties`; on a create, where a planner cannot list properties, they
   * stand alone. Present (even empty) on an entry that carries detail.
   */
  unknown?: string[];
}

/** What one member's plan does, without the values: what a lexicon supplies and core compares. */
export interface PlanShape {
  /** The member the shape is of, as in the change set. */
  member: string;
  /** Every resource the plan touches. A `no-op` or `read` entry may be left out. */
  entries: PlanShapeEntry[];
  /**
   * The inputs the plan was made without, as `<component>.<output>`: the
   * ones the preview marked unknown. A fresh plan lists none of them; it
   * is the inputs that were filled in that are recorded.
   */
  unknownInputs: string[];
  /**
   * The inputs the plan read with a value, by reference. When both shapes
   * carry a reference, the values must be equal, or an input that was
   * known has changed. Optional: a shape without it is checked on its
   * entries alone, plus the change set's own attributes in core.
   */
  knownInputs?: Record<string, unknown>;
}

const SKIPPED: ReadonlySet<ChangeSetAction> = new Set(["no-op", "read"]);

const REPLACEMENT_RANK: Record<ShapeReplacement, number> = { false: 0, conditional: 1, true: 2 };

/** An entry with property detail is compared whatever its action: a lexicon that lists properties means it. */
const skipped = (e: PlanShapeEntry): boolean => SKIPPED.has(e.action) && e.properties === undefined;

/**
 * Every way `fresh` goes beyond `previewed`, as reasons; none means covered.
 * Both are shapes of the same member.
 *
 * The fresh plan may match the preview exactly, or be narrower where an
 * unknown input drives it: a property whose real value equals the current one
 * drops out, a replacement that depended on a stand-in may not happen. It
 * may never add a resource, add a property, change an action or a type,
 * replace more than previewed, read an input that is still unknown, or read a
 * known input as another value.
 */
export function planShapeDifferences(previewed: PlanShape, fresh: PlanShape): string[] {
  const member = fresh.member;
  const out: string[] = [];
  const was = new Map(previewed.entries.map((e) => [e.logicalId, e]));
  const now = new Set<string>();
  for (const e of fresh.entries) {
    if (skipped(e)) continue;
    now.add(e.logicalId);
    const p = was.get(e.logicalId);
    if (!p) {
      out.push(`${member} now plans to ${e.action} ${e.logicalId}, which the first plan did not`);
      continue;
    }
    if (p.action !== e.action) out.push(`${member} now plans to ${e.action} ${e.logicalId}, where the first plan showed ${p.action}`);
    if (p.type !== undefined && e.type !== undefined && p.type !== e.type) out.push(`${member} now has ${e.logicalId} as ${e.type}, where the first plan showed ${p.type}`);
    if (p.properties && e.properties) {
      const extra = e.properties.filter((x) => !p.properties!.includes(x));
      if (extra.length > 0) out.push(`${member} now also changes ${extra.join(", ")} on ${e.logicalId}`);
      const driven = p.unknown ?? [];
      const lost = p.properties.filter((x) => !driven.includes(x) && !e.properties!.includes(x));
      if (lost.length > 0) out.push(`${member} no longer changes ${lost.join(", ")} on ${e.logicalId}, which no unknown input drives`);
    }
    if (e.replacement === "true" && p.replacement !== "true" && p.replacement !== "conditional") {
      out.push(`${member} now replaces ${e.logicalId}, which the first plan did not show`);
    } else if (e.replacement === "conditional" && p.replacement !== "conditional" && p.replacement !== "true") {
      out.push(`${member} may now replace ${e.logicalId}, which the first plan did not show`);
    } else if (e.replacement && p.replacement && p.unknown?.length === 0 && REPLACEMENT_RANK[e.replacement] < REPLACEMENT_RANK[p.replacement]) {
      out.push(`${member} replacement of ${e.logicalId} was ${p.replacement}, now ${e.replacement}, and no unknown input drives it`);
    }
  }
  // A previewed change that is gone: allowed only where unknown inputs drive all of it.
  for (const p of previewed.entries) {
    if (now.has(p.logicalId) || skipped(p) || !p.properties) continue;
    const driven = p.unknown ?? [];
    if (!(p.properties.length > 0 && p.properties.every((x) => driven.includes(x)))) {
      out.push(`${member} no longer plans to ${p.action} ${p.logicalId}, which the first plan did and no unknown input drives`);
    }
  }
  const unknown = new Set(previewed.unknownInputs);
  const stillUnknown = fresh.unknownInputs[0];
  if (stillUnknown) out.push(`${member} still reads ${stillUnknown}, which is not known yet`);
  for (const [ref, value] of Object.entries(fresh.knownInputs ?? {})) {
    if (unknown.has(ref)) continue;
    if (!previewed.knownInputs) continue;
    if (!(ref in previewed.knownInputs)) out.push(`${member} now reads ${ref}, which the first plan did not`);
    else if (JSON.stringify(previewed.knownInputs[ref] ?? null) !== JSON.stringify(value ?? null)) {
      out.push(`${member} now reads ${ref} as a different value than the first plan`);
    }
  }
  return out;
}

/**
 * Why `fresh` is not covered by `previewed`, or `undefined` when it is: the
 * first of {@link planShapeDifferences}.
 */
export function planShapeCovers(previewed: PlanShape, fresh: PlanShape): string | undefined {
  return planShapeDifferences(previewed, fresh)[0];
}

/** A shape in the order that makes equal shapes digest equal. */
export function normalizePlanShape(shape: PlanShape): PlanShape {
  const sorted = (xs: string[]): string[] => [...new Set(xs)].sort();
  return {
    member: shape.member,
    entries: shape.entries
      .map((e) => ({
        logicalId: e.logicalId,
        action: e.action,
        ...(e.replacement ? { replacement: e.replacement } : {}),
        ...(e.type !== undefined ? { type: e.type } : {}),
        ...(e.properties ? { properties: sorted(e.properties) } : {}),
        ...(e.unknown ? { unknown: sorted(e.unknown) } : {}),
      }))
      .sort((a, b) => a.logicalId.localeCompare(b.logicalId) || a.action.localeCompare(b.action)),
    unknownInputs: sorted(shape.unknownInputs),
    ...(shape.knownInputs ? { knownInputs: shape.knownInputs } : {}),
  };
}

export function planShapeDigest(shape: PlanShape): string {
  return computePlanDigest("plan-shape", normalizePlanShape(shape));
}

/**
 * What a lexicon hands the run for a previewed member, through
 * `DeployContext.plans[member]`. `kind` is the lexicon's own so its `run`
 * can tell a shape from its other artifacts.
 */
export interface PlanShapeArtifact {
  kind: string;
  member: string;
  shape: PlanShape;
  digest: string;
}

/**
 * Thrown by a member's `run` when the change it created is not covered by the
 * shape previewed. The change set is deleted unexecuted. `planMoved` is
 * core's mark for a moved plan, so the command that applied it exits 3.
 */
export class PlanShapeMovedError extends Error {
  readonly planMoved = true;
  constructor(
    public readonly member: string,
    public readonly differences: string[],
  ) {
    super(`"${member}": refusing to apply. The change differs from the preview that was approved: ${differences.join("; ")}. Plan it again.`);
    this.name = "PlanShapeMovedError";
  }
}

/** The shape a change-set document gives for `member`, when its lexicon supplies none. */
export function shapeFromChangeSet(doc: ChangeSetDocument, member: string, inputs: { unknownInputs?: string[]; knownInputs?: Record<string, unknown> } = {}): PlanShape {
  return {
    member,
    entries: doc.entries
      .filter((e) => e.member === member)
      .map((e) => ({ logicalId: e.deposed ? `${e.address}#${e.deposed}` : e.address, action: e.action })),
    unknownInputs: [...(inputs.unknownInputs ?? [])].sort(),
    ...(inputs.knownInputs ? { knownInputs: inputs.knownInputs } : {}),
  };
}

/** What a round was covered by, as the report records it (`PrRound.covered`). */
export interface RoundCover {
  /** The digest of the first approval, which the coverage is bound to. */
  digest: string;
  /** The inputs the first plan marked unknown and this round planned with a value, `<component>.<output>`, sorted. */
  filledInputs: string[];
}

export type RoundCoverage = ({ covered: true } & RoundCover) | { covered: false; reason: string };

/** One side of the comparison: a plan set, as far as coverage needs it. */
export interface CoverageSide {
  doc: ChangeSetDocument;
  /** Per member, its component and (first plan only) the inputs it was previewed without. */
  members: { member: string; component: string; unknownInputs?: string[] }[];
  /** Shapes a lexicon supplied, by member. Where absent, the change set gives the shape. */
  shapes?: Record<string, PlanShape>;
}

export interface CoveredRoundInput {
  /** The first plan, whose approval is being relied on. */
  approved: CoverageSide;
  /** The digest that approval binds: the report's `digest`. */
  approvedDigest: string;
  /** The round's fresh plan. */
  fresh: CoverageSide;
  /**
   * Known inputs that changed between the first plan and the round, as
   * `<component>.<output>`: an input the first plan read with a value that
   * stands as another one now. Core reads them from the outputs.
   */
  changedKnown?: ReadonlyMap<string, string[]> | Record<string, string[]>;
  /** The check on the change set's own attributes, per member (`planCoveredBy`). */
  attributes?: (member: string) => string | undefined;
}

/**
 * Whether the approval of `approvedDigest` covers `fresh`. Covered, the
 * result names the digest and the inputs that were filled in; not covered,
 * the reason, which the apply reports with the approval it asks for.
 */
export function coveredRound(input: CoveredRoundInput): RoundCoverage {
  const { approved, fresh } = input;
  const previewedComponents = new Set(approved.members.map((m) => m.component));
  const approvedMember = new Map(approved.members.map((m) => [m.member, m]));
  const filled = new Set<string>();
  for (const m of fresh.members) {
    if (!previewedComponents.has(m.component)) return { covered: false, reason: `${m.component} was not in the first plan` };
    const was = approvedMember.get(m.member);
    if (!was) return { covered: false, reason: `${m.member} was not in the first plan` };
    if (was.component !== m.component) return { covered: false, reason: `${m.member} moved from ${was.component} to ${m.component}` };
    const previewed = approved.shapes?.[m.member] ?? shapeFromChangeSet(approved.doc, m.member, { unknownInputs: was.unknownInputs });
    const unknownInputs = [...new Set([...(previewed.unknownInputs ?? []), ...(was.unknownInputs ?? [])])].sort();
    const now = fresh.shapes?.[m.member] ?? shapeFromChangeSet(fresh.doc, m.member);
    const reason = planShapeCovers({ ...previewed, unknownInputs }, now);
    if (reason) return { covered: false, reason };
    const changed = (input.changedKnown instanceof Map ? input.changedKnown.get(m.component) : (input.changedKnown as Record<string, string[]> | undefined)?.[m.component]) ?? [];
    const changedKnown = changed.filter((ref: string) => !unknownInputs.includes(ref));
    if (changedKnown.length > 0) return { covered: false, reason: `${m.member} reads ${changedKnown.join(", ")}, which the first plan read as another value` };
    const attrs = input.attributes?.(m.member);
    if (attrs) return { covered: false, reason: attrs };
    for (const ref of unknownInputs) filled.add(ref);
  }
  return { covered: true, digest: input.approvedDigest, filledInputs: [...filled].sort() };
}
