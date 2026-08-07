/**
 * Deploy units — which live unit(s) a component's composition targets (#1495).
 *
 * `chant components status --live` (and `chant graph --live`) need to know
 * what a component deployed in order to observe it. That answer used to be a
 * string literal in the walk — `kind === "cfn-deploy"` — which made the whole
 * chain CloudFormation-shaped: a component whose deploy phase is a server-side
 * apply or a Helm upgrade contributed nothing and was skipped, not
 * "unobserved", simply absent from the result.
 *
 * This module is the seam that fixes the walk (piece 1 of #1495's
 * decomposition): a registry mapping a deploy-family step `kind` to the field
 * naming its unit and the lexicon whose `describeStackStatus` can observe it.
 * The registry is data, not a rule about what steps look like — a kind not
 * listed here contributes no unit, exactly as before.
 */
import type { Phase } from "./component";

/** A deploy-family step kind that names a live unit, and who observes it. */
export interface DeployUnitRule {
  /** The step `kind` (the capability's registered name). */
  kind: string;
  /** The step field carrying the unit's name (`stack`, `release`). */
  field: string;
  /** The lexicon whose `describeStackStatus` reads this kind of unit. */
  lexicon: string;
}

/**
 * The deploy-family kinds that name a unit. cfn-deploy's unit is its stack;
 * kubectl-apply's is the ownership stack its labels carry (#1495 piece 2);
 * helm-upgrade's is its release (#1495 piece 4). Listing a kind here is safe
 * before its lexicon implements `describeStackStatus` — units whose lexicon
 * has no observer are skipped by the caller, the same absent-observer path as
 * before.
 */
export const DEPLOY_UNIT_RULES: readonly DeployUnitRule[] = [
  { kind: "cfn-deploy", field: "stack", lexicon: "aws" },
  { kind: "kubectl-apply", field: "stack", lexicon: "k8s" },
  // kustomize renders, then applies through the same stack-labelled pipeline —
  // so its unit is observed by the identical label sweep (#1548).
  { kind: "kustomize-apply", field: "stack", lexicon: "k8s" },
  { kind: "helm-upgrade", field: "release", lexicon: "helm" },
];

/** One resolved unit a component's deploy composition targets. */
export interface DeployUnit {
  /** The unit's name — a stack, a release. */
  unit: string;
  /** The lexicon that observes this kind of unit. */
  lexicon: string;
}

/**
 * Every distinct deploy unit a component's phases target, in declaration
 * order. A step may itself be a nested `Phase`, so the walk recurses; a
 * resolved component carries the unit as a concrete string. Pure.
 */
export function deployUnits(deploy: Phase[]): DeployUnit[] {
  const byKind = new Map(DEPLOY_UNIT_RULES.map((r) => [r.kind, r]));
  const seen = new Set<string>();
  const units: DeployUnit[] = [];
  const walkSteps = (steps: Phase["steps"]): void => {
    for (const step of steps) {
      // A step may itself be a nested Phase (it carries its own `steps`). Step
      // is open-typed (capability inputs), so discriminate structurally.
      const nested = (step as { steps?: unknown }).steps;
      if (Array.isArray(nested)) {
        walkSteps(nested as Phase["steps"]);
        continue;
      }
      const s = step as { kind?: string } & Record<string, unknown>;
      const rule = s.kind ? byKind.get(s.kind) : undefined;
      if (!rule) continue;
      const unit = s[rule.field];
      if (typeof unit !== "string" || unit.length === 0) continue;
      const key = `${rule.lexicon}\0${unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      units.push({ unit, lexicon: rule.lexicon });
    }
  };
  for (const phase of deploy) walkSteps(phase.steps);
  return units;
}
