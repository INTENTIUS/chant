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
 * Coverage binds to the digest of the first approval. {@link coveredRound}
 * takes that digest and records it, so a round planned for a different
 * composition never counts as covered by an approval of another one.
 */

import type { ChangeSetAction, ChangeSetDocument } from "../change-set";

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

/**
 * Why `fresh` is not covered by `previewed`, or `undefined` when it is.
 * Both are shapes of the same member.
 */
export function planShapeCovers(previewed: PlanShape, fresh: PlanShape): string | undefined {
  const member = fresh.member;
  const was = new Map(previewed.entries.map((e) => [e.logicalId, e]));
  for (const e of fresh.entries) {
    if (SKIPPED.has(e.action)) continue;
    const p = was.get(e.logicalId);
    if (!p) return `${member} now plans to ${e.action} ${e.logicalId}, which the first plan did not`;
    if (p.action !== e.action) return `${member} now plans to ${e.action} ${e.logicalId}, where the first plan showed ${p.action}`;
    if (e.replacement === "true" && p.replacement !== "true" && p.replacement !== "conditional") {
      return `${member} now replaces ${e.logicalId}, which the first plan did not show`;
    }
    if (e.replacement === "conditional" && p.replacement !== "conditional") {
      return `${member} may now replace ${e.logicalId}, which the first plan did not show`;
    }
  }
  const unknown = new Set(previewed.unknownInputs);
  const stillUnknown = fresh.unknownInputs[0];
  if (stillUnknown) return `${member} still reads ${stillUnknown}, which is not known yet`;
  for (const [ref, value] of Object.entries(fresh.knownInputs ?? {})) {
    if (unknown.has(ref)) continue;
    if (!previewed.knownInputs) continue;
    if (!(ref in previewed.knownInputs)) return `${member} now reads ${ref}, which the first plan did not`;
    if (JSON.stringify(previewed.knownInputs[ref] ?? null) !== JSON.stringify(value ?? null)) {
      return `${member} now reads ${ref} as a different value than the first plan`;
    }
  }
  return undefined;
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
