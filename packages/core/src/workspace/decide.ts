/**
 * Answers to decision points as records (ws-058, #2739).
 *
 * {@link askPoint} asks a point's deciders for one set of inputs and records
 * the answer in the answer kind's records directory, and {@link answerPoint}
 * records people's answer to an open question. Both write one Markdown record
 * or none, never commit, and go through the checks every records write goes
 * through (`records-write.ts`): the record is read back with the kind's schema
 * before it is written, and no other record may become invalid.
 *
 * - A table's answer is `answered`.
 * - A model's answer at or above its threshold is `proposed`, whatever its
 *   confidence, with the probabilities, confidence and threshold, until a
 *   person confirms it. Below the threshold the question is `escalated`.
 * - A question no decider before the quorum answered is `escalated`: open for
 *   people, with every decider's reason and any model's answer.
 *
 * The same point, declaration and inputs are answered once: the record's id is
 * the point's name and the first 12 hex digits of the inputs hash. Asking again
 * returns the record that is there when it is proposed or answered. An
 * escalated one is asked again, since a backend may answer now, and rewritten
 * only when the chain no longer escalates.
 *
 * chant never calls a model (ws-052): the model call is the caller's
 * {@link ModelAsk}, such as the decide Op activity (#2740), or a backend's
 * response the caller already has (`points ask --response`).
 */

import { writeFileSync } from "node:fs";
import type { ReasonCode } from "./reason-codes";
import { gitRoot } from "./record-source";
import { loadRecordKind, normalisePrincipal, RECORD_REASON_CODES, RecordReadError, type RecordEntry, type RecordWarning } from "./records";
import { declaredKindFiles } from "./records-cli";
import {
  abs,
  LOAD_ERROR_CODES,
  open,
  pick,
  readAll,
  RecordWriteError,
  renderRecord,
  resolveWriteKind,
  schemaOrder,
  validateWrite,
  type KindView,
  type Opened,
} from "./records-write";
import {
  answerId,
  candidates,
  DeciderFailed,
  inputsHash,
  pointOf,
  pointsFileOf,
  pointVersion,
  quorumOf,
  readPointsThrough,
  runChain,
  type ChainResult,
  type Escalation,
  type ModelAsk,
  type Point,
} from "./points";
import { WorkspaceReadError } from "./declaration";
import { policyAtBase, resolveBase } from "./trust/provenance";
import { emptyPolicy, type TrustPolicy } from "./trust/policy";
import { AGENT_ROLE } from "./records-cli";
import type { SourceVia } from "./source-block";

/** The version of the write documents `points ask` and `points answer` print. */
export const POINTS_WRITE_CONTRACT_VERSION = 1;
export const POINTS_WRITE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/points-write/v1/points-write.schema.json";

/** Why `points ask` or `points answer` wrote nothing. Closed: a reader may switch on it. */
export const POINTS_WRITE_ERROR_CODES = [
  ...LOAD_ERROR_CODES,
  "write-usage-invalid",
  "write-input-invalid",
  /** No record kind with an answers block is declared, or given with --kind. */
  "points-undeclared",
  /** The points file the answer kind names can't be read or is not valid. */
  "points-invalid",
  /** No points file declares the point. */
  "point-unknown",
  /** The inputs are not a JSON object of the point's declared inputs. */
  "point-inputs-invalid",
  /** A model decider declared unreachable "fail" could not answer. */
  "point-decider-failed",
  /** The answer is not one of the question's candidates. */
  "answer-not-candidate",
  /** Too few people who count toward the point's quorum answered. */
  "quorum-not-met",
  "record-not-found",
  "record-closed",
  "record-id-taken",
  ...RECORD_REASON_CODES,
] as const satisfies readonly ReasonCode[];
export type PointsWriteErrorCode = (typeof POINTS_WRITE_ERROR_CODES)[number];

export class PointsWriteError extends Error {
  constructor(
    readonly code: PointsWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PointsWriteError";
  }
}

/** An answer as the read contract shows it: in `points --json` and in the documents `points ask` and `points answer` print. */
export interface QuestionView {
  id: string;
  /** The record file, from the repository root, with / separators. */
  path: string;
  point: string;
  title: string;
  /** What the question is about, the record's first `constrains` entry, or null. */
  subject: string | null;
  state: "escalated" | "proposed" | "answered";
  /** Not answered yet: escalated to people, or proposed by a model and waiting for a person to confirm it. */
  open: boolean;
  questionType: string;
  candidates: (string | boolean)[];
  inputs: Record<string, unknown>;
  inputsHash: string;
  pointVersion: string;
  /** The point's declaration is still the one the question was asked under, or null when the points file no longer declares the point. */
  current: boolean | null;
  answer: string | boolean | null;
  decider: Record<string, unknown>;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  threshold: number | null;
  /**
   * Any model answer: the proposal for a proposed question, or for an
   * escalated one the last model answer below its threshold. null when no
   * model answered.
   */
  model: { answer: string | boolean | null; confidence: number | null; threshold: number | null; model: string | null; backend: string | null; observed: boolean } | null;
  escalations: Escalation[];
  answeredBy: string[];
  askedOn: string | null;
  answeredOn: string | null;
  valid: boolean;
  warnings: RecordWarning[];
}

/** One answer record as a {@link QuestionView}, or null when its front matter can't be read. `point` is its point as declared now, when there is one. */
export function questionView(entry: RecordEntry, point: Point | undefined): QuestionView | null {
  const d = entry.data;
  if (d === null || entry.id === null) return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const state = (["escalated", "proposed", "answered"] as const).find((s) => s === entry.state) ?? "escalated";
  const decider = d.decider !== null && typeof d.decider === "object" && !Array.isArray(d.decider) ? (d.decider as Record<string, unknown>) : {};
  const escalations = Array.isArray(d.escalations) ? (d.escalations as Escalation[]) : [];
  const answer = typeof d.answer === "string" || typeof d.answer === "boolean" ? d.answer : null;
  let model: QuestionView["model"] = null;
  if (decider.kind === "model") {
    model = { answer, confidence: num(d.confidence), threshold: num(d.threshold), model: str(decider.model), backend: str(decider.backend), observed: true };
  } else {
    const lean = [...escalations].reverse().find((e) => e.kind === "model" && e.answer !== undefined && e.answer !== null);
    if (lean) model = { answer: lean.answer ?? null, confidence: lean.confidence ?? null, threshold: lean.threshold ?? null, model: lean.model ?? null, backend: lean.backend ?? null, observed: false };
  }
  const constrains = Array.isArray(d.constrains) ? d.constrains.filter((c): c is string => typeof c === "string") : [];
  return {
    id: entry.id,
    path: entry.path,
    point: str(d.point) ?? "",
    title: str(d.title) ?? "",
    subject: constrains[0] ?? null,
    state,
    open: state !== "answered",
    questionType: str(d.question_type) ?? "",
    candidates: Array.isArray(d.candidates) ? (d.candidates as (string | boolean)[]) : [],
    inputs: d.inputs !== null && typeof d.inputs === "object" && !Array.isArray(d.inputs) ? (d.inputs as Record<string, unknown>) : {},
    inputsHash: str(d.inputs_hash) ?? "",
    pointVersion: str(d.point_version) ?? "",
    current: point ? pointVersion(point) === d.point_version : null,
    answer,
    decider,
    probabilities: d.probabilities !== null && typeof d.probabilities === "object" ? (d.probabilities as Record<string, number>) : null,
    confidence: num(d.confidence),
    threshold: num(d.threshold),
    model,
    escalations,
    answeredBy: Array.isArray(d.answered_by) ? d.answered_by.filter((b): b is string => typeof b === "string") : [],
    askedOn: str(d.asked_on),
    answeredOn: str(d.answered_on),
    valid: entry.valid,
    warnings: entry.warnings,
  };
}

/** What `points ask` and `points answer` print. */
export type PointsWriteDocument =
  | {
      $schema: string;
      contract: number;
      verb: "ask" | "answer";
      kind: KindView;
      id: string;
      path: string;
      /** True when the record was already there and nothing new was written. */
      reused: boolean;
      /** True when a file was written. False when reused, and with --dry-run. */
      written: boolean;
      dryRun: boolean;
      question: QuestionView;
      /** With --dry-run, the text the command would write. */
      text?: string;
    }
  | { $schema: string; contract: number; verb: "ask" | "answer"; error: { code: PointsWriteErrorCode; message: string } };

function failure(verb: "ask" | "answer", err: unknown): PointsWriteDocument {
  if (err instanceof PointsWriteError || err instanceof RecordWriteError || err instanceof RecordReadError) {
    return { $schema: POINTS_WRITE_SCHEMA_ID, contract: POINTS_WRITE_CONTRACT_VERSION, verb, error: { code: err.code as PointsWriteErrorCode, message: err.message } };
  }
  if (err instanceof WorkspaceReadError) {
    return { $schema: POINTS_WRITE_SCHEMA_ID, contract: POINTS_WRITE_CONTRACT_VERSION, verb, error: { code: "points-undeclared", message: `the declaration can't be read: ${err.code}: ${err.message}` } };
  }
  throw err;
}

// ── Finding the answer kind and the point ───────────────────────────────────

/**
 * The answer kinds a write can go through: the one `kind` names (a file, or a
 * declared kind's name), or every declared kind with an answers block.
 */
export async function answerKindFiles(cwd: string, kind?: string): Promise<string[]> {
  if (kind !== undefined) return [resolveWriteKind(kind, cwd)];
  const out: string[] = [];
  for (const k of declaredKindFiles(cwd)) {
    try {
      if ((await loadRecordKind(k.file)).kind.answers) out.push(k.file);
    } catch (err) {
      // A kind that can't be loaded is check's to report (WSP115); a write names its kind with --kind.
      if (!(err instanceof RecordReadError)) throw err;
    }
  }
  return out;
}

interface OpenedPoints {
  o: Opened;
  points: Record<string, Point>;
  pointsFile: string;
}

async function openAnswers(kindFile: string, cwd: string): Promise<OpenedPoints> {
  const o = await open(kindFile, cwd);
  if (!o.loaded.kind.answers) throw new PointsWriteError("points-undeclared", `the ${o.loaded.kind.name} kind has no answers block, so it holds no answers to decision points`);
  const pointsFile = pointsFileOf(o.loaded, o.root);
  const read = readPointsThrough(o.source, pointsFile);
  if ("error" in read) throw new PointsWriteError("points-invalid", read.error);
  return { o, points: read.points, pointsFile };
}

// ── points ask ───────────────────────────────────────────────────────────────

export interface AskPointOptions {
  /** Where the kind resolves and the workspace is found. */
  cwd: string;
  /** The point's name. */
  point: string;
  /** The inputs, keyed by the point's declared input names. */
  inputs: unknown;
  /** What the question is about, such as a work item's id: written to `constrains`. */
  subject?: string;
  /** The answer kind file, or a declared kind's name. Without it, the declared answer kind whose points file declares the point. */
  kind?: string;
  /** The model call. Without it, a model decider is not asked. */
  ask?: ModelAsk;
  /** How the answer reached the workspace, for its source block (#2708). Defaults to cli. */
  via?: SourceVia;
  /** The client that asked, for its source block. */
  client?: { name: string; version?: string };
  /** The date written as asked_on, and answered_on for a table's answer, YYYY-MM-DD. Defaults to today, in UTC. */
  on?: string;
  dryRun?: boolean;
}

const today = (): string => new Date().toISOString().slice(0, 10);
const show = (answer: string | boolean, type: string): string => (type === "noul" ? (answer ? "yes" : "no") : String(answer));

function titleFor(point: Point, subject: string | undefined, state: string, answer: string | boolean | undefined): string {
  const outcome = state === "escalated" ? "open for people" : state === "proposed" ? `${show(answer!, point.question.type)}, proposed` : show(answer!, point.question.type);
  return `${point.title}${subject ? ` (${subject})` : ""}: ${outcome}`;
}

function body(point: Point, title: string): string {
  const q = point.question;
  const describe = (c: string | boolean): string => (q.type === "score" ? "" : ((q.criteria as Record<string, string>)[String(c)] ?? ""));
  const options = candidates(q).map((c) => `- ${show(c, q.type)}${describe(c) ? `: ${describe(c)}` : ""}`);
  return ["", `# ${title}`, "", q.instructions.trim(), "", ...options, ""].join("\n");
}

/** The first kind whose points file declares `name`. */
async function findPoint(kinds: string[], name: string, cwd: string): Promise<OpenedPoints & { point: Point }> {
  if (kinds.length === 0) throw new PointsWriteError("points-undeclared", "no record kind with an answers block is declared: name one with --kind, or declare one in chant.workspace.json");
  const declared: string[] = [];
  for (const k of kinds) {
    const opened = await openAnswers(k, cwd);
    const point = pointOf(opened.points, name);
    if (point) return { ...opened, point };
    declared.push(...Object.keys(opened.points));
  }
  throw new PointsWriteError("point-unknown", `no points file declares ${JSON.stringify(name)}${declared.length ? ` (the points are ${declared.join(", ")})` : ""}`);
}

function checkInputs(name: string, point: Point, inputs: unknown): Record<string, unknown> {
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) throw new PointsWriteError("point-inputs-invalid", `the inputs to ${name} must be a JSON object`);
  const declared = Object.keys(point.inputs);
  const unknown = Object.keys(inputs).filter((k) => !declared.includes(k));
  if (unknown.length > 0) {
    throw new PointsWriteError("point-inputs-invalid", `${name} reads ${declared.join(", ")}, and the inputs also give ${unknown.join(", ")}`);
  }
  return inputs as Record<string, unknown>;
}

/** Write `data` as the record at `path`, after reading it back with every other record. */
async function write(o: Opened, before: RecordEntry[], path: string, text: string, create: boolean, dryRun: boolean): Promise<RecordWarning[]> {
  const warnings = await validateWrite(o, before, path, text);
  if (!dryRun) {
    try {
      writeFileSync(abs(o, path), text, create ? { flag: "wx" } : undefined);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new PointsWriteError("record-id-taken", `${path} was written by another ask at the same time: ask again to read it`);
      throw err;
    }
  }
  return warnings;
}

function recordData(o: Opened, fields: Record<string, unknown>): Record<string, unknown> {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  // The schema's properties order, so a record reads question, then answer, then when.
  return pick(clean, schemaOrder(clean, { properties: o.loaded.schema.properties }));
}

function resultFields(result: ChainResult): Record<string, unknown> {
  const escalations = result.escalations.length > 0 ? result.escalations : undefined;
  if (result.status === "proposed") {
    return { state: "proposed", answer: result.answer, decider: result.decider, probabilities: result.probabilities, confidence: result.confidence, threshold: result.threshold, escalations };
  }
  if (result.status === "answered") return { state: "answered", answer: result.answer, decider: result.decider, escalations };
  return { state: "escalated", decider: result.decider, escalations };
}

/**
 * Ask a point for these inputs, and record the answer: `points ask`. Returns
 * the record that is there when the same point, declaration and inputs were
 * answered or proposed before.
 */
export async function askPoint(opts: AskPointOptions): Promise<PointsWriteDocument> {
  try {
    const kinds = await answerKindFiles(opts.cwd, opts.kind);
    const { o, point } = await findPoint(kinds, opts.point, opts.cwd);
    const inputs = checkInputs(opts.point, point, opts.inputs);
    const version = pointVersion(point);
    const hash = inputsHash(opts.point, version, inputs);
    const id = answerId(opts.point, hash);
    const before = await readAll(o, o.source);
    const existing = before.find((e) => e.id === id);
    const done = (entry: RecordEntry, extra: { reused: boolean; written: boolean; text?: string }): PointsWriteDocument => ({
      $schema: POINTS_WRITE_SCHEMA_ID,
      contract: POINTS_WRITE_CONTRACT_VERSION,
      verb: "ask",
      kind: o.view,
      id,
      path: entry.path,
      reused: extra.reused,
      written: extra.written,
      dryRun: !!opts.dryRun,
      question: questionView(entry, point)!,
      ...(extra.text !== undefined ? { text: extra.text } : {}),
    });
    if (existing && existing.data !== null && (existing.state === "answered" || existing.state === "proposed")) return done(existing, { reused: true, written: false });

    let result: ChainResult;
    try {
      result = await runChain(opts.point, point, inputs, opts.ask);
    } catch (err) {
      if (err instanceof DeciderFailed) throw new PointsWriteError("point-decider-failed", err.message);
      throw err;
    }
    // A standing escalation is kept while the chain still escalates.
    if (existing && existing.data !== null && result.status === "escalated") return done(existing, { reused: true, written: false });

    const on = opts.on ?? today();
    const state = result.status;
    const answer = result.status === "escalated" ? undefined : result.answer;
    const title = titleFor(point, opts.subject, state, answer);
    const modelId = result.status === "proposed" ? result.decider.model : undefined;
    const source = { via: opts.via ?? "cli", ...(opts.client ? { client: opts.client } : {}), ...(modelId ? { model: modelId } : {}) };
    const data = recordData(o, {
      id,
      title,
      point: opts.point,
      point_version: version,
      question_type: point.question.type,
      candidates: candidates(point.question),
      inputs,
      inputs_hash: hash,
      constrains: opts.subject !== undefined ? [opts.subject] : existing?.data?.constrains,
      ...resultFields(result),
      asked_on: on,
      answered_on: state === "answered" ? on : undefined,
      source,
    });
    const path = existing ? existing.path : o.dirRel === "." ? `${id}.md` : `${o.dirRel}/${id}.md`;
    const text = renderRecord(data, body(point, title));
    const warnings = await write(o, before, path, text, !existing, !!opts.dryRun);
    const entry: RecordEntry = { ...(existing ?? emptyEntry(path)), id, path, state, data, valid: true, reasons: [], warnings };
    return done(entry, { reused: false, written: !opts.dryRun, ...(opts.dryRun ? { text } : {}) });
  } catch (err) {
    return failure("ask", err);
  }
}

function emptyEntry(path: string): RecordEntry {
  return { id: null, path, state: null, valid: true, reasons: [], supersededBy: null, data: null, assets: [], warnings: [], digest: "" };
}

// ── points answer ────────────────────────────────────────────────────────────

export interface AnswerPointOptions {
  cwd: string;
  /** The answer record's id. */
  id: string;
  /** The people's answer: one of the question's candidates. For a noul, true, false, yes or no. */
  answer: string | boolean;
  /** Who answered, as the caller names them. chant does not check who they are; the trust policy says who counts. */
  by: string[];
  kind?: string;
  on?: string;
  dryRun?: boolean;
}

/** The trust policy at base, for the quorum: who holds the agent role and each role a quorum names. */
function policyFor(root: string): TrustPolicy {
  if (!gitRoot(root)) return emptyPolicy(null);
  try {
    return policyAtBase(root, resolveBase(root));
  } catch {
    return emptyPolicy(null);
  }
}

/**
 * Count `by` toward a point's quorum: distinct people, after normalising,
 * leaving out anyone holding the agent role in the trust policy at base, and,
 * when the quorum names roles, anyone holding none of them.
 */
export function tallyQuorum(by: string[], quorum: { count: number; roles?: string[] }, policy: TrustPolicy): { counted: string[]; left: { name: string; why: string }[]; met: boolean } {
  const holders = (role: string) => new Set((policy.roles[role] ?? []).map(normalisePrincipal));
  const agents = holders(AGENT_ROLE);
  const counted: string[] = [];
  const seen = new Set<string>();
  const left: { name: string; why: string }[] = [];
  for (const name of by) {
    const p = normalisePrincipal(name);
    if (p === "" || seen.has(p)) continue;
    seen.add(p);
    if (agents.has(p)) {
      left.push({ name, why: "holds the agent role" });
      continue;
    }
    if (quorum.roles && !quorum.roles.some((r) => holders(r).has(p))) {
      left.push({ name, why: `holds none of the roles ${quorum.roles.join(", ")}` });
      continue;
    }
    counted.push(name);
  }
  return { counted, left, met: counted.length >= quorum.count };
}

/**
 * People answer an open question: `points answer`. A proposed question the
 * people answer as the model did is confirmed, and keeps the model as its
 * decider; any other answer is the quorum's, and a model's proposal moves into
 * the escalations. The question becomes `answered`.
 */
export async function answerPoint(opts: AnswerPointOptions): Promise<PointsWriteDocument> {
  try {
    const kinds = await answerKindFiles(opts.cwd, opts.kind);
    if (kinds.length === 0) throw new PointsWriteError("points-undeclared", "no record kind with an answers block is declared: name one with --kind, or declare one in chant.workspace.json");
    let found: { opened: OpenedPoints; before: RecordEntry[]; target: RecordEntry & { data: Record<string, unknown> } } | undefined;
    for (const k of kinds) {
      const opened = await openAnswers(k, opts.cwd);
      const before = await readAll(opened.o, opened.o.source);
      const target = before.find((e) => e.id === opts.id);
      if (target && target.data !== null) {
        found = { opened, before, target: target as RecordEntry & { data: Record<string, unknown> } };
        break;
      }
    }
    if (!found) throw new PointsWriteError("record-not-found", `no answer record has id ${opts.id}`);
    const { opened, before, target } = found;
    const { o } = opened;
    const d = target.data;
    if (target.state === "answered") throw new PointsWriteError("record-closed", `${opts.id} is answered, and an answer never changes: ask again with other inputs, or change the point, which asks the question anew`);
    const name = String(d.point);
    const point = pointOf(opened.points, name);
    if (!point) throw new PointsWriteError("point-unknown", `${opts.id} answers ${name}, which ${opened.pointsFile} no longer declares`);
    const allowed = Array.isArray(d.candidates) ? (d.candidates as (string | boolean)[]) : candidates(point.question);
    const type = String(d.question_type);
    const value = type === "noul" && typeof opts.answer === "string" ? ({ true: true, yes: true, false: false, no: false } as Record<string, boolean>)[opts.answer.toLowerCase()] : opts.answer;
    if (value === undefined || !allowed.includes(value)) {
      throw new PointsWriteError("answer-not-candidate", `${opts.id} takes one of ${allowed.map((c) => JSON.stringify(c)).join(", ")}, not ${JSON.stringify(opts.answer)}`);
    }
    const quorum = quorumOf(point);
    const tally = tallyQuorum(opts.by, quorum, policyFor(o.root));
    if (!tally.met) {
      const got = tally.counted.length;
      const left = tally.left.length ? `; not counted: ${tally.left.map((l) => `${l.name}, who ${l.why}`).join("; ")}` : "";
      throw new PointsWriteError(
        "quorum-not-met",
        `${name} needs ${quorum.count} ${quorum.count === 1 ? "person" : "people"}${quorum.roles ? ` holding ${quorum.roles.join(" or ")}` : ""} to answer, and ${got} ${got === 1 ? "counts" : "count"}${got ? ` (${tally.counted.join(", ")})` : ""}${left}`,
      );
    }
    const on = opts.on ?? today();
    const decider = d.decider as Record<string, unknown>;
    const confirmed = target.state === "proposed" && decider.kind === "model" && d.answer === value;
    const escalations = Array.isArray(d.escalations) ? [...(d.escalations as Escalation[])] : [];
    let fields: Record<string, unknown>;
    if (confirmed) {
      fields = { ...d, state: "answered", answered_by: tally.counted, answered_on: on };
    } else {
      if (target.state === "proposed" && decider.kind === "model") {
        escalations.push({
          kind: "model",
          backend: String(decider.backend),
          model: String(decider.model),
          answer: d.answer as string | boolean,
          ...(d.probabilities ? { probabilities: d.probabilities as Record<string, number> } : {}),
          ...(typeof d.confidence === "number" ? { confidence: d.confidence } : {}),
          ...(typeof d.threshold === "number" ? { threshold: d.threshold } : {}),
          reason: `proposed ${show(d.answer as string | boolean, type)}, and people answered ${show(value, type)}`,
        });
      }
      const rest = Object.fromEntries(Object.entries(d).filter(([k]) => k !== "probabilities" && k !== "confidence" && k !== "threshold"));
      fields = {
        ...rest,
        state: "answered",
        answer: value,
        decider: { kind: "quorum", count: quorum.count, ...(quorum.roles ? { roles: quorum.roles } : {}), by: tally.counted },
        escalations: escalations.length > 0 ? escalations : undefined,
        answered_by: tally.counted,
        answered_on: on,
      };
    }
    const subject = Array.isArray(d.constrains) && typeof d.constrains[0] === "string" ? (d.constrains[0] as string) : undefined;
    fields.title = titleFor(point, subject, "answered", value);
    const data = recordData(o, fields);
    const text = renderRecord(data, body(point, String(fields.title)));
    const warnings = await write(o, before, target.path, text, false, !!opts.dryRun);
    const entry: RecordEntry = { ...target, state: "answered", data, valid: true, reasons: [], warnings };
    return {
      $schema: POINTS_WRITE_SCHEMA_ID,
      contract: POINTS_WRITE_CONTRACT_VERSION,
      verb: "answer",
      kind: o.view,
      id: opts.id,
      path: target.path,
      reused: false,
      written: !opts.dryRun,
      dryRun: !!opts.dryRun,
      question: questionView(entry, point)!,
      ...(opts.dryRun ? { text } : {}),
    };
  } catch (err) {
    return failure("answer", err);
  }
}
