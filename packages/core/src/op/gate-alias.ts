/**
 * Gate aliases (#3949, epic #3946): the names a gate had before its Op was
 * restructured, so the approvals already on the ledger under them still
 * count.
 *
 * A gate's identity is its name and its Op's: the ledger is per Op
 * (`_gates/<op>.jsonl`) and every decision filters by gate. Merging three
 * per-tier Ops into one wave-driven Op renames every gate and orphans the
 * approvals recorded under the old names. A gate declares those names as
 * `aliases: [{ op?, gate }]`, `op` defaulting to its own Op.
 *
 * `evaluateGate` (`./gate.ts`) decides which approvals an alias admits, and
 * writes each one it counts again under the new name with `carriedFrom`
 * naming the line it came from. This module holds the parts that read only
 * the Op's config: where its gates are, what an alias resolves to, what the
 * builder and OPS017 refuse, and which gate aliases an old name, which
 * `chant approve` asks before it records an approval under that name.
 */

import type { GateAlias, GateStep, OpConfig, StepDefinition } from "./types";
import { gateName } from "./gate-name";

/** An alias with its Op filled in. */
export interface ResolvedGateAlias {
  op: string;
  gate: string;
}

/** Every gate step of `config`, main phases first, then `onFailure`, inside effects too, with the phase it sits in. */
export function gateStepsOf(config: Pick<OpConfig, "phases" | "onFailure">): Array<{ phase: string; step: GateStep }> {
  const out: Array<{ phase: string; step: GateStep }> = [];
  const visit = (phase: string, step: StepDefinition) => {
    if (step.kind === "gate") out.push({ phase, step });
    else if (step.kind === "effect") for (const nested of step.steps) visit(phase, nested);
  };
  for (const phase of [...config.phases, ...(config.onFailure ?? [])]) for (const step of phase.steps) visit(phase.name, step);
  return out;
}

/** A gate's aliases with each `op` filled in from `op`, the gate's own Op. */
export function resolveGateAliases(step: Pick<GateStep, "aliases">, op: string): ResolvedGateAlias[] {
  return (step.aliases ?? []).map((a) => ({ op: a.op ?? op, gate: a.gate }));
}

/** Why a gate's `aliases` can't stand on the step itself, one line each. The builder throws the first. */
export function gateAliasProblems(aliases: readonly GateAlias[], step: Pick<GateStep, "plan" | "point">): string[] {
  const problems: string[] = [];
  if (step.plan === undefined) {
    problems.push("aliases need a plan: an alias admits only approvals of the plan this run planned, and a gate with no plan has none");
  }
  if (step.point !== undefined) problems.push("a gate that asks a decision point can't take aliases");
  const seen = new Set<string>();
  for (const a of aliases) {
    if (typeof a?.gate !== "string" || a.gate === "") {
      problems.push("each alias names a gate");
      continue;
    }
    if (a.op !== undefined && (typeof a.op !== "string" || a.op === "")) problems.push(`alias ${JSON.stringify(a.gate)} names an empty op`);
    const key = `${a.op ?? ""}/${a.gate}`;
    if (seen.has(key)) problems.push(`alias ${a.op ? `${a.op}/` : ""}${a.gate} is listed twice`);
    seen.add(key);
  }
  return problems;
}

/** The gate of `ops` whose aliases include `op`/`gate`, or undefined when none does. */
export function aliasingGate(
  ops: Iterable<Pick<OpConfig, "name" | "phases" | "onFailure"> | undefined>,
  op: string,
  gate: string,
): { op: string; gate: string } | undefined {
  for (const config of ops) {
    if (!config || !Array.isArray(config.phases)) continue;
    for (const { step } of gateStepsOf(config)) {
      if (resolveGateAliases(step, config.name).some((a) => a.op === op && a.gate === gate)) return { op: config.name, gate: gateName(step) };
    }
  }
  return undefined;
}

/** One OPS017 finding: the Op, phase and gate it is about, and what is wrong. */
export interface GateAliasIssue {
  opName: string;
  phase: string;
  gate: string;
  message: string;
}

/**
 * OPS017's check (#3949) over every Op in a build. An alias must stand on a
 * gate bound to a plan that asks no decision point, must not name a gate
 * that still exists, must not name the gate itself, and must not be claimed
 * by two gates, since an approval would then be carried twice. When the
 * workspace's `identity.gates` names an alias, the new gate must be named
 * too, with the alias's class when it has one: `identityGates` maps each
 * gate the declaration names to its class (null for any signer). Absent,
 * outside a workspace, that part is skipped.
 */
export function validateGateAliases(
  ops: ReadonlyArray<Pick<OpConfig, "name" | "phases" | "onFailure">>,
  identityGates?: ReadonlyMap<string, string | null>,
): GateAliasIssue[] {
  const issues: GateAliasIssue[] = [];
  const existing = new Set<string>();
  for (const config of ops) for (const { step } of gateStepsOf(config)) existing.add(`${config.name}/${gateName(step)}`);
  const claimed = new Map<string, string>();

  for (const config of ops) {
    for (const { phase, step } of gateStepsOf(config)) {
      if (step.aliases === undefined) continue;
      const name = gateName(step);
      const issue = (message: string) => issues.push({ opName: config.name, phase, gate: name, message });
      for (const problem of gateAliasProblems(step.aliases, step)) issue(problem);
      for (const alias of resolveGateAliases(step, config.name)) {
        if (alias.gate === "") continue;
        const key = `${alias.op}/${alias.gate}`;
        if (alias.op === config.name && alias.gate === name) {
          issue(`alias ${key} is the gate's own name`);
          continue;
        }
        if (existing.has(key)) issue(`alias ${key} is still a gate; remove that gate, or this alias, so one approval doesn't answer two gates`);
        const owner = claimed.get(key);
        if (owner !== undefined && owner !== `${config.name}/${name}`) issue(`alias ${key} is also an alias of ${owner}, so its approvals would be carried twice`);
        else claimed.set(key, `${config.name}/${name}`);
        if (identityGates?.has(alias.gate)) {
          const want = identityGates.get(alias.gate) ?? null;
          if (!identityGates.has(name)) {
            issue(`identity.gates names its alias ${alias.gate}, so gate ${name} needs an identity.gates entry too, or approvals that needed a seal would count without one`);
          } else if (want !== null && identityGates.get(name) !== want) {
            issue(`identity.gates.${alias.gate} needs class ${want}, and identity.gates.${name} needs ${identityGates.get(name) ?? "any signer"}; the gate must keep its alias's class`);
          }
        }
      }
    }
  }
  return issues;
}
