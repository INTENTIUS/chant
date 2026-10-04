/**
 * Gated waves (#3049): one change rolled out across many roots, a wave at a
 * time, each wave behind its own gate bound to that wave's set digest.
 *
 * `chant components fan-out --wave-gate` is the runner. This module holds the
 * parts that need no runner: how a set of roots is cut into waves, what a
 * wave's digest is, what its gate is called, and what the attempt record says
 * about each wave. They are kept apart from the runner because terragucci
 * calls them from its CI stages as one bundled file with no TypeScript
 * toolchain (#3421). Everything here imports `./change-set` and nothing else,
 * and `gated-waves-bundle.test.ts` holds that.
 *
 * ## The set digest
 *
 * A wave's digest is {@link changeSetDigest} over its members' `{ member,
 * planDigest }` pairs, the function #3181's change-set document uses. A
 * terraform-family member is named after its root, so this is the issue's
 * `jcs1-sha256` over sorted `{ root, planDigest }`, and a wave's digest equals
 * the change-set digest of the wave's members. Each member's plan digest is
 * the one a gate on that root alone binds (`terraformPlanDigest`, #2300), so a
 * one-root wave and a one-root `TerraformApplyOp` approve the same value.
 *
 * ## Why a wave is planned when it is reached
 *
 * A later wave planned up front reads outputs that do not exist yet. Planned
 * after the wave before it applied, its digest describes the real upstream
 * values, which is what an approver of that wave is shown.
 */

import { changeSetDigest } from "./change-set";

/** A root, or a component, as wave planning sees it: a name and what it reads. */
export interface WaveNode {
  name: string;
  /** Names this node reads from. A name outside the node set is already satisfied. */
  dependsOn?: readonly string[];
}

/** Thrown when a canary names something that is not in the set being planned. */
export class UnknownCanaryError extends Error {
  constructor(
    readonly canary: string,
    known: readonly string[],
  ) {
    super(`canary names "${canary}", which is not in this set (known: ${known.join(", ") || "none"})`);
    this.name = "UnknownCanaryError";
  }
}

/** Thrown when the nodes being layered depend on each other in a cycle. */
export class WaveCycleError extends Error {
  constructor(readonly members: string[]) {
    super(`dependency cycle among: ${members.join(", ")}`);
    this.name = "WaveCycleError";
  }
}

export interface LayerWavesOptions {
  /**
   * Nodes that form wave 1 whatever the graph says (#3049). Only those in the
   * set are placed; one outside it has nothing to apply. The rest follow in
   * dependency order, and a dependency on a canary counts as satisfied by
   * wave 1.
   */
  canary?: readonly string[];
  /**
   * Names known to exist outside `nodes`. A canary naming one of them is
   * left out quietly, since it is real but not part of this change; any
   * other unknown canary is refused. Defaults to `nodes` alone.
   */
  known?: readonly string[];
}

/**
 * Cut `nodes` into ordered waves: each node lands after every node it reads
 * from, and each wave is sorted by name so the same graph always produces the
 * same waves. With a canary list, those nodes are wave 1.
 *
 * A dependency on a name outside `nodes` does not hold a node back. That is
 * the subset case: the dependency already applied, or is not changing.
 */
export function layerWaves(nodes: readonly WaveNode[], options: LayerWavesOptions = {}): string[][] {
  const names = new Set(nodes.map((n) => n.name));
  const known = new Set([...names, ...(options.known ?? [])]);
  for (const canary of options.canary ?? []) {
    if (!known.has(canary)) throw new UnknownCanaryError(canary, [...known].sort());
  }
  const canaries = [...new Set((options.canary ?? []).filter((c) => names.has(c)))].sort();

  const waves: string[][] = canaries.length > 0 ? [canaries] : [];
  const remaining = new Set([...names].filter((n) => !canaries.includes(n)));
  const deps = new Map(nodes.map((n) => [n.name, (n.dependsOn ?? []).filter((d) => remaining.has(d))]));
  while (remaining.size > 0) {
    const wave = [...remaining].filter((n) => deps.get(n)!.every((d) => !remaining.has(d))).sort();
    if (wave.length === 0) throw new WaveCycleError([...remaining].sort());
    for (const n of wave) remaining.delete(n);
    waves.push(wave);
  }
  return waves;
}

/** One member of a wave: a root (or a component with no plannable step) and its plan digest. */
export interface WaveMember {
  member: string;
  planDigest: string;
  /** A provisional plan (`ChangeSetMember.provisional`, #3416). A wave refuses it. */
  provisional?: true;
}

/** Thrown when a wave's members include a provisional plan, which no gate may bind. */
export class ProvisionalWaveMemberError extends Error {
  constructor(readonly members: string[]) {
    super(
      `a wave cannot be gated on a provisional plan: ${members.join(", ")} planned before what it reads applied. ` +
        `Plan it again in its own wave, after its upstream applied`,
    );
    this.name = "ProvisionalWaveMemberError";
  }
}

/**
 * A wave's set digest: {@link changeSetDigest} over its members. Order does
 * not matter, and it moves whenever one member's plan digest does. A wave
 * naming one member twice has no digest and is refused, and so is a wave
 * holding a provisional plan (#3416): a gate bound to it would approve
 * values nobody has yet.
 */
export function waveSetDigest(members: readonly WaveMember[]): string {
  const provisional = members.filter((m) => m.provisional === true).map((m) => m.member);
  if (provisional.length > 0) throw new ProvisionalWaveMemberError([...new Set(provisional)].sort());
  return changeSetDigest(members);
}

/**
 * The gate a wave waits on: `<gate>-wave-<n>`, under the fan-out's op.
 *
 * One gate name per wave keeps each wave's approvals apart. With one name
 * shared by every wave, wave 2 would find wave 1's approval and report it as
 * an approval of another plan, which is true and useless. Wave numbers come
 * from the derivation, not from what is left to run, so wave 3 stays wave 3
 * on a resumed attempt and its approval still applies.
 */
export function waveGateName(gate: string, wave: number): string {
  return `${gate}-wave-${wave}`;
}

/** Where a wave got to. */
export type WaveStatus =
  /** Planned, and its gate is not approved for this digest. Nothing in it ran. */
  | "gated"
  /** Every member applied. */
  | "applied"
  /** At least one member failed to plan or to apply. Its dependents are blocked. */
  | "failed";

/**
 * One wave, as an attempt record and a run result carry it. The plan report
 * (#3349) reads these and points at the gate record rather than copying it:
 * `op` and `gate` name the ledger entry (`_gates/<op>.jsonl` on
 * `chant/lifecycle`).
 */
export interface WaveRecord {
  /** 1-based, from the derivation. */
  wave: number;
  op: string;
  /** The full gate name, {@link waveGateName}. */
  gate: string;
  /** What was planned in this wave on this attempt. */
  components: string[];
  /** The set digest the gate was decided against. */
  digest: string;
  members: WaveMember[];
  status: WaveStatus;
  /** Who approved this digest, once the gate passed. */
  approvedBy?: string;
  /** When the gate refused because an approval stands for another digest: that digest. */
  approved?: string;
  /** Components that failed to plan or to apply, with why. */
  failed?: Array<{ component: string; error?: string }>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Read the `waves` array of an attempt record, dropping anything malformed.
 * A record written before #3049 has none, which reads as no waves.
 */
export function readWaveRecords(value: unknown): WaveRecord[] {
  if (!Array.isArray(value)) return [];
  const out: WaveRecord[] = [];
  for (const raw of value) {
    if (!isObject(raw)) continue;
    const { wave, op, gate, digest, status } = raw;
    if (typeof wave !== "number" || typeof op !== "string" || typeof gate !== "string" || typeof digest !== "string") continue;
    if (status !== "gated" && status !== "applied" && status !== "failed") continue;
    const members = Array.isArray(raw.members)
      ? raw.members.filter(
          (m): m is WaveMember => isObject(m) && typeof m.member === "string" && typeof m.planDigest === "string",
        )
      : [];
    const failed = Array.isArray(raw.failed)
      ? raw.failed
          .filter((f): f is { component: string; error?: unknown } => isObject(f) && typeof f.component === "string")
          .map((f) => ({ component: f.component, ...(typeof f.error === "string" ? { error: f.error } : {}) }))
      : [];
    out.push({
      wave,
      op,
      gate,
      components: strings(raw.components),
      digest,
      members: members.map((m) => ({ member: m.member, planDigest: m.planDigest })),
      status,
      ...(typeof raw.approvedBy === "string" ? { approvedBy: raw.approvedBy } : {}),
      ...(typeof raw.approved === "string" ? { approved: raw.approved } : {}),
      ...(failed.length > 0 ? { failed } : {}),
    });
  }
  return out;
}

/** Put `record` in `records` in place of any earlier record for the same wave, sorted by wave. */
export function withWaveRecord(records: readonly WaveRecord[], record: WaveRecord): WaveRecord[] {
  return [...records.filter((r) => r.wave !== record.wave), record].sort((a, b) => a.wave - b.wave);
}

/**
 * The refusal for a wave whose set changed after it was approved: the digest
 * that was approved, the one planned now, and that nothing in the wave ran.
 */
export function describeChangedWave(record: Pick<WaveRecord, "wave" | "op" | "gate" | "digest" | "approved">): string {
  return (
    `wave ${record.wave} changed after it was approved, so nothing in it was applied. ` +
    `approved: ${record.approved ?? "(none)"}; planned now: ${record.digest}. ` +
    `Read the new plan, then approve it: chant approve ${record.op} ${record.gate} --plan ${record.digest}`
  );
}
