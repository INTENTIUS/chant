/**
 * The shape of a plan for a member whose inputs are not known yet (#4419).
 *
 * In a composed run, a member can read a value that an earlier member
 * creates in the same run. Its planner cannot plan it against the real value,
 * so the member is planned against a stand-in, and what the planner can keep
 * is the shape of the result: which resources change, how, whether they are
 * replaced, and which properties are driven by the unknown inputs. After the
 * earlier members apply, the member is planned again with the real values and
 * its real change is compared with that shape. The apply goes ahead only when
 * they agree and the only differences sit in properties the unknown inputs
 * drive.
 *
 * This module holds what does not depend on a lexicon: the shape, how two
 * shapes compare, the digest of a shape and the error a mismatch raises. A
 * lexicon supplies the two ends: how it previews a member against stand-ins,
 * and how it reads its real change into a shape. The aws lexicon is the
 * first implementation (`lexicons/aws/src/components/apply.ts`).
 */
import { computePlanDigest } from "./plan-digest";

/** How strongly a change replaces its resource. `maybe` is a replacement that depends on a value resolved while applying. */
export type ShapeReplacement = "no" | "maybe" | "yes";

const REPLACEMENT_RANK: Record<ShapeReplacement, number> = { no: 0, maybe: 1, yes: 2 };

/** One resource's change, without its values. */
export interface PlanShapeEntry {
  /** The planner's address for the resource. */
  address: string;
  type: string;
  /** The planner's own word for the action (create, update, delete, ...). Compared for equality. */
  action: string;
  replacement: ShapeReplacement;
  /** The properties the change touches, sorted. */
  properties: string[];
  /**
   * The properties the unknown inputs drive, sorted. On an update they are a
   * subset of `properties`; on a create the planner cannot list properties,
   * so they stand alone.
   */
  unknown: string[];
}

export interface PlanShape {
  member: string;
  lexicon: string;
  /** The inputs that were unknown when the shape was taken, sorted. */
  unknownInputs: string[];
  entries: PlanShapeEntry[];
}

/** One way the real change differs from the previewed shape beyond what the unknown inputs allow. */
export interface PlanShapeDifference {
  address: string;
  reason: string;
}

/** Put a shape in the order that makes equal shapes digest equal. */
export function normalizePlanShape(shape: PlanShape): PlanShape {
  return {
    member: shape.member,
    lexicon: shape.lexicon,
    unknownInputs: [...new Set(shape.unknownInputs)].sort(),
    entries: shape.entries
      .map((e) => ({
        ...e,
        properties: [...new Set(e.properties)].sort(),
        unknown: [...new Set(e.unknown)].sort(),
      }))
      .sort((a, b) => a.address.localeCompare(b.address)),
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
 * Compare the real change with the shape previewed for it. Returns the
 * differences; none means the apply may go ahead.
 *
 * The real change may match the preview exactly, or it may be narrower where
 * an unknown input drives it: a property whose real value turns out equal to
 * the current one drops out, and a replacement that depended on the stand-in
 * may not happen. It may never add a resource, add a property, change an
 * action, or replace more than previewed.
 */
export function comparePlanShape(previewed: PlanShape, actual: PlanShape): PlanShapeDifference[] {
  const diffs: PlanShapeDifference[] = [];
  const want = new Map(previewed.entries.map((e) => [e.address, e]));
  const got = new Map(actual.entries.map((e) => [e.address, e]));
  for (const [address, a] of got) {
    const p = want.get(address);
    if (!p) {
      diffs.push({ address, reason: `the change set now proposes a ${a.action} of ${a.type} that the preview did not` });
      continue;
    }
    const driven = p.unknown.length > 0;
    if (a.type !== p.type) diffs.push({ address, reason: `type was ${p.type}, now ${a.type}` });
    if (a.action !== p.action) diffs.push({ address, reason: `action was ${p.action}, now ${a.action}` });
    const extra = a.properties.filter((x) => !p.properties.includes(x));
    if (extra.length > 0) diffs.push({ address, reason: `now also changes ${extra.join(", ")}` });
    const lost = p.properties.filter((x) => !p.unknown.includes(x) && !a.properties.includes(x));
    if (lost.length > 0) diffs.push({ address, reason: `no longer changes ${lost.join(", ")}, which no unknown input drives` });
    const ra = REPLACEMENT_RANK[a.replacement];
    const rp = REPLACEMENT_RANK[p.replacement];
    if (ra > rp) diffs.push({ address, reason: `replacement was ${p.replacement}, now ${a.replacement}` });
    else if (ra < rp && !driven) diffs.push({ address, reason: `replacement was ${p.replacement}, now ${a.replacement}, and no unknown input drives it` });
  }
  for (const [address, p] of want) {
    if (got.has(address)) continue;
    const onlyUnknown = p.properties.length > 0 && p.properties.every((x) => p.unknown.includes(x));
    if (!onlyUnknown) diffs.push({ address, reason: `the preview proposed a ${p.action} of ${p.type} that the change set no longer does` });
  }
  return diffs;
}

/**
 * Thrown by a member's `run` when the change it created differs from the
 * shape previewed, beyond what the unknown inputs allow. The change set is
 * deleted unexecuted. `planMoved` is core's mark for a moved plan, so the
 * command that applied it exits 3.
 */
export class PlanShapeMovedError extends Error {
  readonly planMoved = true;
  constructor(
    public readonly member: string,
    public readonly differences: PlanShapeDifference[],
  ) {
    super(
      `"${member}": refusing to apply. The change differs from the preview that was approved: ` +
        differences.map((d) => `${d.address}: ${d.reason}`).join("; ") +
        `. Plan it again.`,
    );
    this.name = "PlanShapeMovedError";
  }
}
