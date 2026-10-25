/**
 * Plan shape conformance (#4425): the checks a lexicon's own tests run to
 * show that the {@link PlanShape}s its planner supplies on `CapabilityPlan`
 * work with core's comparison ({@link planShapeDifferences}).
 *
 * Core compares; the lexicon decides what a shape holds. A shape is useful to
 * core only when it is stable (the same plan gives the same digest) and
 * carries enough to tell a real change apart from the preview. The lexicon
 * supplies scenarios made by its own planner against its own mocks:
 *
 * - `preview`: a member planned with at least one unknown input. Called
 *   twice; both shapes must have the same {@link planShapeDigest}.
 * - `fresh`: the same member planned after the upstream applied, doing what
 *   the preview showed. No unknown inputs remain, and core must find no
 *   difference from the preview.
 * - `added`, `missing`, `replaced`: the real change adds a resource, drops a
 *   resource the preview changed and no unknown input drives, or replaces a
 *   resource the preview updated in place. Core must find a difference in
 *   each.
 *
 * Each scenario is also checked to be what it says, so a fixture that does
 * not add, drop or replace anything cannot pass by accident.
 *
 * Runner-neutral: {@link checkPlanShapeConformance} returns the problems,
 * none when the lexicon conforms. A vitest test asserts the list is empty.
 */

import { normalizePlanShape, planShapeDifferences, planShapeDigest, type PlanShape, type PlanShapeEntry } from "./covered-round";

type ShapeOf = () => PlanShape | undefined | Promise<PlanShape | undefined>;

export interface PlanShapeConformanceConfig {
  /** The lexicon's name, for the problems' wording. */
  lexicon: string;
  /** The member previewed with unknown inputs. Called twice. */
  preview: ShapeOf;
  /** The member planned after the upstream applied, matching the preview. Called twice. */
  fresh: ShapeOf;
  /** A real change that adds a resource the preview did not show. */
  added: ShapeOf;
  /** A real change without a resource the preview changed and no unknown input drives. */
  missing: ShapeOf;
  /** A real change that replaces a resource the preview updated in place. */
  replaced: ShapeOf;
}

const replaces = (e: PlanShapeEntry): boolean => e.action === "replace" || e.replacement === "true";

/** Problems with one shape on its own: what core assumes of every shape. */
export function planShapeProblems(shape: PlanShape): string[] {
  const out: string[] = [];
  const name = shape.member || "(no member)";
  if (!shape.member) out.push("a shape has no member");
  const seen = new Set<string>();
  for (const e of shape.entries) {
    if (!e.logicalId) out.push(`${name}: an entry has no logicalId`);
    const key = `${e.logicalId} ${e.action}`;
    if (seen.has(key)) out.push(`${name}: ${e.logicalId} is listed twice as ${e.action}`);
    seen.add(key);
    if (e.action === "update" && e.properties && e.unknown) {
      const stray = e.unknown.filter((p) => !e.properties!.includes(p));
      if (stray.length > 0) out.push(`${name}: ${e.logicalId} marks ${stray.join(", ")} unknown without changing them`);
    }
  }
  return out;
}

/** Every way the lexicon's shapes fall short of what core's comparison needs; none means it conforms. */
export async function checkPlanShapeConformance(config: PlanShapeConformanceConfig): Promise<string[]> {
  const out: string[] = [];
  const say = (problem: string): void => {
    out.push(`${config.lexicon}: ${problem}`);
  };
  const get = async (scenario: keyof Omit<PlanShapeConformanceConfig, "lexicon">): Promise<PlanShape | undefined> => {
    try {
      const shape = await config[scenario]();
      if (!shape) say(`${scenario} supplied no shape`);
      else for (const p of planShapeProblems(shape)) say(`${scenario}: ${p}`);
      return shape;
    } catch (e) {
      say(`${scenario} threw: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  const preview = await get("preview");
  const previewAgain = await get("preview");
  if (preview && previewAgain && planShapeDigest(preview) !== planShapeDigest(previewAgain)) {
    say("the same preview gave two shape digests");
  }
  if (preview && preview.unknownInputs.length === 0) say("the preview lists no unknown inputs");

  const fresh = await get("fresh");
  const freshAgain = await get("fresh");
  if (fresh && freshAgain && planShapeDigest(fresh) !== planShapeDigest(freshAgain)) {
    say("the same fresh plan gave two shape digests");
  }
  if (!preview) return out;
  if (fresh) {
    if (fresh.member !== preview.member) say(`fresh is of ${fresh.member}, the preview of ${preview.member}`);
    if (fresh.unknownInputs.length > 0) say(`fresh still lists unknown inputs: ${fresh.unknownInputs.join(", ")}`);
    const differences = planShapeDifferences(preview, fresh);
    if (differences.length > 0) say(`fresh matches the preview, yet core finds: ${differences.join("; ")}`);
  }

  const was = new Map(normalizePlanShape(preview).entries.map((e) => [e.logicalId, e]));
  const scenarios: { name: "added" | "missing" | "replaced"; is: (s: PlanShape) => boolean; claim: string }[] = [
    { name: "added", is: (s) => s.entries.some((e) => !was.has(e.logicalId)), claim: "has no resource the preview lacks" },
    {
      name: "missing",
      is: (s) => {
        const now = new Set(s.entries.map((e) => e.logicalId));
        return [...was.values()].some((p) => !now.has(p.logicalId) && (p.properties ?? []).some((x) => !(p.unknown ?? []).includes(x)));
      },
      claim: "drops no resource the preview changed beyond its unknown inputs",
    },
    {
      name: "replaced",
      is: (s) => s.entries.some((e) => replaces(e) && was.has(e.logicalId) && !replaces(was.get(e.logicalId)!) && was.get(e.logicalId)!.replacement !== "conditional"),
      claim: "replaces no resource the preview updated in place",
    },
  ];
  for (const { name, is, claim } of scenarios) {
    const shape = await get(name);
    if (!shape) continue;
    if (!is(shape)) say(`${name} ${claim}`);
    if (planShapeDifferences(preview, shape).length === 0) say(`core finds no difference from the preview in ${name}`);
  }
  return out;
}
