/**
 * What a promote reads from the folded pipeline (#5324).
 *
 * `chant components promote --to <stage>` in a member with a pipeline reads
 * it at the default branch's tip (`./read.ts`'s `promoteBase`):
 *
 * 1. A held stage, or one in a freeze window, refuses with exit 3 and says
 *    until when.
 * 2. `--from` defaults to the stage before; a promote that skips a stage is
 *    refused, as with `environments`. `--allow-skip` passes only through
 *    each skipped stage's gate: gate `<stage>-skip` under the pipeline's
 *    op, bound to the promoted digest, unless that stage's gate policy is
 *    `never`. A held skipped stage refuses too. Each skip is recorded on
 *    `_gates/<pipeline>/applied.jsonl`, which spends the approval it went
 *    through.
 * 3. The target stage's gate: gate `<stage>` under the pipeline's op, bound
 *    to the release's digest (or the promoted digests'), with the stage's
 *    quorum rules. A policy of `never` lets it through; `always` and
 *    `on-destructive` wait, since a promote has no plan to call destructive
 *    before it is gated.
 *
 * Before the gates, the soak of the stage promoted from (#5326,
 * `./soak-gate.ts`): while it holds, the promote records the soak's pending
 * fact (gate `<from>-soak`) and exits 3 with the time left. Its clock starts
 * at the newest apply of the promoted components in the `from` stage's
 * release ledger. Then the soak of each canary stage `to` follows (#5327,
 * `canaryStagesBefore`), through the canary's own gate `<canary>-soak` and
 * its own clock: a promote from a later stage reads it again, and a skip
 * past the canary finds no apply there and holds until a person ends the
 * canary's soak early.
 *
 * A gate that waits records its pending fact and the promote exits 3, as a
 * gated run does; `chant approve <pipeline> <gate> --plan <digest>` passes it.
 *
 * A stage that names `after` (#5353) follows those stages: `--from`
 * defaults to the first it names and must be one of them, and the stage
 * opens for a release only once that release applied in each, read from
 * the stage log (`../lifecycle/stage-log.ts`); the first stage counts when
 * its ledger holds a deploy of the release's commit. Until then the promote
 * exits 3. `--allow-skip` takes each stage still missing through its skip
 * gate. A stage with `queue: "replace"` takes one release at a time: a
 * newer release waiting replaces an older one, and a release that waits
 * while another is in the stage exits 3 until that one finishes.
 *
 * A release rejected at a stage's gate (#5354, `chant reject <pipeline>
 * <stage>`) does not enter the stage, and is not skipped past it: the
 * promote exits 8 and says who rejected it and why, before any approval is
 * read, so more approvals never clear it. A rejection counts by the proof
 * rules the gate's approvals count by (`../op/gate-reject.ts`): the gate's
 * `approval` mode (a `sealed` gate counts sealed approvals and rejections
 * only), the workspace's `identity.gates` rule, and the gate's rules.
 * The urgent path (#5355), `promote --urgent --release <label>` into a stage
 * whose gate declares `urgent: { role }`: the stage's gate passes on one
 * approval of gate `<stage>-urgent`, bound to the release's digest, from an
 * approver who holds the role and whose approval a seal against the signers
 * at base proves. A plain `chant approve` line never counts, whatever the
 * stage's approval mode. Holds, freeze windows and a pause still refuse it.
 * It skips no stage, `--allow-skip` or not, and the release must have
 * succeeded in every stage upstream of the one promoted to
 * ({@link urgentUpstreamStages}).
 *
 * A promote under a release reads the change risk its cut carries (#5387,
 * `../lifecycle/release-risk.ts`) at each gate whose stage sets
 * `holds.risk`. Over the stage's threshold the gate takes the risk's
 * `quorum` rules on top of its own, and a gate whose policy is `never` waits
 * for an approval of its own. The gate then counts only people's approvals,
 * and a permit that reads the score only from a person `.chant/trust.json`
 * at base proves. A release with no record, or a stage with no `holds.risk`,
 * has the gate it had before.
 */

import { createHash } from "node:crypto";
import { approveCommand, evaluateGate, type GateApprovalRule, type GateLedgerPort } from "../op/gate";
import { canaryStagesBefore, pipelineTracksStages, stageUpstreams, type PipelineSpec, type PipelineStage } from "./spec";
import { replacedIn, stageQueueOf, succeededIn, type StageLine, type StageLogPort } from "../lifecycle/stage-log";
import { gateRejections, rejectionLine } from "../op/gate-reject";
import { gateSealRefusal, type GateSigners } from "../lifecycle/gate-seal";
import type { GateRejectionRecord } from "../lifecycle/gate-rejection";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import { stageHeldAt, stageHeldLine } from "./stages";
import { stageRiskContext, stageRiskRead, type ReleaseRisk } from "../lifecycle/release-risk";
import type { ResolvedGateApproval } from "../op/gate-approval";
import { soakAtGate, stageSoakGate, type SoakGateInput, type SoakGateOutcome } from "./soak-gate";
import type { SoakCheckReader } from "./soak";

/** A refusal or a wait, with the exit code the promote ends with. */
export interface PipelinePromoteStop {
  exitCode: number;
  message: string;
  hint?: string;
  code?:
    | "pipeline-stage-held"
    | "promote-skips-environment"
    | "promote-no-previous-environment"
    | "pipeline-gate-waiting"
    | "pipeline-from-not-upstream"
    | "pipeline-join-needs-release"
    | "pipeline-upstream-waiting"
    | "pipeline-release-replaced"
    | "pipeline-stage-busy"
    | "pipeline-release-rejected"
    | "pipeline-stage-paused"
    | "pipeline-release-superseded"
    | "pipeline-no-urgent-rule"
    | "pipeline-urgent-skips"
    | "pipeline-urgent-upstream"
    | "pipeline-soak-waiting";
  /** Lines the promote prints before the stop, such as a rejection that does not count and why (#5354). */
  lines?: string[];
}

/**
 * What proves who approved or rejected at a stage's gate (#5354): the
 * signers and passkeys, and the role grants, at the commit the gate is read
 * at. Absent, nothing proves anyone: a `sealed` gate passes nothing, and
 * counts no rejection.
 */
export interface PipelineGateProof {
  signers: GateSigners;
  roles: Readonly<Record<string, readonly string[]>>;
}

const NO_PROOF: PipelineGateProof = { signers: { base: null, signersPath: ".chant/allowed_signers", active: false, signers: [], problems: [] }, roles: {} };

/** The digest a stage gate binds when there is no release: the components and digests promoted, in order. */
export function promotedDigest(items: readonly { component: string; digest: string }[]): string {
  const canonical = JSON.stringify([...items].map((i) => [i.component, i.digest]).sort());
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * The order and holds part, before anything is planned: the stage promoted
 * from, or a stop. `undefined` when the pipeline has no stage `to`, so the
 * pipeline has nothing to say about it.
 */
export function pipelinePromoteSource(input: {
  spec: PipelineSpec;
  to: string;
  from?: string;
  allowSkip?: boolean;
  /** `--urgent` (#5355): the stage must declare an urgent rule, and no stage is skipped. */
  urgent?: boolean;
  now: Date;
}): { from: string; skipped: PipelineStage[]; upstreams?: string[] } | PipelinePromoteStop | undefined {
  const { spec, to, now } = input;
  const names = spec.stages.map((s) => s.name);
  const toAt = names.indexOf(to);
  if (toAt < 0) return undefined;
  const held = stageHeldAt(spec.stages[toAt]!, now);
  if (held) return { exitCode: 3, code: "pipeline-stage-held", message: stageHeldLine(held), hint: held.until ? `Promote again after ${held.until}.` : "Lift the hold in the pipeline's config and merge the change." };
  // #5355: --urgent takes the stage's urgent rule, so a stage without one has no urgent path.
  if (input.urgent && !spec.stages[toAt]!.gate?.urgent) {
    return { exitCode: 1, code: "pipeline-no-urgent-rule", message: `stage "${to}" of the pipeline "${spec.name}" declares no urgent rule, so --urgent has no gate to pass`, hint: `Promote without --urgent, or declare gate.urgent: { role } on the stage.` };
  }
  // #5353: a stage that names its upstream stages opens on the release's outcome in each, read once the release is known.
  const after = spec.stages[toAt]!.after;
  if (after !== undefined) {
    const from = input.from ?? after[0]!;
    if (!after.includes(from)) {
      return {
        exitCode: 1,
        code: "pipeline-from-not-upstream",
        message: `stage "${to}" follows ${after.join(", ")} in the pipeline "${spec.name}", so a release is promoted into it from one of them, not from ${from}`,
        hint: `Promote from ${after[0]}, or leave out --from.`,
      };
    }
    return { from, skipped: [], upstreams: [...after] };
  }
  const from = input.from ?? (toAt > 0 ? names[toAt - 1] : undefined);
  if (from === undefined) {
    return { exitCode: 1, code: "promote-no-previous-environment", message: `"${to}" is the first stage of the pipeline "${spec.name}" (${names.join(", ")}): a merge applies it, so there is nothing to promote from` };
  }
  const fromAt = names.indexOf(from);
  const skipped = fromAt >= 0 && fromAt < toAt - 1 ? spec.stages.slice(fromAt + 1, toAt) : [];
  if (input.urgent) {
    if (skipped.length > 0) {
      return {
        exitCode: 1,
        code: "pipeline-urgent-skips",
        message: `promoting ${from} to ${to} skips ${skipped.map((s) => s.name).join(", ")}, and the urgent path skips no stage`,
        hint: `Promote the release to ${skipped[0]!.name} first.`,
      };
    }
  }
  if (skipped.length > 0 && !input.allowSkip) {
    return {
      exitCode: 1,
      code: "promote-skips-environment",
      message: `promoting ${from} to ${to} skips ${skipped.map((s) => s.name).join(", ")} in the pipeline's stage order (${names.join(", ")})`,
      hint: `Promote to ${skipped[0]!.name} first, or pass --allow-skip to go through the gate of each stage skipped.`,
    };
  }
  for (const s of skipped) {
    const h = stageHeldAt(s, now);
    if (h) return { exitCode: 3, code: "pipeline-stage-held", message: `${stageHeldLine(h)}; a skip goes through it, so nothing is promoted past it either` };
  }
  return { from, skipped };
}

/** What {@link pipelinePromoteGates} decided: every gate passed, or the stop. */
export type PipelineGatesOutcome = { passed: true; lines: string[]; urgent?: { approval: GateResolutionRecord; role: string } } | ({ passed: false } & PipelinePromoteStop);

/**
 * The reader of the rejections at a stage's gates (#5354): the pipeline's
 * rejection ledger read once, each rejection that does not count noted in
 * `lines`, and the stop for the first gate a standing rejection names.
 */
function rejectionReader(input: {
  spec: PipelineSpec;
  digest: string;
  releaseDigest?: string;
  port: GateLedgerPort;
  proof?: PipelineGateProof;
  identityOf: (gate: string) => Promise<GateApprovalRule | null>;
  lines: string[];
}): (stage: PipelineStage, gates: readonly string[]) => Promise<({ passed: false } & PipelinePromoteStop) | undefined> {
  const { spec, port, digest, lines } = input;
  const proof = input.proof ?? NO_PROOF;
  let rejectionLedger: GateRejectionRecord[] | undefined;
  const rejectedAt = async (stage: PipelineStage, gate: string): Promise<GateRejectionRecord[]> => {
    rejectionLedger ??= (await port.readRejections?.(spec.name)) ?? [];
    const identity = await input.identityOf(gate);
    const found = gateRejections(rejectionLedger, {
      gate,
      planDigest: digest,
      environment: stage.name,
      ...(input.releaseDigest !== undefined ? { releaseDigest: input.releaseDigest } : {}),
      mode: stage.gate?.approval ?? "ledger",
      ...(stage.gate?.quorum ? { quorum: stage.gate.quorum } : {}),
      signers: proof.signers,
      roles: proof.roles,
      identity: identity ? (identity.refusesRejection ?? (() => `the workspace's rule for gate ${gate} judges no rejection here`)) : null,
    });
    for (const { rejection, why } of found.ignored) lines.push(`${spec.name} ${gate}: the rejection by ${rejection.rejectedBy} does not count: ${why}`);
    return found.standing;
  };
  return async (stage, gates) => {
    for (const gate of gates) {
      const standing = await rejectedAt(stage, gate);
      if (standing.length === 0) continue;
      const what = input.releaseDigest !== undefined ? `release ${input.releaseDigest}` : `the promotion ${digest}`;
      return {
        passed: false,
        exitCode: 8,
        code: "pipeline-release-rejected",
        message: `${what} was rejected at ${spec.name} ${gate}, so it does not enter stage ${stage.name}: ${standing.map(rejectionLine).join("; ")}`,
        hint: "A rejection stands for this release, and more approvals do not clear it. Cut a new release with the change it asks for, and promote that one.",
        lines: [...lines],
      };
    }
    return undefined;
  };
}

/**
 * The rejections a promote reads before the soak (#5326, #5354): those at
 * each skipped stage's gate and skip gate, then at the target stage's gate
 * (and its urgent gate under `--urgent`). A rejection stops the promote
 * with exit 8 before any soak is read or recorded, so a rejected release
 * never leaves a soak's pending fact. {@link pipelinePromoteGates} reads them
 * again, with the same answer, before its approvals.
 */
export async function pipelinePromoteRejected(input: {
  spec: PipelineSpec;
  to: string;
  skipped: readonly PipelineStage[];
  digest: string;
  releaseDigest?: string;
  port: GateLedgerPort;
  proof?: PipelineGateProof;
  urgent?: boolean;
}): Promise<({ passed: false } & PipelinePromoteStop) | undefined> {
  const rules: Record<string, GateApprovalRule | null> = {};
  const identityOf = async (gate: string): Promise<GateApprovalRule | null> => (gate in rules ? rules[gate]! : (rules[gate] = (await input.port.approvalRule?.(gate)) ?? null));
  const rejected = rejectionReader({ ...input, identityOf, lines: [] });
  for (const stage of input.skipped) {
    const stop = await rejected(stage, [stage.name, `${stage.name}-skip`]);
    if (stop) return stop;
  }
  const stage = input.spec.stages.find((s) => s.name === input.to);
  if (!stage) return undefined;
  return rejected(stage, input.urgent ? [stage.name, urgentGateName(stage.name)] : [stage.name]);
}

/**
 * The gates part, once the promote knows what it deploys: each skipped
 * stage's skip gate, then the target stage's gate. `digest` is the release's
 * digest, or {@link promotedDigest}. Records each skip it passes.
 */
export async function pipelinePromoteGates(input: {
  spec: PipelineSpec;
  to: string;
  skipped: readonly PipelineStage[];
  digest: string;
  releaseDigest?: string;
  port: GateLedgerPort;
  actor?: string;
  gitSha?: string;
  now: Date;
  /** What proves an approver or a rejecter (#5354). */
  proof?: PipelineGateProof;
  /**
   * `--urgent` (#5355): after the stage's rejections, its urgent rule
   * ({@link pipelineUrgentGate}) stands in for its gate. A rejection at
   * `<stage>` or at `<stage>-urgent` stops it, and nothing is skipped.
   */
  urgent?: boolean;
  /** The change risk the release's cut carries (#5387). Absent: the release carries none, and each gate is as it was. */
  risk?: ReleaseRisk;
}): Promise<PipelineGatesOutcome> {
  const { spec, port, digest } = input;
  const proof = input.proof ?? NO_PROOF;
  const now = input.now.toISOString();
  const lines: string[] = [];
  const rules: Record<string, GateApprovalRule | null> = {};
  // #3163: the workspace's identity.gates rule for a gate, read once.
  const identityOf = async (gate: string): Promise<GateApprovalRule | null> => (gate in rules ? rules[gate]! : (rules[gate] = (await port.approvalRule?.(gate)) ?? null));
  // #5354: under `sealed`, only an approval whose seal verifies at base counts, as a wave's sealed gate counts it.
  const ruleFor = async (stage: PipelineStage, gate: string): Promise<GateApprovalRule | null> => {
    const own = await identityOf(gate);
    if (stage.gate?.approval !== "sealed") return own;
    const sealed: GateApprovalRule = { requirement: { gate, class: null }, refuses: (a) => gateSealRefusal(proof.signers, a) };
    return own ? { requirement: own.requirement, refuses: (a) => own.refuses(a) ?? sealed.refuses(a) } : sealed;
  };
  // #5354: the rejections of the pipeline's gates, read once.
  const rejected = rejectionReader({ ...input, identityOf, lines });
  // #5387: each stage's reading of the release's risk, once, its line printed whatever the gate does.
  const reads = new Map<string, ReturnType<typeof stageRiskRead>>();
  const riskOf = (stage: PipelineStage) => {
    if (!reads.has(stage.name)) {
      const read = stageRiskRead(spec, stage.name, input.risk);
      reads.set(stage.name, read);
      if (read) lines.push(read.line);
    }
    return reads.get(stage.name);
  };
  const riskOver = (stage: PipelineStage): boolean => riskOf(stage)?.risk?.over === true;
  const check = async (stage: PipelineStage, gate: string) => {
    const read = riskOf(stage);
    const rule = await ruleFor(stage, gate);
    // #5387: an over risk adds its rules; a gate that read a record counts people only, and a permit that reads it only from a proven one.
    const rules = [...(stage.gate?.quorum ?? []), ...(read?.rules ?? [])];
    const context = read ? stageRiskContext(read) : undefined;
    const approval: ResolvedGateApproval | undefined = read?.risk
      ? { ...(rules.length > 0 ? { quorum: rules } : {}), mode: "enforce", risk: read.settings, ...(context ? { context } : {}) }
      : rules.length > 0
        ? { quorum: rules, mode: "enforce" }
        : undefined;
    return evaluateGate(port, {
      rule,
      op: spec.name,
      gate,
      planDigest: digest,
      environment: stage.name,
      now,
      description: gate.endsWith("-skip") ? `skip stage ${stage.name} of the pipeline ${spec.name}` : `promote into stage ${stage.name} of the pipeline ${spec.name}`,
      ...(input.gitSha ? { gitSha: input.gitSha } : {}),
      ...(approval ? { approval } : {}),
    });
  };
  const waiting = (gate: string, stage: PipelineStage): PipelineGatesOutcome => ({
    passed: false,
    lines: [...lines],
    exitCode: 3,
    code: "pipeline-gate-waiting",
    message: `${spec.name} ${gate} waits for an approval of ${digest}${reads.get(stage.name)?.risk?.over ? `; ${reads.get(stage.name)!.line}` : ""}`,
    hint: approveCommand(spec.name, gate, stage.name, digest, stage.gate?.approval === "sealed"),
  });

  if (input.urgent && input.skipped.length > 0) {
    return { passed: false, exitCode: 1, code: "pipeline-urgent-skips", message: `the urgent path skips no stage, and ${input.skipped.map((s) => s.name).join(", ")} would be skipped`, hint: `Promote the release to ${input.skipped[0]!.name} first.` };
  }
  for (const stage of input.skipped) {
    const gate = `${stage.name}-skip`;
    // #5354: a release rejected at a stage is not skipped past it either.
    const stop = await rejected(stage, [stage.name, gate]);
    if (stop) return stop;
    if (stage.gate?.policy === "never" && !riskOver(stage)) {
      await port.appendApplied?.({ version: 1, kind: "applied", op: spec.name, gate, planDigest: digest, approvedAt: now, approvedBy: "gate-policy-never", timestamp: now, ...(input.gitSha ? { commit: input.gitSha } : {}) });
      lines.push(`skipped ${stage.name}: its gate never waits`);
      continue;
    }
    const got = await check(stage, gate);
    if (!got.satisfied) return waiting(gate, stage);
    await port.appendApplied?.({ version: 1, kind: "applied", op: spec.name, gate, planDigest: digest, approvedAt: got.resolution.timestamp, approvedBy: got.resolution.resolvedBy, timestamp: now, ...(input.gitSha ? { commit: input.gitSha } : {}) });
    lines.push(`skipped ${stage.name} through ${spec.name} ${gate}, approved by ${got.resolution.resolvedBy}`);
  }

  const stage = spec.stages.find((s) => s.name === input.to)!;
  // #5354: a rejection stops the stage whatever its policy, before any approval is read.
  // #5355: on the urgent path too, at the stage's gate or its urgent gate.
  const stop = await rejected(stage, input.urgent ? [stage.name, urgentGateName(stage.name)] : [stage.name]);
  if (stop) return stop;
  if (input.urgent) {
    const got = await pipelineUrgentGate({ spec, to: stage.name, digest, port, ...(input.releaseDigest !== undefined ? { releaseDigest: input.releaseDigest } : {}), ...(input.gitSha ? { gitSha: input.gitSha } : {}), now: input.now });
    if (!got.passed) return { ...got, lines: [...lines, ...(got.lines ?? [])] };
    return { passed: true, lines: [...lines, ...got.lines], urgent: { approval: got.approval, role: got.role } };
  }
  if (stage.gate?.policy === "never" && !riskOver(stage)) {
    lines.push(`stage ${stage.name}: its gate never waits`);
    return { passed: true, lines };
  }
  const got = await check(stage, stage.name);
  if (!got.satisfied) return waiting(stage.name, stage);
  lines.push(`stage ${stage.name}: ${spec.name} ${stage.name} approved by ${got.resolution.resolvedBy}`);
  return { passed: true, lines };
}

/** How {@link pipelineStageEntry} ended: the stage's gate passed and the release entered, or the stop. */
export type PipelineEntryOutcome =
  | { passed: true; lines: string[]; entered?: StageLine; urgent?: { approval: GateResolutionRecord; role: string } }
  | ({ passed: false } & PipelinePromoteStop);

/** The release a promote deploys, as the stage log names it. */
export interface PipelineEntryRelease {
  releaseDigest: string;
  label?: string;
  /** The commit it was cut from: the first stage counts as applied when its ledger holds a deploy of it. */
  commit: string;
  /** When it was cut, which orders it against another release waiting. */
  cutAt?: string;
  /** The change risk its cut carries (#5387), which each stage gate with `holds.risk` reads. */
  risk?: ReleaseRisk;
}

const releaseName = (digest: string, label?: string): string => (label ? `${label} (${digest})` : digest);

/**
 * Take a release into stage `to` (#5353): the upstream stages a stage with
 * `after` waits on, its queue, and then {@link pipelinePromoteGates}. With
 * a pipeline that declares neither `after` nor `queue`, this is
 * {@link pipelinePromoteGates} and writes no stage line.
 *
 * - Each upstream the release has not applied in stops the promote with
 *   exit 3, or with `allowSkip` goes through that stage's skip gate.
 * - Under `queue: "replace"`, a release replaced at the stage is refused
 *   (exit 1). A newer release replaces each older one waiting; one older
 *   than a release waiting is replaced itself and refused. The release
 *   then waits, its gate is read, and while another release is in the
 *   stage it exits 3. A release already in the stage carries on without
 *   its gate read again.
 * - Once the gate passes, the release's `entered` line is written; the
 *   caller writes its `finished` line with {@link pipelineStageFinished}.
 */
export async function pipelineStageEntry(input: {
  spec: PipelineSpec;
  to: string;
  skipped: readonly PipelineStage[];
  /** The stages `to` follows, from {@link pipelinePromoteSource}, when it names `after`. */
  upstreams?: readonly string[];
  allowSkip?: boolean;
  digest: string;
  release?: PipelineEntryRelease;
  /** The commits the first stage's ledger records deploys of. */
  firstStageCommits?: ReadonlySet<string>;
  port: GateLedgerPort;
  log: StageLogPort;
  /** `--urgent` (#5355): the stage's urgent rule ({@link pipelineUrgentGate}) in place of its gate. */
  urgent?: boolean;
  actor?: string;
  gitSha?: string;
  runId?: string;
  now: Date;
  /** What proves an approver or a rejecter (#5354), handed to {@link pipelinePromoteGates}. */
  proof?: PipelineGateProof;
}): Promise<PipelineEntryOutcome> {
  const { spec, to, digest, log } = input;
  // #5355: under --urgent the stage's urgent rule stands in for its gate, after its rejections, and nothing is skipped.
  let urgent: { approval: GateResolutionRecord; role: string } | undefined;
  const gates = async (skipped: readonly PipelineStage[]): Promise<PipelineGatesOutcome> => {
    const got = await pipelinePromoteGates({ spec, to, skipped, digest, port: input.port, ...(input.release ? { releaseDigest: input.release.releaseDigest } : {}), ...(input.release?.risk ? { risk: input.release.risk } : {}), ...(input.actor ? { actor: input.actor } : {}), ...(input.gitSha ? { gitSha: input.gitSha } : {}), ...(input.proof ? { proof: input.proof } : {}), ...(input.urgent ? { urgent: true } : {}), now: input.now });
    if (got.passed && got.urgent) urgent = got.urgent;
    return got;
  };
  const withUrgent = (out: PipelineEntryOutcome): PipelineEntryOutcome => (out.passed && urgent ? { ...out, urgent } : out);
  if (!pipelineTracksStages(spec)) return withUrgent(await gates(input.skipped));

  const timestamp = input.now.toISOString();
  const stage = spec.stages.find((s) => s.name === to)!;
  const base = {
    version: 1 as const,
    op: spec.name,
    stage: to,
    digest,
    timestamp,
    ...(input.release?.label ? { label: input.release.label } : {}),
    ...(input.release?.cutAt ? { cutAt: input.release.cutAt } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  };
  const lines = await log.read(spec.name);
  const name = releaseName(digest, input.release?.label);

  const skipped = [...input.skipped];
  if (input.upstreams) {
    if (!input.release) {
      return {
        passed: false,
        exitCode: 1,
        code: "pipeline-join-needs-release",
        message: `stage "${to}" follows ${input.upstreams.join(", ")}, and opens only for a release that applied in each, so the promote names one`,
        hint: `Promote with --release <label|digest>; \`chant release list\` lists them.`,
      };
    }
    const first = spec.stages[0]!.name;
    const applied = (up: string) => (up === first ? input.firstStageCommits?.has(input.release!.commit) === true : succeededIn(lines, up, digest));
    const missing = input.upstreams.filter((up) => !applied(up));
    if (missing.length > 0 && !input.allowSkip) {
      return {
        passed: false,
        exitCode: 3,
        code: "pipeline-upstream-waiting",
        message: `stage "${to}" opens once release ${name} applied in ${input.upstreams.join(", ")}; it has not applied in ${missing.join(", ")} yet`,
        hint: `Promote it to ${missing.join(" and ")} first, or pass --allow-skip to go through the gate of each stage missing.`,
      };
    }
    for (const up of missing) {
      const s = spec.stages.find((x) => x.name === up)!;
      const h = stageHeldAt(s, input.now);
      if (h) return { passed: false, exitCode: 3, code: "pipeline-stage-held", message: `${stageHeldLine(h)}; a skip goes through it, so nothing is promoted past it either` };
      skipped.push(s);
    }
  }

  if (stage.queue === "replace") {
    const replaced = replacedIn(lines, to, digest);
    if (replaced) {
      return {
        passed: false,
        exitCode: 1,
        code: "pipeline-release-replaced",
        message: `release ${name} was replaced at stage "${to}" by ${releaseName(replaced.by!, replaced.byLabel)} at ${replaced.timestamp}, so it does not enter that stage`,
        hint: `Promote ${replaced.byLabel ?? replaced.by} or a newer release into ${to}.`,
      };
    }
    const queue = stageQueueOf(lines, to);
    if (queue.inStage?.digest === digest) {
      // The release in the stage: its gate passed when it entered, and its deploy carries on.
      return { passed: true, lines: [`stage ${to}: release ${name} is in the stage; its deploy carries on`], entered: queue.inStage };
    }
    const newerThan = (other: StageLine): boolean => (input.release?.cutAt && other.cutAt ? Date.parse(input.release.cutAt) >= Date.parse(other.cutAt) : true);
    const others = queue.waiting.filter((w) => w.digest !== digest);
    const newer = others.find((w) => !newerThan(w));
    if (newer) {
      await log.append({ ...base, kind: "replaced", by: newer.digest, ...(newer.label ? { byLabel: newer.label } : {}) });
      return {
        passed: false,
        exitCode: 1,
        code: "pipeline-release-replaced",
        message: `release ${releaseName(newer.digest, newer.label)}, cut after ${name}, waits for stage "${to}", so ${name} is replaced and does not enter it`,
        hint: `Promote ${newer.label ?? newer.digest} into ${to}.`,
      };
    }
    const notes: string[] = [];
    for (const w of others) {
      await log.append({ ...w, kind: "replaced", timestamp, by: digest, ...(input.release?.label ? { byLabel: input.release.label } : {}) });
      notes.push(`stage ${to}: release ${releaseName(w.digest, w.label)}, which waited, is replaced by ${name}`);
    }
    if (!queue.waiting.some((w) => w.digest === digest)) await log.append({ ...base, kind: "waiting" });
    const got = await gates(skipped);
    if (!got.passed) return got;
    if (queue.inStage) {
      return {
        passed: false,
        exitCode: 3,
        code: "pipeline-stage-busy",
        message: `stage "${to}" takes one release at a time, and release ${releaseName(queue.inStage.digest, queue.inStage.label)} is in it since ${queue.inStage.timestamp}; ${name} waits for it to finish`,
        hint: "Run the same promote again once that release's deploy has finished.",
      };
    }
    const entered: StageLine = { ...base, kind: "entered" };
    await log.append(entered);
    return withUrgent({ passed: true, lines: [...notes, ...got.lines], entered });
  }

  const got = await gates(skipped);
  if (!got.passed) return got;
  const entered: StageLine = { ...base, kind: "entered" };
  await log.append(entered);
  return withUrgent({ passed: true, lines: got.lines, entered });
}

/** Write the `finished` line for a release that entered a stage (#5353): `applied` when its deploy did, else `failed`. */
export async function pipelineStageFinished(log: StageLogPort, entered: StageLine, result: "applied" | "failed", now: Date): Promise<void> {
  await log.append({ ...entered, kind: "finished", result, timestamp: now.toISOString() });
}

/** The gate an urgent promote into `stage` is approved at (#5355). */
export function urgentGateName(stage: string): string {
  return `${stage}-urgent`;
}

/**
 * The stages a release must have succeeded in before an urgent promote into
 * `to` (#5355), in the pipeline's order. A stage with `after` (#5353) takes
 * the stages it names and every stage those follow, by
 * {@link stageUpstreams}. A stage without `after` takes every stage before it.
 */
export function urgentUpstreamStages(spec: Pick<PipelineSpec, "stages">, to: string): string[] {
  const at = spec.stages.findIndex((s) => s.name === to);
  if (at < 0) return [];
  const stage = spec.stages[at]!;
  if (stage.after === undefined) return spec.stages.slice(0, at).map((s) => s.name);
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const up of stageUpstreams(spec, name)) visit(up);
  };
  for (const up of stage.after) visit(up);
  return spec.stages.map((s) => s.name).filter((n) => seen.has(n));
}

/**
 * The stages upstream of `to` ({@link urgentUpstreamStages}) in which the
 * release has not succeeded, each with the components it lacks there
 * (#5355). `missingIn` answers for one stage. Empty when it succeeded in
 * every one.
 */
export async function pipelineUrgentUpstream(input: {
  spec: PipelineSpec;
  to: string;
  missingIn: (stage: string) => Promise<string[]>;
}): Promise<{ stage: string; missing: string[] }[]> {
  const out: { stage: string; missing: string[] }[] = [];
  for (const stage of urgentUpstreamStages(input.spec, input.to).map((name) => ({ name }))) {
    const missing = await input.missingIn(stage.name);
    if (missing.length > 0) out.push({ stage: stage.name, missing });
  }
  return out;
}

/** The refusal for a release that has not succeeded in every stage before the one an urgent promote goes to. */
export function urgentUpstreamStop(release: string, missing: readonly { stage: string; missing: string[] }[]): PipelinePromoteStop {
  return {
    exitCode: 1,
    code: "pipeline-urgent-upstream",
    message: `release ${release} has not succeeded in ${missing.map((m) => `${m.stage} (${m.missing.join(", ")})`).join("; ")}, and the urgent path takes only a release every upstream stage ran`,
    hint: "Promote the release through each earlier stage first.",
  };
}

/** What {@link pipelineUrgentGate} decided: passed on an approval, or the stop. */
export type PipelineUrgentOutcome = { passed: true; lines: string[]; approval: GateResolutionRecord; role: string } | ({ passed: false } & PipelinePromoteStop);

/**
 * The urgent rule of stage `to` (#5355), in place of its gate: one approval
 * of `<stage>-urgent` bound to the release's digest, from an approver the
 * port's judge proves and gives the rule's role. The quorum rule is
 * `{ count: 1, roles: [role], proven: true }`, so an unproven line never
 * counts. The approval is spent on `_gates/<pipeline>/applied.jsonl`.
 */
export async function pipelineUrgentGate(input: {
  spec: PipelineSpec;
  to: string;
  digest: string;
  releaseDigest?: string;
  port: GateLedgerPort;
  gitSha?: string;
  now: Date;
}): Promise<PipelineUrgentOutcome> {
  const { spec, port, digest } = input;
  const stage = spec.stages.find((s) => s.name === input.to);
  const rule = stage?.gate?.urgent;
  if (!stage || !rule) return { passed: false, exitCode: 1, code: "pipeline-no-urgent-rule", message: `stage "${input.to}" of the pipeline "${spec.name}" declares no urgent rule` };
  const gate = urgentGateName(stage.name);
  const now = input.now.toISOString();
  const got = await evaluateGate(port, {
    op: spec.name,
    gate,
    planDigest: digest,
    environment: stage.name,
    ...(input.releaseDigest !== undefined ? { releaseDigest: input.releaseDigest } : {}),
    now,
    description: `urgent promote into stage ${stage.name} of the pipeline ${spec.name}: one proven approval from ${rule.role}`,
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    approval: { quorum: [{ count: 1, roles: [rule.role], proven: true }], mode: "enforce" },
  });
  if (!got.satisfied) {
    return {
      passed: false,
      exitCode: 3,
      code: "pipeline-gate-waiting",
      message: `${spec.name} ${gate} waits for one proven approval from ${rule.role} of ${digest}`,
      hint: approveCommand(spec.name, gate, stage.name, digest, true),
    };
  }
  const approval = got.resolution;
  await port.appendApplied?.({ version: 1, kind: "applied", op: spec.name, gate, planDigest: digest, approvedAt: approval.timestamp, approvedBy: approval.resolvedBy, timestamp: now, ...(input.gitSha ? { commit: input.gitSha } : {}) });
  return { passed: true, approval, role: rule.role, lines: [`stage ${stage.name}: urgent, ${spec.name} ${gate} approved by ${approval.resolvedBy} (${rule.role})`] };
}

/**
 * Every soak in front of a promotion into `to`, in order (#5326, #5327):
 * the soak of each stage promoted from (`upstreams` on a join, else
 * `from`), then the soak of each canary stage `to` follows and is not one
 * of those ({@link canaryStagesBefore}). Each is read through its own gate
 * by {@link pipelinePromoteSoak}; the first that holds stops the promote.
 * `items` gives what a stage applied of what is promoted, and `read` its
 * check reader. A canary with nothing applied says so in `notes` and
 * holds, since its clock cannot start. `lines` are the passed soaks' lines.
 */
export async function pipelinePromoteSoaks(input: {
  spec: PipelineSpec;
  from: string;
  to: string;
  upstreams?: readonly string[];
  items: (stage: string) => Promise<readonly { component: string; source: { timestamp: string } }[]>;
  digest: string;
  releaseDigest?: string;
  port: GateLedgerPort;
  read: (stage: string) => SoakCheckReader;
  now: Date;
  gitSha?: string;
  notify?: SoakGateInput["notify"];
}): Promise<SoakGateOutcome & { notes: string[] }> {
  const sources = input.upstreams ? [...input.upstreams] : [input.from];
  const canaries = canaryStagesBefore(input.spec, input.to).map((s) => s.name).filter((name) => !sources.includes(name));
  const notes: string[] = [];
  const lines: string[] = [];
  let last: SoakGateOutcome | undefined;
  for (const source of [...sources, ...canaries]) {
    const items = await input.items(source);
    if (canaries.includes(source) && items.length === 0) {
      notes.push(`the canary stage ${source} has no apply of what this promote deploys, so its soak cannot start; promote through ${source} first, or end its soak early through its gate`);
    }
    const soak = await pipelinePromoteSoak({
      spec: input.spec,
      from: source,
      to: input.to,
      items,
      digest: input.digest,
      ...(input.releaseDigest !== undefined ? { releaseDigest: input.releaseDigest } : {}),
      port: input.port,
      read: input.read(source),
      now: input.now,
      ...(input.gitSha ? { gitSha: input.gitSha } : {}),
      ...(input.notify ? { notify: input.notify } : {}),
    });
    if (!soak.passed) return { ...soak, notes };
    lines.push(...soak.lines);
    last = soak;
  }
  return { passed: true, lines, decision: last!.decision, notes };
}

/**
 * The soak of stage `from` in front of a promotion into `to` (#5326): each
 * promoted component is a member that applied in `from` at its source
 * record's time. Passed when `from` declares no soak or is no stage of the
 * pipeline.
 */
export async function pipelinePromoteSoak(input: {
  spec: PipelineSpec;
  from: string;
  to: string;
  items: readonly { component: string; source: { timestamp: string } }[];
  digest: string;
  releaseDigest?: string;
  port: GateLedgerPort;
  read: SoakCheckReader;
  now: Date;
  gitSha?: string;
  notify?: SoakGateInput["notify"];
}): Promise<SoakGateOutcome> {
  const stage = input.spec.stages.find((s) => s.name === input.from);
  return soakAtGate({
    op: input.spec.name,
    gate: stageSoakGate(input.from),
    soak: stage?.soak,
    stage: input.from,
    holds: `stage ${input.to}`,
    to: input.to,
    digest: input.digest,
    ...(input.releaseDigest ? { releaseDigest: input.releaseDigest } : {}),
    subjects: input.items.map((i) => ({ member: i.component, targets: [i.component], appliedAt: i.source.timestamp })),
    ...(stage?.gate?.quorum ? { quorum: stage.gate.quorum } : {}),
    port: input.port,
    read: input.read,
    now: input.now,
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    ...(input.notify ? { notify: input.notify } : {}),
  });
}
