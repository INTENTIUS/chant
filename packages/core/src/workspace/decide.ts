/**
 * Answers to decision points as records (ws-058, #2739).
 *
 * {@link askPoint} asks a point's deciders for one set of inputs and records
 * the answer in the answer kind's records directory, {@link answerPoint}
 * records people's answer to an open question, with an optional note, and
 * {@link retractAnswer} takes an answer back (#3351). Each writes one Markdown
 * record or none, never commits, and goes through the checks every records write goes
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
 * An ad-hoc point (#3403) has no candidates of its own: each ask gives the
 * question's text and candidates, the record keeps them as `asked`, and they
 * are part of the inputs hash, so a question asked with other options is
 * another question. People's answer is checked against them.
 *
 * An answer never changes in place. People may retract it (ws-084): the
 * question is escalated to them again, and the answer, who gave it, when, and
 * its note move into the record's `retractions` with who retracted it, when
 * and why. Asking a retracted question again returns it as it stands, since
 * people took it back from the deciders; people answer it again.
 *
 * Each write holds the working tree's write lock (#3173, ws-089) from the first read
 * to the write, so two answers to one question are never both taken from the
 * same reading of it.
 *
 * chant never calls a model (ws-052): the model call is the caller's
 * {@link ModelAsk}, such as the decide Op activity (#2740), or a backend's
 * response the caller already has (`points ask --response`).
 */

import { writeFileSync } from "node:fs";
import { noteWrites, withWriteLock, WriteLockError, WRITE_LOCK_CODES, type WriteLockWho } from "./write-lock";
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
  askedOf,
  askedQuestion,
  candidates,
  DeciderFailed,
  inputsHash,
  parseAsked,
  pointOf,
  pointsFileOf,
  pointVersion,
  quorumOf,
  readPointsThrough,
  runChain,
  type Asked,
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
import type { RecordSource } from "./record-source";
import { currentStewardTurn } from "../op/steward-turn";
import { IdentityError, refuseUnidentified } from "./identity";
import { scopeSource } from "./write-scope";
import { RefCASConflictError } from "../lifecycle/git";
import { readLedgerAnswers, refreshLedger, withLedgerAnswers, writeLedgerAnswer, type LedgerAnswers } from "./answers-ledger";

/** The version of the write documents `points ask`, `points answer` and `points retract` print. */
export const POINTS_WRITE_CONTRACT_VERSION = 1;
export const POINTS_WRITE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/points-write/v1/points-write.schema.json";

/** Why `points ask`, `points answer` or `points retract` wrote nothing. Closed: a reader may switch on it. */
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
  /** The answer was given during a steward's turn (#2749): a steward never answers a question, its own or another's. */
  "answer-in-steward-turn",
  /** An answerer is named by a bare name, and identity.attribution at base is identified (#3163). */
  "principal-unidentified",
  /** `points retract` names a question that has no answer: escalated or proposed (#3351). */
  "answer-not-answered",
  /** The answer kind's schema copy has no `note`, `retractions`, `relayed_by` or `asked` field for what the write was given (#3351, #3402, #3403). */
  "answer-field-unsupported",
  /** An ad-hoc point was asked without its question and candidates, a declared point with them, or they don't fit the point's question type (#3403). */
  "point-candidates-invalid",
  ...WRITE_LOCK_CODES,
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
   * The model's explanation of the recorded answer (#3345): a proposal's, or a
   * confirmed proposal's. null when a model gave none, or did not decide.
   */
  reason: string | null;
  /**
   * Any model answer: the proposal for a proposed question, or for an
   * escalated one the last model answer below its threshold. null when no
   * model answered. `reason` is the model's explanation of that answer, or
   * null when it gave none (#3345).
   */
  model: { answer: string | boolean | null; confidence: number | null; threshold: number | null; model: string | null; backend: string | null; observed: boolean; reason: string | null } | null;
  escalations: Escalation[];
  answeredBy: string[];
  askedOn: string | null;
  answeredOn: string | null;
  /** What the people who answered wrote with their answer (`points answer --note`, #3351), or null. */
  note: string | null;
  /** Who relayed the answer to chant for the people who gave it (`points answer --relayed-by`, #3402), or null. */
  relayedBy: string | null;
  /** Answers people took back, oldest first (`points retract`, #3351). Empty when none was. */
  retractions: RetractionView[];
  /**
   * An ad-hoc point's question as its ask gave it (#3403): the question's text
   * and its criteria, what each candidate means. null for a declared point's
   * question, whose text and criteria are the point's.
   */
  asked: Asked | null;
  /**
   * The steward whose turn asked the question (#2749), and the run it was in,
   * or null when no steward asked it. The steward waits on the question and
   * never answers it: a person does, through hud or `points answer`.
   */
  askedBy: { steward: string; run: string | null } | null;
  /**
   * Where the record is held when it is on the lifecycle ledger rather than
   * in the working tree (#2786): `chant/lifecycle:<path>`, which `git show`
   * reads. A question asked in a steward's turn is held there, since a
   * steward never writes the checkout. null for a record in the tree; `path`
   * is where the record reads as being either way.
   */
  ledger: string | null;
  valid: boolean;
  warnings: RecordWarning[];
}

/** One retracted answer, as a {@link QuestionView} lists it: the answer as it was, and who took it back, when and why. */
export interface RetractionView {
  answer: string | boolean | null;
  decider: Record<string, unknown>;
  answeredBy: string[];
  answeredOn: string | null;
  /** The note the answer carried, or null. */
  answerNote: string | null;
  /** Who relayed the answer (#3402), or null. */
  answerRelayedBy: string | null;
  /** Who retracted it. */
  by: string[];
  on: string | null;
  /** Why it was retracted (`points retract --note`), or null. */
  note: string | null;
}

/** The record's `retractions`, as views. */
function retractionsOf(d: Record<string, unknown>): RetractionView[] {
  if (!Array.isArray(d.retractions)) return [];
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return d.retractions
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r))
    .map((r) => ({
      answer: typeof r.answer === "string" || typeof r.answer === "boolean" ? r.answer : null,
      decider: r.decider !== null && typeof r.decider === "object" && !Array.isArray(r.decider) ? (r.decider as Record<string, unknown>) : {},
      answeredBy: strs(r.answered_by),
      answeredOn: str(r.answered_on),
      answerNote: str(r.answer_note),
      answerRelayedBy: str(r.answer_relayed_by),
      by: strs(r.by),
      on: str(r.on),
      note: str(r.note),
    }));
}

/** The harness a steward's question names in its source block (#2749). */
export const STEWARD_HARNESS = "chant-steward";

/** The steward that asked, from a record's source block, or null. */
export function askedByOf(data: Record<string, unknown>): QuestionView["askedBy"] {
  const source = data.source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return null;
  const s = source as Record<string, unknown>;
  if (s.harness !== STEWARD_HARNESS) return null;
  const client = s.client as Record<string, unknown> | undefined;
  const steward = client && typeof client.name === "string" ? client.name : null;
  if (steward === null) return null;
  const session = s.session as Record<string, unknown> | string | undefined;
  const run = typeof session === "string" ? session : session && typeof session === "object" && typeof session.id === "string" ? session.id : null;
  return { steward, run };
}

/**
 * One answer record as a {@link QuestionView}, or null when its front matter
 * can't be read. `point` is its point as declared now, when there is one, and
 * `ledger` where the record is held when it is on the lifecycle ledger.
 */
export function questionView(entry: RecordEntry, point: Point | undefined, ledger: string | null = null): QuestionView | null {
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
    model = { answer, confidence: num(d.confidence), threshold: num(d.threshold), model: str(decider.model), backend: str(decider.backend), observed: true, reason: str(d.reason) };
  } else {
    const lean = [...escalations].reverse().find((e) => e.kind === "model" && e.answer !== undefined && e.answer !== null);
    if (lean) {
      model = {
        answer: lean.answer ?? null,
        confidence: lean.confidence ?? null,
        threshold: lean.threshold ?? null,
        model: lean.model ?? null,
        backend: lean.backend ?? null,
        observed: false,
        reason: typeof lean.model_reason === "string" ? lean.model_reason : null,
      };
    }
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
    reason: decider.kind === "model" ? str(d.reason) : null,
    model,
    escalations,
    answeredBy: Array.isArray(d.answered_by) ? d.answered_by.filter((b): b is string => typeof b === "string") : [],
    askedOn: str(d.asked_on),
    answeredOn: str(d.answered_on),
    note: str(d.note),
    relayedBy: str(d.relayed_by),
    retractions: retractionsOf(d),
    asked: askedOf(d) ?? null,
    askedBy: askedByOf(d),
    ledger,
    valid: entry.valid,
    warnings: entry.warnings,
  };
}

/** The write verbs of `points`. */
export type PointsWriteVerb = "ask" | "answer" | "retract";

/** What `points ask`, `points answer` and `points retract` print. */
export type PointsWriteDocument =
  | {
      $schema: string;
      contract: number;
      verb: PointsWriteVerb;
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
  | { $schema: string; contract: number; verb: PointsWriteVerb; error: { code: PointsWriteErrorCode; message: string } };

function failure(verb: PointsWriteVerb, err: unknown): PointsWriteDocument {
  if (err instanceof PointsWriteError || err instanceof RecordWriteError || err instanceof RecordReadError || err instanceof IdentityError || err instanceof WriteLockError) {
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
  /**
   * An ad-hoc point's question and candidates (#3403), as `{ question,
   * criteria }` in the point's question type's shape. Required for an ad-hoc
   * point and refused for a declared one.
   */
  candidates?: unknown;
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
  /**
   * The steward whose turn asks (#2749), and its run. Recorded in the source
   * block (harness `chant-steward`, the steward as the client, the run as the
   * session), so the question says who is waiting on it and `points answer`
   * never counts the steward toward its quorum. Takes the place of `client`.
   */
  steward?: { name: string; run?: string };
  /**
   * Where a new record goes: the answer kind's directory in the working tree,
   * or the lifecycle ledger (#2786). Defaults to the ledger in a steward's
   * turn (`steward` given, or this process a steward's turn), since a steward
   * never writes the checkout, and to the tree otherwise. A question already
   * held on the ledger is rewritten there whatever this says.
   */
  store?: "tree" | "ledger";
  /** The date written as asked_on, and answered_on for a table's answer, YYYY-MM-DD. Defaults to today, in UTC. */
  on?: string;
  dryRun?: boolean;
}

const today = (): string => new Date().toISOString().slice(0, 10);
const show = (answer: string | boolean, type: string): string => (type === "noul" ? (answer ? "yes" : "no") : String(answer));

/** A record's title: the point's title, or an ad-hoc question's own text (#3403), what it is about, and where it stands. */
function titleFor(point: Point, subject: string | undefined, state: string, answer: string | boolean | undefined, asked?: Asked): string {
  const outcome = state === "escalated" ? "open for people" : state === "proposed" ? `${show(answer!, point.question.type)}, proposed` : show(answer!, point.question.type);
  return `${asked ? asked.question : point.title}${subject ? ` (${subject})` : ""}: ${outcome}`;
}

function body(point: Point, title: string, asked?: Asked): string {
  const q = askedQuestion(point, asked);
  const describe = (c: string | boolean): string => (q.type === "score" ? "" : ((q.criteria as Record<string, string> | undefined)?.[String(c)] ?? ""));
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

/**
 * An ad-hoc point's question and candidates from the ask (#3403), or
 * undefined for a declared point. Refused when an ad-hoc point has none, a
 * declared point is given them, they don't fit the question type, or the
 * answer kind's schema copy has no `asked` field to keep them in.
 */
function checkAsked(name: string, point: Point, given: unknown, loaded: { kind: { name: string }; schema: Record<string, unknown> }): Asked | undefined {
  if (!point.adhoc) {
    if (given !== undefined) throw new PointsWriteError("point-candidates-invalid", `${name} declares its candidates, so the ask gives none: --candidates is for an ad-hoc point`);
    return undefined;
  }
  if (given === undefined) throw new PointsWriteError("point-candidates-invalid", `${name} is an ad-hoc point, so each ask gives the question and its candidates: --candidates <file|-|json>`);
  const parsed = parseAsked(point, given);
  if ("problems" in parsed) throw new PointsWriteError("point-candidates-invalid", `the candidates for ${name}, a ${point.question.type} question: ${parsed.problems.join("; ")}`);
  if (!answerFields(loaded.schema).asked) {
    throw new PointsWriteError("answer-field-unsupported", `the ${loaded.kind.name} kind's schema has no asked field, so an ad-hoc question's text and candidates can't be kept: copy point-answer.schema.json from @intentius/chant anew`);
  }
  return parsed.asked;
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

/** Where a write goes: the working tree, or the lifecycle ledger (#2786). */
interface WriteTarget {
  /** The records as read: the tree with the ledger's answers laid over it. */
  source: RecordSource;
  ledger: LedgerAnswers;
  /** Write to the ledger rather than the tree. */
  onLedger: boolean;
  message: string;
  /** Who writes, for the write journal (#3173). */
  who: WriteLockWho;
}

/**
 * Write `text` as the record at `path`, after reading it back with every
 * other record: into the working tree, or onto the ledger. Returns the
 * record's warnings and, for a ledger write, where it went.
 */
async function write(o: Opened, before: RecordEntry[], path: string, text: string, create: boolean, dryRun: boolean, target: WriteTarget): Promise<{ warnings: RecordWarning[]; ledger: string | null }> {
  const warnings = await validateWrite(o, before, path, text, target.source);
  const held = target.ledger.byPath.get(path);
  if (target.onLedger) {
    if (dryRun) return { warnings, ledger: held?.ledger ?? null };
    try {
      const { ledger } = await writeLedgerAnswer(target.ledger, path, text, target.message, held?.sha ?? null);
      return { warnings, ledger };
    } catch (err) {
      if (err instanceof RefCASConflictError) throw new PointsWriteError("record-id-taken", `${path} was written on chant/lifecycle by another ask or answer at the same time: ask again to read it`);
      throw err;
    }
  }
  if (!dryRun) {
    try {
      writeFileSync(abs(o, path), text, create ? { flag: "wx" } : undefined);
      noteWrites(o.root, [{ path, text }], target.who);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new PointsWriteError("record-id-taken", `${path} was written by another ask at the same time: ask again to read it`);
      throw err;
    }
  }
  return { warnings, ledger: null };
}

/** The kind's answers on the ledger, and its records read with them laid over the tree. */
async function readWithLedger(o: Opened): Promise<{ ledger: LedgerAnswers; source: RecordSource; before: RecordEntry[] }> {
  const ledger = await readLedgerAnswers({ file: o.loaded.file, name: o.loaded.kind.name, dirRel: o.dirRel });
  const source = withLedgerAnswers(o.source, ledger);
  return { ledger, source, before: await readAll(o, source) };
}

function recordData(o: Opened, fields: Record<string, unknown>): Record<string, unknown> {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  // The schema's properties order, so a record reads question, then answer, then when.
  return pick(clean, schemaOrder(clean, { properties: o.loaded.schema.properties }));
}

/**
 * Whether an answer kind's schema copy takes the model's reason (#3345): at
 * the top level, and in an escalation entry as `model_reason`. A workspace
 * whose copy of point-answer.schema.json predates them keeps no reason rather
 * than failing the write; copying the schema anew turns them on.
 */
export function reasonFields(schema: Record<string, unknown>): { top: boolean; escalation: boolean } {
  const has = (o: unknown, key: string): boolean => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, key);
  const defs = (schema.definitions ?? schema.$defs) as Record<string, { properties?: unknown }> | undefined;
  return { top: has(schema.properties, "reason"), escalation: has(defs?.escalation?.properties, "model_reason") };
}

/** Escalations without `model_reason` when the kind's schema does not take it. */
function keepReasons(escalations: Escalation[], takes: { escalation: boolean }): Escalation[] {
  return takes.escalation ? escalations : escalations.map(({ model_reason: _, ...e }) => e);
}

function resultFields(result: ChainResult, takes: { top: boolean; escalation: boolean }): Record<string, unknown> {
  const escalations = result.escalations.length > 0 ? keepReasons(result.escalations, takes) : undefined;
  if (result.status === "proposed") {
    const reason = takes.top ? result.reason : undefined;
    return { state: "proposed", answer: result.answer, decider: result.decider, probabilities: result.probabilities, confidence: result.confidence, threshold: result.threshold, reason, escalations };
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
    return await withWriteLock(opts.cwd, { verb: "points ask", by: opts.steward?.name ?? null }, opts.dryRun, () => askPointLocked(opts));
  } catch (err) {
    return failure("ask", err);
  }
}

async function askPointLocked(opts: AskPointOptions): Promise<PointsWriteDocument> {
  try {
    // A steward's turn (#2749): named by the caller, or this process's, as when an Op shells out to `points ask`.
    const turn = opts.steward ? undefined : currentStewardTurn();
    const steward = opts.steward ?? (turn ? { name: turn.steward, ...(turn.run ? { run: turn.run } : {}) } : undefined);
    const toLedger = opts.store !== undefined ? opts.store === "ledger" : steward !== undefined;
    const kinds = await answerKindFiles(opts.cwd, opts.kind);
    const { o, point } = await findPoint(kinds, opts.point, opts.cwd);
    const inputs = checkInputs(opts.point, point, opts.inputs);
    const asked = checkAsked(opts.point, point, opts.candidates, o.loaded);
    const version = pointVersion(point);
    const hash = inputsHash(opts.point, version, inputs, asked);
    const id = answerId(opts.point, hash);
    if (toLedger && !opts.dryRun) await refreshLedger(o.loaded.file);
    const { ledger, source: read, before } = await readWithLedger(o);
    const existing = before.find((e) => e.id === id);
    const heldAt = (entry: RecordEntry): string | null => ledger.byPath.get(entry.path)?.ledger ?? null;
    const done = (entry: RecordEntry, extra: { reused: boolean; written: boolean; text?: string; ledger?: string | null }): PointsWriteDocument => ({
      $schema: POINTS_WRITE_SCHEMA_ID,
      contract: POINTS_WRITE_CONTRACT_VERSION,
      verb: "ask",
      kind: o.view,
      id,
      path: entry.path,
      reused: extra.reused,
      written: extra.written,
      dryRun: !!opts.dryRun,
      question: questionView(entry, point, extra.ledger !== undefined ? extra.ledger : heldAt(entry))!,
      ...(extra.text !== undefined ? { text: extra.text } : {}),
    });
    if (existing && existing.data !== null && (existing.state === "answered" || existing.state === "proposed")) return done(existing, { reused: true, written: false });
    // People took a retracted question back from the deciders (ws-084): they answer it again, and asking returns it as it stands.
    if (existing && existing.data !== null && Array.isArray(existing.data.retractions) && existing.data.retractions.length > 0) return done(existing, { reused: true, written: false });

    let result: ChainResult;
    try {
      result = await runChain(opts.point, { ...point, question: askedQuestion(point, asked) }, inputs, opts.ask);
    } catch (err) {
      if (err instanceof DeciderFailed) throw new PointsWriteError("point-decider-failed", err.message);
      throw err;
    }
    // A standing escalation is kept while the chain still escalates.
    if (existing && existing.data !== null && result.status === "escalated") return done(existing, { reused: true, written: false });

    const on = opts.on ?? today();
    const state = result.status;
    const answer = result.status === "escalated" ? undefined : result.answer;
    const title = titleFor(point, opts.subject, state, answer, asked);
    const modelId = result.status === "proposed" ? result.decider.model : undefined;
    const client = steward ? { name: steward.name } : opts.client;
    const source = {
      via: opts.via ?? "cli",
      ...(steward ? { harness: STEWARD_HARNESS } : {}),
      ...(client ? { client } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(steward?.run ? { session: { id: steward.run } } : {}),
    };
    const data = recordData(o, {
      id,
      title,
      point: opts.point,
      point_version: version,
      question_type: point.question.type,
      candidates: candidates(askedQuestion(point, asked)),
      asked,
      inputs,
      inputs_hash: hash,
      constrains: opts.subject !== undefined ? [opts.subject] : existing?.data?.constrains,
      ...resultFields(result, reasonFields(o.loaded.schema)),
      asked_on: on,
      answered_on: state === "answered" ? on : undefined,
      source,
    });
    const path = existing ? existing.path : o.dirRel === "." ? `${id}.md` : `${o.dirRel}/${id}.md`;
    const text = renderRecord(data, body(point, title, asked));
    // A steward's question goes on the ledger, and one already held there stays there (#2786).
    const onLedger = toLedger || ledger.byPath.has(path);
    const message = `Decision point ${opts.point}: ${state}${opts.subject ? ` (${opts.subject})` : ""}${steward ? `, asked by ${steward.name}` : ""}`;
    const wrote = await write(o, before, path, text, !existing, !!opts.dryRun, { source: read, ledger, onLedger, message, who: { verb: "points ask", by: steward?.name ?? null } });
    const entry: RecordEntry = { ...(existing ?? emptyEntry(path)), id, path, state, data, valid: true, reasons: [], warnings: wrote.warnings };
    return done(entry, { reused: false, written: !opts.dryRun, ledger: wrote.ledger, ...(opts.dryRun ? { text } : {}) });
  } catch (err) {
    return failure("ask", err);
  }
}

function emptyEntry(path: string): RecordEntry {
  return { id: null, path, state: null, valid: true, reasons: [], supersededBy: null, remediatedBy: [], data: null, assets: [], warnings: [], digest: "" };
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
  /** What the people who answered say with it, recorded as the record's `note` (#3351). */
  note?: string;
  /**
   * Who carried the answer to chant for the people in `by` (#3402), such as a
   * follower relaying a person's answer through hud, recorded as the record's
   * `relayed_by`. The relay does not count toward the quorum.
   */
  relayedBy?: string;
  kind?: string;
  on?: string;
  dryRun?: boolean;
}

/**
 * Whether an answer kind's schema copy takes the fields of #3351 (`note` on an
 * answer, and `retractions`), of #3402 (`relayed_by`) and of #3403 (`asked`).
 * A copy of point-answer.schema.json from before them refuses a note, a
 * retraction, a relay or an ad-hoc ask with `answer-field-unsupported`, rather
 * than dropping what a person wrote or the question an agent asked.
 */
export function answerFields(schema: Record<string, unknown>): { note: boolean; retractions: boolean; relayedBy: boolean; asked: boolean } {
  const props = schema.properties as Record<string, unknown> | undefined;
  const has = (key: string): boolean => props !== undefined && props !== null && typeof props === "object" && Object.prototype.hasOwnProperty.call(props, key);
  return { note: has("note"), retractions: has("retractions"), relayedBy: has("relayed_by"), asked: has("asked") };
}

/** A note as given, trimmed, or undefined when it is empty. */
const noteOf = (note: string | undefined): string | undefined => {
  const t = note?.trim();
  return t ? t : undefined;
};

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
export function tallyQuorum(
  by: string[],
  quorum: { count: number; roles?: string[] },
  policy: TrustPolicy,
  /** The steward that asked the question (#2749): it never counts toward the answer. */
  steward?: string,
): { counted: string[]; left: { name: string; why: string }[]; met: boolean } {
  const holders = (role: string) => new Set((policy.roles[role] ?? []).map(normalisePrincipal));
  const agents = holders(AGENT_ROLE);
  const asker = steward !== undefined ? normalisePrincipal(steward) : undefined;
  const counted: string[] = [];
  const seen = new Set<string>();
  const left: { name: string; why: string }[] = [];
  for (const name of by) {
    const p = normalisePrincipal(name);
    if (p === "" || seen.has(p)) continue;
    seen.add(p);
    if (asker !== undefined && p === asker) {
      left.push({ name, why: "is the steward that asked" });
      continue;
    }
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
 * A steward waits on a question and never answers or retracts one (#2749), as
 * it never clears a gate: the write has to come from a person, through hud or
 * a shell, not from the steward's own turn or a process it started.
 */
function refuseStewardTurn(id: string, does: "answers" | "retracts"): void {
  const turn = currentStewardTurn();
  if (turn) {
    throw new PointsWriteError(
      "answer-in-steward-turn",
      `this is the steward ${turn.steward}'s turn, and a steward never ${does} a decision point: a person ${does === "answers" ? "answers" : "retracts the answer to"} ${id} through hud or \`chant workspace points ${does === "answers" ? "answer" : "retract"}\` at a shell`,
    );
  }
}

interface FoundQuestion {
  opened: OpenedPoints;
  before: RecordEntry[];
  read: Awaited<ReturnType<typeof readWithLedger>>;
  target: RecordEntry & { data: Record<string, unknown> };
}

/** The answer record with this id, in the answer kind `kind` names or the first declared one that has it, read with the ledger's answers laid over the tree. */
async function findQuestion(cwd: string, kind: string | undefined, id: string): Promise<FoundQuestion> {
  const kinds = await answerKindFiles(cwd, kind);
  if (kinds.length === 0) throw new PointsWriteError("points-undeclared", "no record kind with an answers block is declared: name one with --kind, or declare one in chant.workspace.json");
  for (const k of kinds) {
    const opened = await openAnswers(k, cwd);
    // A question a steward asked is on the ledger (#2786), and people's answer goes back there.
    const read = await readWithLedger(opened.o);
    const target = read.before.find((e) => e.id === id);
    if (target && target.data !== null) return { opened, before: read.before, read, target: target as FoundQuestion["target"] };
  }
  throw new PointsWriteError("record-not-found", `no answer record has id ${id}`);
}

/** Count `by` toward the point's quorum, or refuse with `quorum-not-met`. */
function meetQuorum(name: string, by: string[], quorum: { count: number; roles?: string[] }, root: string, steward: string | undefined, verb: "answer" | "retract"): { counted: string[] } {
  const tally = tallyQuorum(by, quorum, policyFor(root), steward);
  if (!tally.met) {
    const got = tally.counted.length;
    const left = tally.left.length ? `; not counted: ${tally.left.map((l) => `${l.name}, who ${l.why}`).join("; ")}` : "";
    throw new PointsWriteError(
      "quorum-not-met",
      `${name} needs ${quorum.count} ${quorum.count === 1 ? "person" : "people"}${quorum.roles ? ` holding ${quorum.roles.join(" or ")}` : ""} to ${verb === "answer" ? "answer" : "retract an answer"}, and ${got} ${got === 1 ? "counts" : "count"}${got ? ` (${tally.counted.join(", ")})` : ""}${left}`,
    );
  }
  return tally;
}

/**
 * People answer an open question: `points answer`. A proposed question the
 * people answer as the model did is confirmed, and keeps the model as its
 * decider; any other answer is the quorum's, and a model's proposal moves into
 * the escalations. The question becomes `answered`, with the people's note
 * when they give one (#3351).
 */
export async function answerPoint(opts: AnswerPointOptions): Promise<PointsWriteDocument> {
  try {
    return await withWriteLock(opts.cwd, { verb: "points answer", by: (opts.by ?? []).join(", ") || null }, opts.dryRun, () => answerPointLocked(opts));
  } catch (err) {
    return failure("answer", err);
  }
}

async function answerPointLocked(opts: AnswerPointOptions): Promise<PointsWriteDocument> {
  try {
    refuseStewardTurn(opts.id, "answers");
    // #3163: under identity.attribution "identified" at base, each answerer is a forge identity or a signer.
    refuseUnidentified(scopeSource(opts.cwd), opts.by, "--by");
    // #3402: and so is whoever relayed the answer.
    const relayedBy = noteOf(opts.relayedBy);
    if (relayedBy !== undefined) refuseUnidentified(scopeSource(opts.cwd), [relayedBy], "--relayed-by");
    const found = await findQuestion(opts.cwd, opts.kind, opts.id);
    const { opened, before, target } = found;
    const ledger = found.read.ledger;
    const { o } = opened;
    const d = target.data;
    if (target.state === "answered") {
      throw new PointsWriteError("record-closed", `${opts.id} is answered, and an answer never changes in place: retract it with \`points retract ${opts.id}\` and answer again, ask again with other inputs, or change the point, which asks the question anew`);
    }
    const note = noteOf(opts.note);
    if (note !== undefined && !answerFields(o.loaded.schema).note) {
      throw new PointsWriteError("answer-field-unsupported", `the ${o.loaded.kind.name} kind's schema has no note field, so ${opts.id} can't keep the note: copy point-answer.schema.json from @intentius/chant anew`);
    }
    if (relayedBy !== undefined && !answerFields(o.loaded.schema).relayedBy) {
      throw new PointsWriteError("answer-field-unsupported", `the ${o.loaded.kind.name} kind's schema has no relayed_by field, so ${opts.id} can't record who relayed the answer: copy point-answer.schema.json from @intentius/chant anew`);
    }
    const name = String(d.point);
    const point = pointOf(opened.points, name);
    if (!point) throw new PointsWriteError("point-unknown", `${opts.id} answers ${name}, which ${opened.pointsFile} no longer declares`);
    // An ad-hoc question is answered from the candidates it was asked with (#3403).
    const asked = askedOf(d);
    const allowed = asked ? candidates(askedQuestion(point, asked)) : Array.isArray(d.candidates) ? (d.candidates as (string | boolean)[]) : candidates(point.question);
    const type = String(d.question_type);
    const value = type === "noul" && typeof opts.answer === "string" ? ({ true: true, yes: true, false: false, no: false } as Record<string, boolean>)[opts.answer.toLowerCase()] : opts.answer;
    if (value === undefined || !allowed.includes(value)) {
      throw new PointsWriteError("answer-not-candidate", `${opts.id} takes one of ${allowed.map((c) => JSON.stringify(c)).join(", ")}, not ${JSON.stringify(opts.answer)}`);
    }
    const quorum = quorumOf(point);
    const tally = meetQuorum(name, opts.by, quorum, o.root, askedByOf(d)?.steward, "answer");
    const on = opts.on ?? today();
    const decider = d.decider as Record<string, unknown>;
    const confirmed = target.state === "proposed" && decider.kind === "model" && d.answer === value;
    const escalations = Array.isArray(d.escalations) ? [...(d.escalations as Escalation[])] : [];
    let fields: Record<string, unknown>;
    if (confirmed) {
      fields = { ...d, state: "answered", answered_by: tally.counted, answered_on: on, note, relayed_by: relayedBy };
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
          // The model's own reason moves with its proposal (#3345).
          ...(typeof d.reason === "string" && reasonFields(o.loaded.schema).escalation ? { model_reason: d.reason } : {}),
        });
      }
      const rest = Object.fromEntries(Object.entries(d).filter(([k]) => k !== "probabilities" && k !== "confidence" && k !== "threshold" && k !== "reason"));
      fields = {
        ...rest,
        state: "answered",
        answer: value,
        decider: { kind: "quorum", count: quorum.count, ...(quorum.roles ? { roles: quorum.roles } : {}), by: tally.counted },
        escalations: escalations.length > 0 ? escalations : undefined,
        answered_by: tally.counted,
        answered_on: on,
        note,
        relayed_by: relayedBy,
      };
    }
    const subject = Array.isArray(d.constrains) && typeof d.constrains[0] === "string" ? (d.constrains[0] as string) : undefined;
    fields.title = titleFor(point, subject, "answered", value, asked);
    const data = recordData(o, fields);
    const text = renderRecord(data, body(point, String(fields.title), asked));
    const onLedger = ledger.byPath.has(target.path);
    const message = `Decision point ${name}: answered ${show(value, type)} by ${tally.counted.join(", ")}${relayedBy ? `, relayed by ${relayedBy}` : ""}`;
    const wrote = await write(o, before, target.path, text, false, !!opts.dryRun, { source: found.read.source, ledger, onLedger, message, who: { verb: "points answer", by: tally.counted.join(", ") } });
    const entry: RecordEntry = { ...target, state: "answered", data, valid: true, reasons: [], warnings: wrote.warnings };
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
      question: questionView(entry, point, onLedger ? (wrote.ledger ?? ledger.byPath.get(target.path)?.ledger ?? null) : null)!,
      ...(opts.dryRun ? { text } : {}),
    };
  } catch (err) {
    return failure("answer", err);
  }
}

// ── points retract ───────────────────────────────────────────────────────────

export interface RetractAnswerOptions {
  cwd: string;
  /** The answer record's id. */
  id: string;
  /** Who takes the answer back. They count toward the point's quorum as answerers do. */
  by: string[];
  /** Why, recorded on the retraction. */
  note?: string;
  kind?: string;
  on?: string;
  dryRun?: boolean;
}

/**
 * People take an answer back: `points retract` (#3351, ws-084). The answer
 * never changes in place. The question is escalated to the point's quorum
 * again, open for people, and the answer as it was (its value, decider, who
 * gave it, when, and its note) moves into the record's `retractions`, with who
 * retracted it, when and why. A model's confirmed proposal also moves into the
 * escalations, as when people answer otherwise. Retracting needs the point's
 * quorum, counted as an answer is, and is refused in a steward's turn. People
 * answer the question again with `points answer`.
 */
export async function retractAnswer(opts: RetractAnswerOptions): Promise<PointsWriteDocument> {
  try {
    return await withWriteLock(opts.cwd, { verb: "points retract", by: (opts.by ?? []).join(", ") || null }, opts.dryRun, () => retractAnswerLocked(opts));
  } catch (err) {
    return failure("retract", err);
  }
}

async function retractAnswerLocked(opts: RetractAnswerOptions): Promise<PointsWriteDocument> {
  try {
    refuseStewardTurn(opts.id, "retracts");
    refuseUnidentified(scopeSource(opts.cwd), opts.by, "--by");
    const found = await findQuestion(opts.cwd, opts.kind, opts.id);
    const { opened, before, target } = found;
    const ledger = found.read.ledger;
    const { o } = opened;
    const d = target.data;
    if (target.state !== "answered") {
      throw new PointsWriteError("answer-not-answered", `${opts.id} is ${target.state ?? "not answered"}, so there is no answer to retract: answer it with \`points answer ${opts.id}\``);
    }
    if (!answerFields(o.loaded.schema).retractions) {
      throw new PointsWriteError("answer-field-unsupported", `the ${o.loaded.kind.name} kind's schema has no retractions field, so ${opts.id} can't keep the answer it would retract: copy point-answer.schema.json from @intentius/chant anew`);
    }
    const name = String(d.point);
    const point = pointOf(opened.points, name);
    if (!point) throw new PointsWriteError("point-unknown", `${opts.id} answers ${name}, which ${opened.pointsFile} no longer declares, so no quorum can take the answer back: ask the point as it is declared now`);
    const quorum = quorumOf(point);
    const tally = meetQuorum(name, opts.by, quorum, o.root, askedByOf(d)?.steward, "retract");
    const on = opts.on ?? today();
    const type = String(d.question_type);
    const decider = d.decider !== null && typeof d.decider === "object" && !Array.isArray(d.decider) ? (d.decider as Record<string, unknown>) : { kind: "quorum" };
    const answer = d.answer as string | boolean;
    const note = noteOf(opts.note);
    const retraction = {
      answer,
      decider,
      answered_by: Array.isArray(d.answered_by) && d.answered_by.length > 0 ? d.answered_by : undefined,
      answered_on: typeof d.answered_on === "string" ? d.answered_on : undefined,
      answer_note: typeof d.note === "string" ? d.note : undefined,
      answer_relayed_by: typeof d.relayed_by === "string" ? d.relayed_by : undefined,
      by: tally.counted,
      on,
      note,
    };
    const escalations = Array.isArray(d.escalations) ? [...(d.escalations as Escalation[])] : [];
    if (decider.kind === "model") {
      // The confirmed proposal goes back among the deciders that did not settle the question.
      escalations.push({
        kind: "model",
        backend: String(decider.backend),
        model: String(decider.model),
        answer,
        ...(d.probabilities ? { probabilities: d.probabilities as Record<string, number> } : {}),
        ...(typeof d.confidence === "number" ? { confidence: d.confidence } : {}),
        ...(typeof d.threshold === "number" ? { threshold: d.threshold } : {}),
        reason: `proposed ${show(answer, type)}, which people confirmed and then retracted`,
        ...(typeof d.reason === "string" && reasonFields(o.loaded.schema).escalation ? { model_reason: d.reason } : {}),
      });
    }
    const gone = new Set(["answer", "answered_by", "answered_on", "note", "relayed_by", "probabilities", "confidence", "threshold", "reason"]);
    const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !gone.has(k)));
    const prior = Array.isArray(d.retractions) ? (d.retractions as unknown[]) : [];
    const subject = Array.isArray(d.constrains) && typeof d.constrains[0] === "string" ? (d.constrains[0] as string) : undefined;
    const asked = askedOf(d);
    const title = titleFor(point, subject, "escalated", undefined, asked);
    const data = recordData(o, {
      ...rest,
      title,
      state: "escalated",
      decider: { kind: "quorum", count: quorum.count, ...(quorum.roles ? { roles: quorum.roles } : {}) },
      escalations: escalations.length > 0 ? escalations : undefined,
      retractions: [...prior, Object.fromEntries(Object.entries(retraction).filter(([, v]) => v !== undefined))],
    });
    const text = renderRecord(data, body(point, title, asked));
    const onLedger = ledger.byPath.has(target.path);
    const message = `Decision point ${name}: ${show(answer, type)} retracted by ${tally.counted.join(", ")}`;
    const wrote = await write(o, before, target.path, text, false, !!opts.dryRun, { source: found.read.source, ledger, onLedger, message, who: { verb: "points retract", by: tally.counted.join(", ") } });
    const entry: RecordEntry = { ...target, state: "escalated", data, valid: true, reasons: [], warnings: wrote.warnings };
    return {
      $schema: POINTS_WRITE_SCHEMA_ID,
      contract: POINTS_WRITE_CONTRACT_VERSION,
      verb: "retract",
      kind: o.view,
      id: opts.id,
      path: target.path,
      reused: false,
      written: !opts.dryRun,
      dryRun: !!opts.dryRun,
      question: questionView(entry, point, onLedger ? (wrote.ledger ?? ledger.byPath.get(target.path)?.ledger ?? null) : null)!,
      ...(opts.dryRun ? { text } : {}),
    };
  } catch (err) {
    return failure("retract", err);
  }
}
