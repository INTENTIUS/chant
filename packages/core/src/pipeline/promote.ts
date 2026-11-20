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
 */

import { createHash } from "node:crypto";
import { approveCommand, evaluateGate, type GateLedgerPort } from "../op/gate";
import { pipelineTracksStages, stageUpstreams, type PipelineSpec, type PipelineStage } from "./spec";
import { replacedIn, stageQueueOf, succeededIn, type StageLine, type StageLogPort } from "../lifecycle/stage-log";
import { stageHeldAt, stageHeldLine } from "./stages";

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
    | "pipeline-stage-busy";
}

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
  now: Date;
}): { from: string; skipped: PipelineStage[]; upstreams?: string[] } | PipelinePromoteStop | undefined {
  const { spec, to, now } = input;
  const names = spec.stages.map((s) => s.name);
  const toAt = names.indexOf(to);
  if (toAt < 0) return undefined;
  const held = stageHeldAt(spec.stages[toAt]!, now);
  if (held) return { exitCode: 3, code: "pipeline-stage-held", message: stageHeldLine(held), hint: held.until ? `Promote again after ${held.until}.` : "Lift the hold in the pipeline's config and merge the change." };
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
export type PipelineGatesOutcome = { passed: true; lines: string[] } | ({ passed: false } & PipelinePromoteStop);

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
}): Promise<PipelineGatesOutcome> {
  const { spec, port, digest } = input;
  const now = input.now.toISOString();
  const lines: string[] = [];
  const check = async (stage: PipelineStage, gate: string) => {
    const rules = stage.gate?.quorum;
    return evaluateGate(port, {
      op: spec.name,
      gate,
      planDigest: digest,
      environment: stage.name,
      now,
      description: gate.endsWith("-skip") ? `skip stage ${stage.name} of the pipeline ${spec.name}` : `promote into stage ${stage.name} of the pipeline ${spec.name}`,
      ...(input.gitSha ? { gitSha: input.gitSha } : {}),
      ...(rules && rules.length > 0 ? { approval: { quorum: rules, mode: "enforce" as const } } : {}),
    });
  };
  const waiting = (gate: string, stage: string): PipelineGatesOutcome => ({
    passed: false,
    exitCode: 3,
    code: "pipeline-gate-waiting",
    message: `${spec.name} ${gate} waits for an approval of ${digest}`,
    hint: approveCommand(spec.name, gate, stage, digest),
  });

  for (const stage of input.skipped) {
    const gate = `${stage.name}-skip`;
    if (stage.gate?.policy === "never") {
      await port.appendApplied?.({ version: 1, kind: "applied", op: spec.name, gate, planDigest: digest, approvedAt: now, approvedBy: "gate-policy-never", timestamp: now, ...(input.gitSha ? { commit: input.gitSha } : {}) });
      lines.push(`skipped ${stage.name}: its gate never waits`);
      continue;
    }
    const got = await check(stage, gate);
    if (!got.satisfied) return waiting(gate, stage.name);
    await port.appendApplied?.({ version: 1, kind: "applied", op: spec.name, gate, planDigest: digest, approvedAt: got.resolution.timestamp, approvedBy: got.resolution.resolvedBy, timestamp: now, ...(input.gitSha ? { commit: input.gitSha } : {}) });
    lines.push(`skipped ${stage.name} through ${spec.name} ${gate}, approved by ${got.resolution.resolvedBy}`);
  }

  const stage = spec.stages.find((s) => s.name === input.to)!;
  if (stage.gate?.policy === "never") {
    lines.push(`stage ${stage.name}: its gate never waits`);
    return { passed: true, lines };
  }
  const got = await check(stage, stage.name);
  if (!got.satisfied) return waiting(stage.name, stage.name);
  lines.push(`stage ${stage.name}: ${spec.name} ${stage.name} approved by ${got.resolution.resolvedBy}`);
  return { passed: true, lines };
}

/** How {@link pipelineStageEntry} ended: the stage's gate passed and the release entered, or the stop. */
export type PipelineEntryOutcome =
  | { passed: true; lines: string[]; entered?: StageLine }
  | ({ passed: false } & PipelinePromoteStop);

/** The release a promote deploys, as the stage log names it. */
export interface PipelineEntryRelease {
  releaseDigest: string;
  label?: string;
  /** The commit it was cut from: the first stage counts as applied when its ledger holds a deploy of it. */
  commit: string;
  /** When it was cut, which orders it against another release waiting. */
  cutAt?: string;
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
  actor?: string;
  gitSha?: string;
  runId?: string;
  now: Date;
}): Promise<PipelineEntryOutcome> {
  const { spec, to, digest, log } = input;
  const gates = (skipped: readonly PipelineStage[]) =>
    pipelinePromoteGates({ spec, to, skipped, digest, port: input.port, ...(input.release ? { releaseDigest: input.release.releaseDigest } : {}), ...(input.actor ? { actor: input.actor } : {}), ...(input.gitSha ? { gitSha: input.gitSha } : {}), now: input.now });
  if (!pipelineTracksStages(spec)) return gates(input.skipped);

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
    return { passed: true, lines: [...notes, ...got.lines], entered };
  }

  const got = await gates(skipped);
  if (!got.passed) return got;
  const entered: StageLine = { ...base, kind: "entered" };
  await log.append(entered);
  return { passed: true, lines: got.lines, entered };
}

/** Write the `finished` line for a release that entered a stage (#5353): `applied` when its deploy did, else `failed`. */
export async function pipelineStageFinished(log: StageLogPort, entered: StageLine, result: "applied" | "failed", now: Date): Promise<void> {
  await log.append({ ...entered, kind: "finished", result, timestamp: now.toISOString() });
}
