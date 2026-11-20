/**
 * The change risk a release carries (#5387), and how a later stage's gate
 * reads it.
 *
 * #5325 scores a change set where a wave plans it. A promote into a later
 * stage plans nothing, so the score travels with the release:
 *
 * 1. A wave of the first stage that scores its change set under `holds.risk`
 *    writes its record beside its release records once it applied, one line
 *    per wave in `_releases/risk/<commit>.jsonl` on `chant/lifecycle`.
 * 2. `chant release cut` reads the lines of the commit it cuts, keeps the
 *    newest per wave, and writes them on the cut line as the release's
 *    `risk`, so the record is bound to the release digest. The release's
 *    score is the chance that at least one wave's score bites:
 *    `1 - (1 - s1) * (1 - s2) * ...`, so a wave only ever raises it.
 * 3. `chant components promote --release` reads the cut's record, and each
 *    stage gate it passes reads it under that stage's `holds.risk`
 *    ({@link stageRiskRead}). Over `approveAbove`, or with a question
 *    answered above its own threshold, the gate takes the risk's `quorum`
 *    rules on top of its own, and a gate whose policy is `never` waits for an
 *    approval of its own.
 *
 * A release with no record reads as no score: the stage's gate is what it
 * was before, so a release cut before this, or a pipeline whose first stage
 * scores nothing, promotes as it did. The record only ever adds approvals:
 * a score within the threshold asks for nothing more and passes no gate, and
 * nothing reads the score as leave to apply unattended.
 */

import { CHANGE_RISK_CONTEXT_KEY, changeRiskContext, changeRiskLevel, changeRiskQuorum, type ChangeRisk, type ChangeRiskLevel, type ChangeRiskReason, type ChangeRiskSettings } from "../change-risk";
import type { GateQuorumRule } from "../op/gate-quorum";
import type { PipelineSpec } from "../pipeline/spec";
import { sortedJsonReplacer } from "../utils";
import { ledgerDir, readBlobBySha, readBlobFromPath, readPathSha, RefCASConflictError, writeLedgerFiles, type LedgerLocation } from "./git";

/** The directory on `chant/lifecycle` that holds each commit's wave scores. */
export const RELEASE_RISK_DIR = "_releases/risk";

/** The settings a stage gate reads the record under: its `holds.risk`. */
export type StageRiskSettings = Omit<ChangeRiskSettings, "questions">;

/** One wave's score, as its release records carry it. */
export interface WaveRisk {
  /** The op-waves spec that scored it, such as `shop-dev`. */
  op: string;
  /** The wave's number, from 1. */
  wave: number;
  /** The wave's name. */
  name: string;
  /** The digest the wave's gate decided. */
  digest: string;
  /** The wave's record, as `scoreChangeRisk` gave it. */
  risk: ChangeRisk;
}

/** One line of `_releases/risk/<commit>.jsonl`. */
export interface WaveRiskLine extends WaveRisk {
  version: 1;
  /** The commit the wave applied. */
  commit: string;
  timestamp: string;
}

/** The change risk a release carries (#5387), on its cut line. */
export interface ReleaseRisk {
  version: 1;
  /** The commit the release was cut from, which the waves scored. */
  commit: string;
  /** From 0 to 1, to four places: `1 - (1 - s1) * (1 - s2) * ...` over the waves' scores. */
  score: number;
  level: ChangeRiskLevel;
  /** Each wave's record, the newest per wave, by spec then wave. */
  waves: WaveRisk[];
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;
const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const LEVELS = new Set(["low", "medium", "high"]);

function isChangeRisk(v: unknown): v is ChangeRisk {
  return isMap(v) && unit(v.score) && LEVELS.has(v.level as string) && Array.isArray(v.reasons) && v.reasons.every((r) => isMap(r) && typeof r.id === "string" && typeof r.contribution === "number");
}

function isWaveRisk(v: unknown): v is WaveRisk {
  return isMap(v) && typeof v.op === "string" && Number.isInteger(v.wave) && typeof v.name === "string" && typeof v.digest === "string" && isChangeRisk(v.risk);
}

/** Whether `v` reads as a {@link ReleaseRisk}. */
export function isReleaseRisk(v: unknown): v is ReleaseRisk {
  return isMap(v) && v.version === 1 && typeof v.commit === "string" && unit(v.score) && LEVELS.has(v.level as string) && Array.isArray(v.waves) && v.waves.length > 0 && v.waves.every(isWaveRisk);
}

/** Parse the lines of a commit's risk file. A line that is not a wave's score is skipped. */
export function parseWaveRiskLines(text: string | null): WaveRiskLine[] {
  const out: WaveRiskLine[] = [];
  for (const line of (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const v = JSON.parse(line) as unknown;
      if (isMap(v) && v.version === 1 && typeof v.commit === "string" && typeof v.timestamp === "string" && isWaveRisk(v)) out.push(v as unknown as WaveRiskLine);
    } catch {
      // Not a line of this file.
    }
  }
  return out;
}

/**
 * The record a release cut from `commit` carries: the newest line per wave,
 * by spec then wave, and their scores combined. Undefined when no wave of
 * the commit was scored.
 */
export function releaseRiskOf(commit: string, lines: readonly WaveRiskLine[]): ReleaseRisk | undefined {
  const newest = new Map<string, WaveRiskLine>();
  for (const l of lines) {
    if (l.commit !== commit) continue;
    const key = JSON.stringify([l.op, l.wave]);
    const prior = newest.get(key);
    if (!prior || l.timestamp >= prior.timestamp) newest.set(key, l);
  }
  if (newest.size === 0) return undefined;
  const waves = [...newest.values()]
    .sort((a, b) => (a.op === b.op ? a.wave - b.wave : a.op < b.op ? -1 : 1))
    .map(({ op, wave, name, digest, risk }) => ({ op, wave, name, digest, risk }));
  const score = round(1 - waves.reduce((p, w) => p * (1 - Math.min(1, Math.max(0, w.risk.score))), 1));
  return { version: 1, commit, score, level: changeRiskLevel(score), waves };
}

function fileOf(commit: string): string {
  return `${commit}.jsonl`;
}

/** The wave scores recorded for `commit`, oldest first. Empty when none is. */
export async function readWaveRisk(commit: string, opts?: LedgerLocation): Promise<WaveRiskLine[]> {
  return parseWaveRiskLines(await readBlobFromPath(RELEASE_RISK_DIR, fileOf(commit), opts));
}

/** The record a release cut from `commit` binds, read from the ledger. Undefined when no wave of the commit was scored. */
export async function readReleaseRisk(commit: string, opts?: LedgerLocation): Promise<ReleaseRisk | undefined> {
  return releaseRiskOf(commit, await readWaveRisk(commit, opts));
}

const APPEND_ATTEMPTS = 5;

/** Append wave scores to their commits' files on the local `chant/lifecycle`. Does not push; the release records written after them do. */
export async function appendWaveRisk(lines: readonly WaveRiskLine[], opts?: { cwd?: string }): Promise<void> {
  const byCommit = new Map<string, WaveRiskLine[]>();
  for (const l of lines) byCommit.set(l.commit, [...(byCommit.get(l.commit) ?? []), l]);
  for (const [commit, own] of byCommit) {
    let lastErr: unknown;
    let written = false;
    for (let attempt = 1; attempt <= APPEND_ATTEMPTS && !written; attempt++) {
      const priorSha = await readPathSha(RELEASE_RISK_DIR, fileOf(commit), opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const added = own.map((l) => JSON.stringify(l, sortedJsonReplacer)).join("\n");
      const content = `${existing ? `${existing.replace(/\n$/, "")}\n` : ""}${added}\n`;
      try {
        const dir = await ledgerDir(RELEASE_RISK_DIR, opts);
        await writeLedgerFiles([{ path: `${dir}/${fileOf(commit)}`, content, expectPriorSha: priorSha }], `Change risk of ${commit.slice(0, 12)}`, opts);
        written = true;
      } catch (err) {
        if (!(err instanceof RefCASConflictError)) throw err;
        lastErr = err;
      }
    }
    if (!written) throw lastErr;
  }
}

/** A stage's `holds.risk`: its gate's `holds`, else the pipeline defaults', as the stage's op-waves spec takes them. */
export function stageRiskSettings(spec: Pick<PipelineSpec, "stages" | "defaults">, stage: string): StageRiskSettings | undefined {
  const s = spec.stages.find((x) => x.name === stage);
  if (!s) return undefined;
  return (s.gate?.holds ?? spec.defaults?.holds)?.risk;
}

/**
 * A score and its reasons read under a stage's settings: over when the score
 * is above `approveAbove`, or a question's answer is above its own threshold
 * (an `unknown` answer is above every one), as `scoreChangeRisk` decides it.
 */
export function riskAtThreshold(at: { score: number; reasons: readonly ChangeRiskReason[] }, settings: StageRiskSettings): ChangeRisk {
  const overBy: string[] = [];
  const approveAbove = settings.approveAbove ?? null;
  if (approveAbove !== null && at.score > approveAbove) overBy.push(`the score ${at.score} is above ${approveAbove}`);
  for (const r of at.reasons) {
    if (r.approveAbove === undefined) continue;
    if (r.answer === "unknown") overBy.push(`${r.id} has no answer, which counts above its threshold of ${r.approveAbove}`);
    else if (typeof r.answer === "number" && r.answer > r.approveAbove) overBy.push(`${r.id} was answered ${r.answer}, above its threshold of ${r.approveAbove}`);
  }
  return { version: 1, score: at.score, level: changeRiskLevel(at.score), reasons: [...at.reasons], approveAbove, over: overBy.length > 0, overBy };
}

/** A release's record as one stage's gate reads it. */
export function releaseRiskAt(record: ReleaseRisk, settings: StageRiskSettings): ChangeRisk {
  return riskAtThreshold({ score: record.score, reasons: record.waves.flatMap((w) => w.risk.reasons ?? []) }, settings);
}

/** How a stage gate read the release's risk (#5387). */
export interface StageRiskRead {
  stage: string;
  settings: StageRiskSettings;
  /** The record read under the stage's settings. Absent when the release carries none: the gate is then as it was. */
  risk?: ChangeRisk;
  /** The rules an over record adds to the gate's own. Empty when it is not over or names none. */
  rules: GateQuorumRule[];
  /** The line the promote prints. */
  line: string;
}

const rulesLine = (rules: readonly GateQuorumRule[]): string =>
  rules
    .map((r) => `${r.count} approval${r.count === 1 ? "" : "s"}${r.roles?.length ? ` with the role ${r.roles.join(" or ")}` : ""}${r.proven ? ", proven" : ""}${r.notAuthor ? ", not the author" : ""}`)
    .join(" and ");

/**
 * How stage `stage` reads `record` (#5387). Undefined when the stage sets no
 * `holds.risk`, so the record is not read at all.
 *
 * `extra` are reasons the stage adds at its own gate (#5358): its agent
 * steps' levels (`agentStepRiskReasons`). Each raises the score as a reason
 * of the record would, `1 - (1 - score) * (1 - contribution)`, and never
 * lowers it.
 */
export function stageRiskRead(spec: Pick<PipelineSpec, "stages" | "defaults">, stage: string, record: ReleaseRisk | undefined, extra: readonly ChangeRiskReason[] = []): StageRiskRead | undefined {
  const settings = stageRiskSettings(spec, stage);
  if (!settings) return undefined;
  if (!record && extra.length === 0) {
    return { stage, settings, rules: [], line: `stage ${stage}: the release carries no change risk, so holds.risk reads no score and the gate is as it would be without it` };
  }
  const base = record ? { score: record.score, reasons: record.waves.flatMap((w) => w.risk.reasons ?? []) } : { score: 0, reasons: [] as ChangeRiskReason[] };
  const score = round(1 - extra.reduce((p, r) => p * (1 - Math.min(1, Math.max(0, r.contribution))), 1 - base.score));
  const risk = riskAtThreshold({ score, reasons: [...base.reasons, ...extra] }, settings);
  const rules = changeRiskQuorum(risk, settings);
  const head = `stage ${stage}: the release's change risk is ${risk.score.toFixed(2)} (${risk.level})`;
  const line = risk.over
    ? `${head}: ${risk.overBy.join("; ")}, so the gate waits for ${rules.length > 0 ? `${rulesLine(rules)} on top of its own rules` : "an approval of its own"}`
    : risk.approveAbove !== null
      ? `${head}, within ${risk.approveAbove}: it asks for nothing more, and approves nothing`
      : `${head}; holds.risk sets no approveAbove, so the score asks for nothing more, and approves nothing`;
  return { stage, settings, risk, rules, line };
}

/** The Cedar context a stage gate that read a record carries, `context.changeRisk`. */
export function stageRiskContext(read: StageRiskRead): Record<string, unknown> | undefined {
  return read.risk ? { [CHANGE_RISK_CONTEXT_KEY]: changeRiskContext(read.risk) } : undefined;
}

/** One later stage's reading of a score, for the plan note and `workspace status`. */
export interface StageRiskView {
  stage: string;
  /** The stage's threshold, or null when its `holds.risk` sets none. */
  approveAbove: number | null;
  over: boolean;
  /** The rules an over score adds to the stage's gate. */
  quorum: GateQuorumRule[];
}

/** How each stage after the first that sets `holds.risk` reads a score and its reasons. Empty when none sets it. */
export function laterStageRisk(spec: Pick<PipelineSpec, "stages" | "defaults">, at: { score: number; reasons: readonly ChangeRiskReason[] }): StageRiskView[] {
  const out: StageRiskView[] = [];
  for (const s of spec.stages.slice(1)) {
    const settings = stageRiskSettings(spec, s.name);
    if (!settings) continue;
    const risk = riskAtThreshold(at, settings);
    out.push({ stage: s.name, approveAbove: risk.approveAbove, over: risk.over, quorum: changeRiskQuorum(risk, settings) });
  }
  return out;
}

/** The plan note's lines for {@link laterStageRisk}: a table of each later stage and what the score asks for there. Empty when no later stage reads it. */
export function laterStageRiskLines(views: readonly StageRiskView[], score: number): string[] {
  if (views.length === 0) return [];
  const out = ["", `**Risk at each later stage:** ${score.toFixed(2)}, as the release carries it into each stage's gate.`, "", "| Stage | approveAbove | Asks for |", "|---|---:|---|"];
  for (const v of views) {
    const asks = !v.over ? "nothing more" : v.quorum.length > 0 ? `${rulesLine(v.quorum)} on top of the gate's own` : "an approval of its own";
    out.push(`| ${v.stage} | ${v.approveAbove ?? "-"} | ${asks} |`);
  }
  return out;
}
