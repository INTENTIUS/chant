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
/**
 * The only shape this walk reads: something with `steps`, whose entries may
 * carry a `kind` and may themselves nest. Both `Phase` (./component.ts) and
 * `DriverPhase` (./driver.ts) satisfy it — they differ on how a gate step is
 * typed, which this module never looks at — so declaring the narrower of the
 * two would force a cast on one caller for no gain in safety, given the walk
 * discriminates structurally anyway.
 */
export interface UnitBearingPhase {
  steps: readonly unknown[];
}

/** A deploy-family step kind that names a live unit, and who observes it. */
export interface DeployUnitRule {
  /** The step `kind` (the capability's registered name). */
  kind: string;
  /** The step field carrying the unit's name (`stack`, `release`). */
  field: string;
  /** The lexicon whose `describeStackStatus` reads this kind of unit. */
  lexicon: string;
  /**
   * The unit from the whole step, when `field` alone does not name it
   * uniquely. Undefined skips the step, as a missing `field` does.
   */
  unitOf?: (step: Record<string, unknown>) => string | undefined;
}

/**
 * A Pulumi stack's unit: `<dir>/<stack>`, or `<stack>` for a project at the
 * project root. `dir` is where `Pulumi.yaml` is, relative to the project root,
 * so two projects with a `dev` stack are two units. The pulumi lexicon's
 * `changedUnits` answers with the same names.
 */
export function pulumiStackUnit(dir: string, stack: string): string {
  const d = dir.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return d === "" || d === "." ? stack : `${d}/${stack}`;
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
  // GitOps verbs apply the controller's CR through that same pipeline — the
  // unit is the CR itself under its stack label, observed by the identical
  // label sweep (#1549 piece 2).
  { kind: "argo-app", field: "stack", lexicon: "k8s" },
  { kind: "flux-reconcile", field: "stack", lexicon: "k8s" },
  { kind: "helm-upgrade", field: "release", lexicon: "helm" },
  // A Terraform-family root (#3049). Its unit is the root's name in
  // `terraform.roots`, which is also the member a gated wave's digest names.
  { kind: "terraform-apply", field: "root", lexicon: "terraform" },
  // An ARM template applied into one resource group (#4273). Its unit is the group.
  { kind: "arm-deploy", field: "resourceGroup", lexicon: "azure" },
  // A Config Connector manifest applied over REST (#4273). Its unit is the
  // step's `stack`, the member its plan names.
  { kind: "gcp-apply", field: "stack", lexicon: "gcp" },
  // Another workspace member's outputs (#4455). Its unit is the member, so a
  // change signal naming the member puts the component in the change. No
  // lexicon observes it: the member's own pipeline reports its status.
  { kind: "member-outputs", field: "member", lexicon: "workspace" },
  // A Pulumi stack (plywood#22). Its unit is the stack qualified by the
  // project's directory (`pulumiStackUnit`), which the pulumi lexicon's
  // `changedUnits` names for a changed stack config or program file.
  {
    kind: "pulumi-up",
    field: "stack",
    lexicon: "pulumi",
    unitOf: (s) => (typeof s.stack === "string" && s.stack !== "" ? pulumiStackUnit(typeof s.dir === "string" ? s.dir : ".", s.stack) : undefined),
  },
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
export function deployUnits(deploy: readonly UnitBearingPhase[]): DeployUnit[] {
  const byKind = new Map(DEPLOY_UNIT_RULES.map((r) => [r.kind, r]));
  const seen = new Set<string>();
  const units: DeployUnit[] = [];
  const walkSteps = (steps: readonly unknown[]): void => {
    for (const step of steps) {
      // A step may itself be a nested Phase (it carries its own `steps`). Step
      // is open-typed (capability inputs), so discriminate structurally.
      const nested = (step as { steps?: unknown }).steps;
      if (Array.isArray(nested)) {
        walkSteps(nested as readonly unknown[]);
        continue;
      }
      const s = step as { kind?: string } & Record<string, unknown>;
      const rule = s.kind ? byKind.get(s.kind) : undefined;
      if (!rule) continue;
      const unit = rule.unitOf ? rule.unitOf(s) : s[rule.field];
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
