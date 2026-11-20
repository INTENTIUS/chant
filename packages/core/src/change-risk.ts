/**
 * A scored change risk (#5325): a number from 0 to 1, a level, and each
 * reason behind it with its weight, computed from facts chant already holds
 * about a change set.
 *
 * The facts are the change set's deletes and replacements, the disruption
 * class of each change (`./lifecycle/disruption.ts`, the terraform and
 * pulumi classifiers), the sql lexicon's destructive migration classes, how
 * many members and environments the change reaches, what depends on the
 * changed nodes in the graph, the review agent's level, the level each
 * agent step of a stage answers (#5358), and the review's answers to the
 * questions a team writes. Each reason gives a value from 0
 * to 1, and the score is the chance that at least one of them bites:
 *
 *   score = 1 - (1 - w1 * v1) * (1 - w2 * v2) * ...
 *
 * so a reason only ever raises the score, and the same facts always give the
 * same score. The weights are pinned in {@link CHANGE_RISK_WEIGHTS}, and a
 * unit test pins them.
 *
 * The record only adds approvals. With `approveAbove`, a score over it, or
 * an answer over its question's own threshold, makes the change `over`: the
 * pull request's plan then needs an approval of its own digest, a wave
 * waits whatever its gate says, and a stage gate takes the extra approval
 * rules its `quorum` names. A low score passes no gate and lets nothing apply
 * unapproved; there is no setting that does either.
 *
 * Imports types only, so the pull-request loop's bundle carries it.
 */

import type { ChangeSetDocument, ChangeSetEntry } from "./change-set";
import type { GateQuorumRule } from "./op/gate-quorum";
import type { PrMigrationFile } from "./pr-migrations";

/** The record's shape version. */
export const CHANGE_RISK_VERSION = 1;

/** The review agent's levels, and `unknown` when there is none. */
export type ChangeRiskReviewLevel = "low" | "medium" | "high" | "unknown";

/** A score's level. */
export type ChangeRiskLevel = "low" | "medium" | "high";

/** Where each level starts: `medium` at 0.3, `high` at 0.6. */
export const CHANGE_RISK_LEVEL_FROM: Readonly<Record<Exclude<ChangeRiskLevel, "low">, number>> = { medium: 0.3, high: 0.6 };

/**
 * The weight of each reason chant computes, from 0 to 1. A question's weight
 * is the one its config gives. Pinned: a change here changes every score,
 * and `change-risk.test.ts` fails until it is changed there too.
 */
export const CHANGE_RISK_WEIGHTS = {
  /** Resources the change set deletes. */
  destroys: 0.7,
  /** Resources it replaces. */
  replacements: 0.5,
  /** Replacements that remove the old resource first, so a window has nothing there. */
  "disruption.destroy": 0.6,
  /** Updates whose workload rolls. */
  "disruption.rolling": 0.2,
  /** Updates and replacements no lexicon could classify. */
  "disruption.unknown": 0.3,
  /** Destructive sql migration classes. */
  "sql.destructive": 0.7,
  /** Members changed beyond the first. */
  members: 0.2,
  /** Environments reached beyond the first. */
  environments: 0.3,
  /** Graph nodes that depend on a changed node and are not changed themselves. */
  dependents: 0.3,
  /** The review agent's level. */
  review: 0.5,
  /** An agent step's level (#5358): its answer's `risk`, one reason per step. */
  agent: 0.5,
} as const;

/** A reason chant computes. */
export type ChangeRiskFactReason = keyof typeof CHANGE_RISK_WEIGHTS;

/**
 * How a count becomes a value: `1 - 2^(-n / half)`, so `half` items give 0.5
 * and more approach 1. Members and environments count those beyond the first.
 */
export const CHANGE_RISK_HALF: Readonly<Record<Exclude<ChangeRiskFactReason, "review" | "agent">, number>> = {
  destroys: 1,
  replacements: 1,
  "disruption.destroy": 1,
  "disruption.rolling": 2,
  "disruption.unknown": 2,
  "sql.destructive": 1,
  members: 2,
  environments: 1,
  dependents: 4,
};

/** The review's level as a value. `unknown` counts as `medium`: no review is not a low one. */
export const CHANGE_RISK_REVIEW_VALUES: Readonly<Record<ChangeRiskReviewLevel, number>> = { low: 0, medium: 0.5, high: 1, unknown: 0.5 };

/** A question a team writes for the review agent, answered from 0 (no concern) to 1. */
export interface ChangeRiskQuestion {
  /** The answer's key: lowercase letters, digits, `-` and `_`. */
  id: string;
  /** The question the review agent answers. */
  text: string;
  /** Its weight in the score, from 0 to 1. */
  weight: number;
  /** An answer above this makes the change `over` whatever the score. An `unknown` answer is above every threshold. */
  approveAbove?: number;
}

/**
 * The risk settings: `ci.risk` in the workspace declaration (read at base),
 * a wave's or a stage gate's `holds.risk`, and an Op gate's `approval.risk`.
 * Every field is optional; with none set the record is computed and shown,
 * and asks for nothing.
 */
export interface ChangeRiskSettings {
  /** A score above this makes the change `over`, from 0 to 1. Absent: the score informs only. */
  approveAbove?: number;
  /**
   * Approval rules the gate takes on top of its own when the change is over:
   * `{ count: 2 }` raises the quorum, `{ count: 1, roles: ["sre"] }` requires
   * a role. Read by stage gates (a wave's `holds.risk`) and an Op gate's
   * `approval.risk`. Absent: an over change waits for one approval of its own.
   */
  quorum?: GateQuorumRule[];
  /** Questions the review agent answers on the pull request. Read from `ci.risk` only. */
  questions?: ChangeRiskQuestion[];
}

/** The facts a score is made from. Each is optional; a fact that is absent adds nothing. */
export interface ChangeRiskFacts {
  /** The change set the gate binds. */
  changeSet: Pick<ChangeSetDocument, "members" | "entries">;
  /** Destructive migration classes an engine named (`CapabilityPlan.destructive` of the sql lexicon). */
  destructive?: readonly string[];
  /** New migration files the pull request adds, as the plan note classifies them. Their destructive changes count by rule. */
  migrations?: readonly PrMigrationFile[];
  /** The environments the change reaches. */
  environments?: readonly string[];
  /** Graph nodes that depend on a changed node. */
  dependents?: readonly string[];
  /** The review agent's level and answers, when a review was looked for. */
  review?: { risk: ChangeRiskReviewLevel; answers?: Readonly<Record<string, number | "unknown">>; unknownBecause?: string };
  /**
   * Each agent step's level (#5358), by step name: the `risk` its answer
   * names (`../pipeline/agent-steps.ts`, `agentStepRiskLevels`). Each is one
   * reason `agent.<step>`, weighed as the review's level is. A step whose
   * answer names no level adds nothing.
   */
  agent?: Readonly<Record<string, ChangeRiskReviewLevel>>;
}

/** One reason, as the record keeps it. */
export interface ChangeRiskReason {
  /** A {@link ChangeRiskFactReason}, or `question.<id>`. */
  id: string;
  weight: number;
  /** How many things the reason counted. Absent on the review and on a question. */
  count?: number;
  /** The reason's value, from 0 to 1. */
  value: number;
  /** `weight * value`: how much it raises the score on its own. */
  contribution: number;
  /** What it counted, in a few words. */
  detail: string;
  /** On a question: the review's answer, or `unknown`. */
  answer?: number | "unknown";
  /** On a question: its own threshold. */
  approveAbove?: number;
}

/** The risk record (#5325): stored with the change set, shown in the plan note, read by Rego as `input.risk`. */
export interface ChangeRisk {
  version: typeof CHANGE_RISK_VERSION;
  /** From 0 to 1, to four places. */
  score: number;
  level: ChangeRiskLevel;
  /** Every reason chant computed, the ones that counted nothing included, in a fixed order, then the questions. */
  reasons: ChangeRiskReason[];
  /** The score threshold, or null when none is set. */
  approveAbove: number | null;
  /** The score is over `approveAbove`, or an answer is over its question's threshold. */
  over: boolean;
  /** Each threshold crossed, one line each. Empty when not over. */
  overBy: string[];
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;
const saturate = (n: number, half: number): number => (n <= 0 ? 0 : round(1 - Math.pow(2, -n / half)));

const CHANGES = new Set<ChangeSetEntry["action"]>(["create", "update", "replace", "delete"]);
const QUESTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** The level of a score. */
export function changeRiskLevel(score: number): ChangeRiskLevel {
  if (score >= CHANGE_RISK_LEVEL_FROM.high) return "high";
  if (score >= CHANGE_RISK_LEVEL_FROM.medium) return "medium";
  return "low";
}

/** The destructive classes a set of migration files names, by rule, sorted. */
export function destructiveMigrationClasses(migrations: readonly PrMigrationFile[] | undefined): string[] {
  const out = new Set<string>();
  for (const f of migrations ?? []) for (const s of f.statements ?? []) for (const c of s.changes ?? []) if (c.destructive) out.add(c.rule);
  return [...out].sort();
}

/** The nodes that depend on a changed node of `doc` through `edges` (`from` reads `to`), not changed themselves, sorted. */
export function graphDependents(doc: Pick<ChangeSetDocument, "entries">, edges: ReadonlyArray<{ from: string; to: string }>): string[] {
  const changed = new Set<string>();
  for (const e of doc.entries) {
    if (!CHANGES.has(e.action)) continue;
    if (typeof e.node === "string") changed.add(e.node);
    if (typeof e.instanceOf === "string") changed.add(e.instanceOf);
  }
  const out = new Set<string>();
  for (const edge of edges) if (changed.has(edge.to) && !changed.has(edge.from)) out.add(edge.from);
  return [...out].sort();
}

/**
 * The risk of a change set: each reason with its weight, the score and the
 * level, and whether a threshold in `settings` is crossed. Pure: the same
 * facts and settings give the same record.
 */
/**
 * The reasons agent steps' levels give (#5358), `agent.<step>` in step-name
 * order, each weighed as the review's level is. Empty when there are none.
 * A promote folds them into the release's score at a stage gate.
 */
export function agentStepRiskReasons(levels: ChangeRiskFacts["agent"]): ChangeRiskReason[] {
  const weight = CHANGE_RISK_WEIGHTS.agent;
  return Object.keys(levels ?? {})
    .sort()
    .map((step) => {
      const level = levels![step]!;
      const value = CHANGE_RISK_REVIEW_VALUES[level] ?? CHANGE_RISK_REVIEW_VALUES.unknown;
      return { id: `agent.${step}`, weight, value, contribution: round(weight * value), detail: `agent step ${step} answered ${level}` };
    });
}

export function scoreChangeRisk(facts: ChangeRiskFacts, settings: ChangeRiskSettings = {}): ChangeRisk {
  const entries = facts.changeSet.entries ?? [];
  const count = (pred: (e: ChangeSetEntry) => boolean): number => entries.filter(pred).length;
  const destroys = count((e) => e.action === "delete");
  const replacements = count((e) => e.action === "replace");
  const deleteFirst = count((e) => e.action === "replace" && e.disruption === "destroy");
  const rolling = count((e) => e.action === "update" && e.disruption === "rolling");
  const unclassified = count((e) => (e.action === "update" || e.action === "replace") && e.disruption === "unknown");
  const classes = new Set([...(facts.destructive ?? []), ...destructiveMigrationClasses(facts.migrations)]);
  const members = new Set(entries.filter((e) => CHANGES.has(e.action)).map((e) => e.member));
  for (const m of facts.changeSet.members ?? []) if ((m.outputs?.length ?? 0) > 0) members.add(m.member);
  const environments = new Set(facts.environments ?? []);
  const dependents = new Set(facts.dependents ?? []);

  const counted = (id: Exclude<ChangeRiskFactReason, "review" | "agent">, n: number, detail: string, over = n): ChangeRiskReason => {
    const weight = CHANGE_RISK_WEIGHTS[id];
    const value = saturate(over, CHANGE_RISK_HALF[id]);
    return { id, weight, count: n, value, contribution: round(weight * value), detail };
  };
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const reasons: ChangeRiskReason[] = [
    counted("destroys", destroys, `${plural(destroys, "delete")}`),
    counted("replacements", replacements, `${plural(replacements, "replacement")}`),
    counted("disruption.destroy", deleteFirst, `${plural(deleteFirst, "replacement")} that delete the old resource first`),
    counted("disruption.rolling", rolling, `${plural(rolling, "update")} that roll a workload`),
    counted("disruption.unknown", unclassified, `${plural(unclassified, "change")} no lexicon could classify`),
    counted("sql.destructive", classes.size, classes.size > 0 ? `destructive migration classes: ${[...classes].sort().join(", ")}` : "no destructive migration class"),
    counted("members", members.size, `${plural(members.size, "member")} changed`, Math.max(0, members.size - 1)),
    counted("environments", environments.size, `${plural(environments.size, "environment")} reached`, Math.max(0, environments.size - 1)),
    counted("dependents", dependents.size, `${plural(dependents.size, "graph node")} depending on a changed one`),
  ];
  if (facts.review) {
    const weight = CHANGE_RISK_WEIGHTS.review;
    const value = CHANGE_RISK_REVIEW_VALUES[facts.review.risk] ?? CHANGE_RISK_REVIEW_VALUES.unknown;
    reasons.push({ id: "review", weight, value, contribution: round(weight * value), detail: `the review's level is ${facts.review.risk}` });
  }
  reasons.push(...agentStepRiskReasons(facts.agent));

  const overBy: string[] = [];
  for (const q of settings.questions ?? []) {
    const given = facts.review?.answers?.[q.id];
    const answer: number | "unknown" = unit(given) ? given : "unknown";
    const value = answer === "unknown" ? 1 : answer;
    const why = answer === "unknown" ? (facts.review?.unknownBecause ? `, ${facts.review.unknownBecause}` : facts.review ? ", the review gave no answer" : ", no review was found") : "";
    reasons.push({
      id: `question.${q.id}`,
      weight: q.weight,
      value,
      contribution: round(q.weight * value),
      detail: `${q.text} (answer ${answer}${why})`,
      answer,
      ...(q.approveAbove !== undefined ? { approveAbove: q.approveAbove } : {}),
    });
    if (q.approveAbove !== undefined && (answer === "unknown" || answer > q.approveAbove)) {
      overBy.push(answer === "unknown" ? `question ${q.id} has no answer, which counts above its threshold of ${q.approveAbove}` : `question ${q.id} was answered ${answer}, above its threshold of ${q.approveAbove}`);
    }
  }

  const score = round(1 - reasons.reduce((p, r) => p * (1 - Math.min(1, Math.max(0, r.contribution))), 1));
  const approveAbove = settings.approveAbove ?? null;
  if (approveAbove !== null && score > approveAbove) overBy.unshift(`the score ${score} is above ${approveAbove}`);
  return { version: CHANGE_RISK_VERSION, score, level: changeRiskLevel(score), reasons, approveAbove, over: overBy.length > 0, overBy };
}

/** The approval rules an over change adds to its gate: the settings' `quorum`, or none. */
export function changeRiskQuorum(risk: Pick<ChangeRisk, "over">, settings: Pick<ChangeRiskSettings, "quorum"> | undefined): GateQuorumRule[] {
  return risk.over && settings?.quorum ? settings.quorum.map((r) => ({ ...r })) : [];
}

/**
 * The record as a Cedar gate policy reads it, `context.changeRisk`: Cedar has
 * no decimals, so the score is `percent`, a whole number from 0 to 100.
 */
export interface ChangeRiskContext {
  percent: number;
  level: ChangeRiskLevel;
  over: boolean;
  /** The ids of the reasons that counted something. */
  reasons: string[];
}

/** The `approval.context` key the record lands under on an Op gate that declares `approval.risk`. An authored context may not use it. */
export const CHANGE_RISK_CONTEXT_KEY = "changeRisk";

/** The record as Cedar context. */
export function changeRiskContext(risk: ChangeRisk): ChangeRiskContext {
  return {
    percent: Math.round(risk.score * 100),
    level: risk.level,
    over: risk.over,
    reasons: risk.reasons.filter((r) => r.contribution > 0).map((r) => r.id).sort(),
  };
}

/** Keys a score must never read as: each would let a low score stand in for an approval. */
const REFUSED_KEYS = ["allow_unattended", "allowUnattended", "approveBelow", "approve_below", "passBelow", "skipBelow", "unattended"];

/**
 * What is wrong with a risk settings value, one line each. `quorum` and
 * `questions` are refused where the caller says they are not read, so a
 * setting no chant reads is never accepted.
 */
export function changeRiskProblems(where: string, value: unknown, takes: { quorum: boolean; questions: boolean }, quorumCheck?: (rules: unknown, at: string) => string[]): string[] {
  if (!isMap(value)) return [`\`${where}\` must be { "approveAbove"?: <0 to 1>${takes.quorum ? ', "quorum"?: [...]' : ""}${takes.questions ? ', "questions"?: [...]' : ""} }`];
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (REFUSED_KEYS.includes(key)) problems.push(`\`${where}.${key}\` is refused: a risk score only adds approvals, and nothing lets a plan apply with nobody approving it`);
    else if (key === "approveAbove") {
      if (!unit(value.approveAbove)) problems.push(`\`${where}.approveAbove\` must be a score from 0 to 1`);
    } else if (key === "quorum" && takes.quorum) {
      if (!Array.isArray(value.quorum) || value.quorum.length === 0) problems.push(`\`${where}.quorum\` must be a non-empty list of approval rules`);
      else if (quorumCheck) problems.push(...quorumCheck(value.quorum, `${where}.quorum`));
    } else if (key === "questions" && takes.questions) {
      problems.push(...questionProblems(`${where}.questions`, value.questions));
    } else if ((key === "quorum" && !takes.quorum) || (key === "questions" && !takes.questions)) {
      problems.push(
        key === "quorum"
          ? `\`${where}.quorum\` is read by a stage gate's \`holds.risk\` and an Op gate's \`approval.risk\`; here an over change waits for an approval of its own digest`
          : `\`${where}.questions\` is answered by the pull request's review, so it is set in \`ci.risk.questions\``,
      );
    } else problems.push(`\`${where}.${key}\` is not a setting; the ones there are approveAbove${takes.quorum ? ", quorum" : ""}${takes.questions ? ", questions" : ""}`);
  }
  return problems;
}

function questionProblems(where: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [`\`${where}\` must be a list of { "id", "text", "weight", "approveAbove"? }`];
  const problems: string[] = [];
  const seen = new Set<string>();
  value.forEach((q, i) => {
    const at = `${where}[${i}]`;
    if (!isMap(q)) {
      problems.push(`\`${at}\` must be { "id", "text", "weight", "approveAbove"? }`);
      return;
    }
    if (typeof q.id !== "string" || !QUESTION_ID.test(q.id)) problems.push(`\`${at}.id\` must be lowercase letters, digits, "-" and "_"`);
    else if (seen.has(q.id)) problems.push(`\`${at}.id\` "${q.id}" is named twice`);
    else seen.add(q.id);
    if (typeof q.text !== "string" || q.text.trim() === "") problems.push(`\`${at}.text\` must be the question, as text`);
    if (!unit(q.weight)) problems.push(`\`${at}.weight\` must be from 0 to 1`);
    if (q.approveAbove !== undefined && !unit(q.approveAbove)) problems.push(`\`${at}.approveAbove\` must be from 0 to 1`);
    for (const key of Object.keys(q)) {
      if (REFUSED_KEYS.includes(key)) problems.push(`\`${at}.${key}\` is refused: an answer only adds approvals`);
      else if (!["id", "text", "weight", "approveAbove"].includes(key)) problems.push(`\`${at}.${key}\` is not a setting`);
    }
  });
  return problems;
}

/** One line of plain text, so nothing in a record breaks the note's layout. */
const plain = (s: unknown): string => String(s).split(/\s+/).join(" ").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "\\|").trim();

/** The plan note's lines for a risk record: the score and level, the reasons that counted, and what it asks for. */
export function changeRiskLines(risk: ChangeRisk): string[] {
  const out: string[] = ["", `**Risk:** ${risk.score.toFixed(2)} (${risk.level}).`];
  const counted = (Array.isArray(risk.reasons) ? risk.reasons : []).filter((r) => r.contribution > 0 || r.id.startsWith("question."));
  if (counted.length > 0) {
    out.push("", "| Reason | Weight | Value | Adds |", "|---|---:|---:|---:|");
    for (const r of counted) out.push(`| \`${plain(r.id)}\`: ${plain(r.detail)} | ${r.weight} | ${r.value} | ${r.contribution} |`);
  }
  if (risk.over) out.push("", `${(risk.overBy ?? []).map(plain).join("; ")}, so this plan needs an approval of its own digest.`);
  else if (risk.approveAbove !== null) out.push("", `The score is within ${risk.approveAbove}. A score within it asks for nothing more, and approves nothing.`);
  return out;
}
