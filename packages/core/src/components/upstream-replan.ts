/**
 * Planning dependents again when an upstream's outputs change (#5345).
 *
 * Waves order a member after the members it reads, so a change that touches
 * both plans and applies them in turn. A dependent the change does not touch
 * is not planned: once its upstream applies with an output it reads changed,
 * it holds a value from before. This module finds those dependents and, for
 * the members that opt in, plans them. It never applies.
 *
 * - After an apply, each applied member's outputs are digested, one digest
 *   per output ({@link outputDigests}), and compared with the digests its
 *   last apply recorded on the environment's ledger
 *   (`<env>/outputs.jsonl` on `chant/lifecycle`, {@link OUTPUT_RECORDS_FILE}).
 *   Only digests are kept, never a value. A member with no record yet has
 *   nothing to compare with, and its first record is written.
 * - The reads between members come from every source chant orders waves by
 *   ({@link upstreamReadsOf}): `stackOutput()` references in a step's input,
 *   a capability's `groupReads` (a Terraform root's `terraform_remote_state`)
 *   and its `declaredReads` or `graphReads` (a Pulumi program's
 *   `StackReference`, after #5331). A read that names no output counts as a
 *   read of every output.
 * - The dependents of a changed output are listed for every applied member
 *   ({@link dependentsOfChange}). Members that applied in the same run are
 *   left out, since waves already ran them after their upstreams.
 * - For each applied member that `replanDependents` names (member names, or
 *   patterns where `*` matches within one path segment and `**` across), its
 *   dependents are planned with `planPrSet`, as a pull request's members are,
 *   and the set's digest goes to the gate the caller decides
 *   ({@link ReplanOptions.decide}): the pending fact's description names the
 *   upstream change. Nothing here calls a capability's `run`. An apply of the
 *   plan goes through the dependent's own pipeline and its gate.
 *
 * Off by default: with no member named, the dependents are listed and
 * nothing is planned.
 */

import { NEXT_RELEASE } from "../release-floors";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { opWaveRunMatches } from "../op/op-waves";
import type { PrApproval, PrMember } from "../pr-loop";
import type { CapabilityRegistry, DeployContext } from "./capability";
import { graphReadsOf } from "./declared-reads";
import { wiringReferencesAt, type DriverComponent } from "./driver";
import { planFanOut, type FanOutPlan } from "./fan-out";
import { capabilityGroupReads } from "./groups";
import { componentForEnvironment } from "./step-environments";
import { capabilitySteps } from "./wave-plan";
import type { PrPlanSet } from "./pr-run";

/**
 * The first chant that compares a member's outputs after an apply with the
 * ones its last apply recorded, lists the dependents that read a changed
 * output, and plans them for the members `replanDependents` names, with
 * `chant components replan` and `replanAfterApply` (#5345).
 */
export const UPSTREAM_REPLAN_FLOOR = NEXT_RELEASE;

/** The ledger file an environment's output records are kept in, beside its `releases.jsonl`. */
export const OUTPUT_RECORDS_FILE = "outputs.jsonl";

/** The suffix of the gate a re-plan waits at: `<gate>-replan`. */
export function replanGate(gate: string): string {
  return `${gate}-replan`;
}

/** One line of `<env>/outputs.jsonl`: a member's output digests after an apply. */
export interface OutputRecord {
  version: 1;
  kind: "outputs";
  member: string;
  env: string;
  /** Output name to its digest. Never a value. */
  digests: Record<string, string>;
  at: string;
  /** The commit the apply ran at, when known. */
  gitSha?: string;
}

/** Where output records are read and written. */
export interface OutputRecordPort {
  read(env: string): Promise<OutputRecord[]>;
  append(env: string, records: readonly OutputRecord[]): Promise<void>;
}

/** {@link OutputRecordPort} on `chant/lifecycle`, at `<env>/outputs.jsonl`. */
export function gitOutputRecordPort(opts: { cwd?: string } = {}): OutputRecordPort {
  return {
    async read(env) {
      const { readBlobFromPath } = await import("../lifecycle/git");
      return parseOutputRecords((await readBlobFromPath(env, OUTPUT_RECORDS_FILE, opts)) ?? "");
    },
    async append(env, records) {
      const { appendLedgerLine } = await import("../lifecycle/git");
      for (const r of records) await appendLedgerLine(env, OUTPUT_RECORDS_FILE, JSON.stringify(r), `chant: outputs of ${r.member} in ${env}`, opts);
    },
  };
}

/** The records in a ledger file's text, malformed lines left out. */
export function parseOutputRecords(text: string): OutputRecord[] {
  const out: OutputRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as Partial<OutputRecord>;
      if (r.kind === "outputs" && typeof r.member === "string" && typeof r.env === "string" && r.digests && typeof r.digests === "object") out.push(r as OutputRecord);
    } catch {
      // A line that does not read is skipped.
    }
  }
  return out;
}

/** Each output's digest, by name. Values are digested, never kept. */
export function outputDigests(outputs: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(outputs)
      .sort()
      .map((name) => [name, computePlanDigest("output", outputs[name] ?? null)]),
  );
}

/** The outputs whose digest differs between `before` and `after`, added and removed ones too, sorted. */
export function changedOutputs(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => before[n] !== after[n]).sort();
}

/** A read of one member's output by another, and where chant found it. */
export interface UpstreamRead {
  reader: string;
  upstream: string;
  /** The output read. Absent when the source names none: the read counts for every output. */
  output?: string;
  /** `wiring`: a `stackOutput()` in the step. `group`: `groupReads`. `declared`: `declaredReads` or `graphReads`. */
  via: "wiring" | "group" | "declared";
}

/**
 * Every read between `components` (#5345): `stackOutput()` references in
 * their steps, the reads capabilities report through `groupReads`, and those
 * they report through `graphReads` or `declaredReads`, each step read for
 * `env`. A capability that throws reports none. Sorted, each once.
 */
export async function upstreamReadsOf(
  components: readonly DriverComponent[],
  registry: CapabilityRegistry,
  root: string,
  ctxOf: (component: string) => DeployContext,
  env: string,
): Promise<UpstreamRead[]> {
  const names = new Set(components.map((c) => c.name));
  const found = new Map<string, UpstreamRead>();
  const add = (r: UpstreamRead): void => {
    if (r.reader === r.upstream || !names.has(r.reader) || !names.has(r.upstream)) return;
    found.set(`${r.reader}\u0000${r.upstream}\u0000${r.output ?? ""}\u0000${r.via}`, r);
  };
  for (const c of components) {
    const resolved = componentForEnvironment(c, env).component;
    for (const step of capabilitySteps(resolved.deploy)) {
      const { kind: _kind, ...rest } = step;
      for (const ref of wiringReferencesAt(rest)) add({ reader: c.name, upstream: ref.source, ...(ref.output ? { output: ref.output } : {}), via: "wiring" });
    }
  }
  for (const r of await capabilityGroupReads(components, registry, env, ctxOf)) add({ reader: r.reader, upstream: r.upstream, ...(r.output ? { output: r.output } : {}), via: "group" });
  for (const r of await graphReadsOf(components, registry, root, { env })) {
    if (r.upstream !== undefined) add({ reader: r.reader, upstream: r.upstream, ...(r.output ? { output: r.output } : {}), via: "declared" });
  }
  return [...found.values()].sort(
    (a, b) => a.reader.localeCompare(b.reader) || a.upstream.localeCompare(b.upstream) || (a.output ?? "").localeCompare(b.output ?? "") || a.via.localeCompare(b.via),
  );
}

/** A dependent of a changed upstream: the changed outputs it reads. */
export interface ChangedDependent {
  member: string;
  /** The changed outputs it reads, sorted. A read naming no output lists every changed one. */
  outputs: string[];
}

/** The members that read one of `changed` of `upstream`, each with the outputs, sorted by member. */
export function dependentsOfChange(upstream: string, changed: readonly string[], reads: readonly UpstreamRead[]): ChangedDependent[] {
  if (changed.length === 0) return [];
  const by = new Map<string, Set<string>>();
  for (const r of reads) {
    if (r.upstream !== upstream) continue;
    const hit = r.output === undefined ? changed : changed.filter((o) => o === r.output);
    if (hit.length === 0) continue;
    const set = by.get(r.reader) ?? new Set<string>();
    for (const o of hit) set.add(o);
    by.set(r.reader, set);
  }
  return [...by].map(([member, outputs]) => ({ member, outputs: [...outputs].sort() })).sort((a, b) => a.member.localeCompare(b.member));
}

/** Whether `patterns` names `member`. */
export function replanNames(patterns: readonly string[], member: string): boolean {
  return patterns.some((p) => opWaveRunMatches(p, member));
}

/** What changed in one applied member, and who reads it. */
export interface UpstreamChange {
  member: string;
  /** The outputs whose digest moved since the last record, sorted. */
  changed: string[];
  /** No record stood before this apply, so nothing was compared. */
  first?: true;
  /** The members outside the apply that read a changed output. */
  dependents: ChangedDependent[];
  /** Whether `replanDependents` names the member, so its dependents are planned. */
  replan: boolean;
}

/** The plan of the dependents, and where its gate stands. */
export interface ReplanPlanned {
  gate: string;
  digest: string;
  /** The planned components, in plan order. */
  components: string[];
  members: PrMember[];
  approval: PrApproval;
  /** A component failed to plan; nothing was sent to the gate. */
  failed: boolean;
  /** The pending fact's description: the upstream change that started the plan. */
  description: string;
}

/** What {@link replanAfterApply} found and did. */
export interface ReplanResult {
  env: string;
  changes: UpstreamChange[];
  /** Absent when no member that opted in changed an output a dependent reads, or under `dryRun`. */
  planned?: ReplanPlanned;
  /** Records written for the applied members whose digests moved, or that had none. */
  recorded: string[];
}

/** How {@link replanAfterApply} plans the dependents. */
export type ReplanPlanner = (input: { components: DriverComponent[]; plan: FanOutPlan; registry: CapabilityRegistry; env: string; vars?: Record<string, unknown> }) => Promise<PrPlanSet>;

export interface ReplanOptions {
  /** Every component in the project, declared reads applied. */
  components: DriverComponent[];
  registry: CapabilityRegistry;
  root: string;
  env: string;
  vars?: Record<string, unknown>;
  /** The members that applied, each with the outputs standing after the apply. */
  applied: Record<string, Record<string, unknown>>;
  /** The members whose dependents are planned (`replanDependents`). Empty: list only. */
  replanDependents: readonly string[];
  records: OutputRecordPort;
  /** The gate the plan waits at, before {@link replanGate}. */
  gate: string;
  /**
   * Record the plan at its gate and say where the approval stands. Called
   * once with the set's digest and a description naming the upstream
   * change. The plan never applies here, whatever it answers.
   */
  decide: (input: { gate: string; set: PrPlanSet; description: string }) => Promise<PrApproval>;
  /** Plans the dependents. Default `planPrSet`. */
  planner?: ReplanPlanner;
  /** List and record nothing, plan nothing. */
  dryRun?: boolean;
  gitSha?: string;
  now?: () => string;
}

/** The description a re-plan's pending fact carries: each upstream change, and who reads it. */
export function replanDescription(changes: readonly UpstreamChange[], gitSha?: string): string {
  const parts = changes
    .filter((c) => c.replan && c.dependents.length > 0)
    .map((c) => `${c.member} applied${gitSha ? ` at ${gitSha.slice(0, 12)}` : ""} with ${c.changed.join(", ")} changed, read by ${c.dependents.map((d) => d.member).join(", ")}`);
  return `planned again after an upstream output changed: ${parts.join("; ")}`;
}

/** Compare, record, list, and for the members that opt in, plan the dependents. Never applies. */
export async function replanAfterApply(options: ReplanOptions): Promise<ReplanResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const ctxOf = (component: string): DeployContext => ({ env: options.env, component, ...(options.vars ? { vars: options.vars } : {}) });
  const reads = await upstreamReadsOf(options.components, options.registry, options.root, ctxOf, options.env);
  const prior = new Map<string, OutputRecord>();
  for (const r of await options.records.read(options.env)) if (r.env === options.env) prior.set(r.member, r);

  const appliedNames = new Set(Object.keys(options.applied));
  const changes: UpstreamChange[] = [];
  const toRecord: OutputRecord[] = [];
  for (const member of [...appliedNames].sort()) {
    const digests = outputDigests(options.applied[member]!);
    const before = prior.get(member);
    const changed = before ? changedOutputs(before.digests, digests) : [];
    if (!before || changed.length > 0) toRecord.push({ version: 1, kind: "outputs", member, env: options.env, digests, at: now(), ...(options.gitSha ? { gitSha: options.gitSha } : {}) });
    const dependents = dependentsOfChange(member, changed, reads).filter((d) => !appliedNames.has(d.member));
    changes.push({ member, changed, ...(before ? {} : { first: true as const }), dependents, replan: replanNames(options.replanDependents, member) });
  }
  if (options.dryRun) return { env: options.env, changes, recorded: [] };
  await options.records.append(options.env, toRecord);

  const starting = changes.filter((c) => c.replan && c.dependents.length > 0);
  const result: ReplanResult = { env: options.env, changes, recorded: toRecord.map((r) => r.member) };
  if (starting.length === 0) return result;

  const dependents = [...new Set(starting.flatMap((c) => c.dependents.map((d) => d.member)))].sort();
  const plan = planFanOut({ components: options.components, changed: dependents });
  const planner = options.planner ?? (async (input) => (await import("./pr-run")).planPrSet(input));
  const set = await planner({ components: options.components, plan, registry: options.registry, env: options.env, ...(options.vars ? { vars: options.vars } : {}) });
  const gate = replanGate(options.gate);
  const description = replanDescription(changes, options.gitSha);
  const approval: PrApproval = set.failed ? { status: "pending" } : await options.decide({ gate, set, description });
  result.planned = { gate, digest: set.doc.digest, components: plan.order, members: set.members, approval, failed: set.failed, description };
  return result;
}

/** The note a re-plan leaves: each upstream change, who reads it, and the plan's gate. Markdown. */
export function replanNote(result: ReplanResult, op: string): string {
  const lines: string[] = [`### Dependents of changed outputs in ${result.env}`, ""];
  const moved = result.changes.filter((c) => c.dependents.length > 0);
  if (moved.length === 0) lines.push("No applied member changed an output another member reads.");
  for (const c of moved) {
    lines.push(`- \`${c.member}\` changed ${c.changed.map((o) => `\`${o}\``).join(", ")}, read by ${c.dependents.map((d) => `\`${d.member}\` (${d.outputs.join(", ")})`).join(", ")}${c.replan ? "" : "; its dependents are listed, and `replanDependents` names it to plan them"}.`);
  }
  const p = result.planned;
  if (p) {
    lines.push("", `Planned again because ${p.description.replace(/^planned again after an upstream output changed: /, "")}.`);
    if (p.failed) lines.push("", `A dependent failed to plan, so the plan was not sent to the gate.`);
    else {
      lines.push("", `Plan \`${p.digest}\` over ${p.components.map((c) => `\`${c}\``).join(", ")} waits at gate \`${p.gate}\`: ${p.approval.status}.`);
      lines.push("", `It applies through the dependents' own pipeline once approved: \`chant approve ${op} ${p.gate} --plan ${p.digest}\`.`);
    }
  }
  return `${lines.join("\n")}\n`;
}
