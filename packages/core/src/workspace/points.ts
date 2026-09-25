/**
 * Decision points (ws-058, #2738): the recurring questions a workspace asks of
 * its own graph, declared as data, and the answers they leave (#2739).
 *
 * A points file is JSON, validated against `decision-points.schema.json`, and
 * named by a record kind's `answers.points`: the kind whose records are the
 * answers. Each point is a typed question (`noul`, `choice` or `score`, the
 * question types of the POST /v1/systemone wire format, #2491), the inputs it
 * reads, each named as a read-contract output, and an ordered chain of
 * deciders:
 *
 *   table   rows of { when, answer }; the first row whose conditions all hold answers.
 *   model   a backend asked the question with the inputs as its state, at a
 *           pinned model id. An answer at or above the threshold is a
 *           proposal a person confirms; below it, the next decider is asked.
 *   quorum  people. Always last: the question escalates to them.
 *
 * chant never calls a model (ws-052). {@link runChain} takes the model call
 * as a function, {@link ModelAsk}, which the decide Op activity (#2740), a
 * runtime's decider or a test's stub supplies. Without one, a model decider is
 * not asked and the chain moves on.
 *
 * Taken from chud's `packages/runtime/src/decide.mjs` at 43afcf1: the chain,
 * the observation rule, the point version and the inputs hash. The records
 * are chant records: `decide.ts` writes them, and {@link applyAnswers} warns
 * about them on read.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, posix, relative, resolve, sep } from "node:path";
import schema from "./decision-points.schema.json";
import type { ReasonCode } from "./reason-codes";
import type { RecordSource } from "./record-source";
import type { LoadedRecordKind, ReadRecordsOptions, RecordEntry } from "./records";

export const DECISION_POINTS_SCHEMA_ID = schema.$id;

// ── The read-contract outputs an input may name ─────────────────────────────

/**
 * The read-contract outputs a point's input may name (#2738), each with the
 * output schema and `$defs` entry that describes it. Closed: an input naming
 * anything else is refused. `record`, `decision` and `work-item` are records
 * as `records --json` lists them, of any kind, a decision kind and a work kind.
 */
export const POINT_INPUT_OUTPUTS = {
  record: { schema: "records", def: "record", description: "a record of any kind, as records --json lists it" },
  decision: { schema: "records", def: "record", description: "a decision record, as records --json lists it" },
  "work-item": { schema: "records", def: "record", description: "a work item record, as records --json lists it (#2683)" },
  finding: { schema: "intent", def: "finding", description: "a finding of graph --intent" },
  region: { schema: "intent", def: "region", description: "the region an intent graph covers" },
  commit: { schema: "intent", def: "commit", description: "a commit in an intent graph's window" },
  member: { schema: "ls", def: "member", description: "a member, as ls lists it" },
  gate: { schema: "status", def: "gate", description: "a gate, as status lists it" },
  release: { schema: "status", def: "release", description: "a release, as status lists it; a release plan's fields until the lifecycle ledger lists plans (#2717)" },
  environment: { schema: "status", def: "environment", description: "an environment, as status lists it" },
  component: { schema: "composites", def: "component", description: "a component, as graph --composites lists it" },
} as const;
export type PointInputOutput = keyof typeof POINT_INPUT_OUTPUTS;
export const POINT_INPUT_OUTPUT_NAMES = Object.keys(POINT_INPUT_OUTPUTS) as PointInputOutput[];

/** The output an input name reads: the part before its first dot. */
export function inputOutput(name: string): string {
  const dot = name.indexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
}

// ── The declaration ──────────────────────────────────────────────────────────

export type QuestionType = "noul" | "choice" | "score";

export interface Question {
  /** `boolean` in a points file is read as `noul`. */
  type: QuestionType;
  instructions: string;
  criteria: Record<string, string> | string[];
}

export type Scalar = string | number | boolean | null;
export type Condition = Scalar | { eq?: Scalar; ne?: Scalar; lt?: number; lte?: number; gt?: number; gte?: number; in?: Scalar[] };

export interface TableRow {
  when: Record<string, Condition>;
  answer: string | boolean;
  note?: string;
}

export type Decider =
  | { kind: "table"; rows: TableRow[]; note?: string }
  | { kind: "model"; backend: string; model: string; threshold: number; unreachable?: "escalate" | "fail"; note?: string }
  | { kind: "quorum"; count: number; roles?: string[]; note?: string };

export interface Point {
  title: string;
  question: Question;
  inputs: Record<string, string>;
  deciders: Decider[];
}

/** One problem with a points file: the JSON path of the field, or null for the file, and what is wrong. */
export interface PointProblem {
  field: string | null;
  message: string;
}

export class PointsError extends Error {
  constructor(
    readonly file: string,
    readonly problems: PointProblem[],
  ) {
    super(`${file}: ${problems.map((p) => (p.field ? `${p.field} ${p.message}` : p.message)).join("; ")}`);
    this.name = "PointsError";
  }
}

/** A question's candidate answers: true and false, a choice's options, or a score's levels. */
export function candidates(question: Question): (string | boolean)[] {
  if (question.type === "noul") return [true, false];
  if (question.type === "choice") return Object.keys(question.criteria);
  return [...(question.criteria as string[])];
}

const ONLY: Record<Decider["kind"], string[]> = { table: ["rows"], model: ["backend", "model", "threshold", "unreachable"], quorum: ["count", "roles"] };

/** A model id that names an alias rather than a release, such as jev-latest or jev-preview (#2491). */
const ALIAS = /(^|[-_./])(latest|preview|stable|current)$/i;

/** What the schema cannot say about the points (chud's pointProblems, and the input and chain rules of #2738). */
function pointProblems(points: Record<string, Point>): PointProblem[] {
  const problems: PointProblem[] = [];
  for (const [name, point] of Object.entries(points)) {
    const at = (...path: (string | number)[]) => ["points", name, ...path].join(".");
    const inputs = Object.keys(point.inputs);
    for (const input of inputs) {
      const output = inputOutput(input);
      if (!(POINT_INPUT_OUTPUT_NAMES as string[]).includes(output)) {
        problems.push({
          field: at("inputs", input),
          message: `names ${JSON.stringify(output)}, which is not a read-contract output; an input is one of ${POINT_INPUT_OUTPUT_NAMES.join(", ")}, optionally with dotted field names`,
        });
      }
    }
    const allowed = candidates(point.question);
    const last = point.deciders.length - 1;
    point.deciders.forEach((d, i) => {
      const raw = d as unknown as Record<string, unknown>;
      for (const [kind, fields] of Object.entries(ONLY)) {
        if (kind === d.kind) continue;
        for (const field of fields) {
          if (raw[field] !== undefined && !ONLY[d.kind].includes(field)) problems.push({ field: at("deciders", i, field), message: `is only for a ${kind} decider, and this one is a ${d.kind}` });
        }
      }
      if (d.kind === "quorum" && i !== last) problems.push({ field: at("deciders", i), message: "is a quorum, and a quorum is the last decider: nobody is asked after people" });
      if (d.kind === "model" && ALIAS.test(d.model)) {
        problems.push({ field: at("deciders", i, "model"), message: `${JSON.stringify(d.model)} is an alias, and an alias moves when a new release ships: pin a versioned model id` });
      }
      if (d.kind === "table") {
        d.rows.forEach((row, r) => {
          if (!allowed.includes(row.answer)) {
            problems.push({ field: at("deciders", i, "rows", r, "answer"), message: `must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}, not ${JSON.stringify(row.answer)}` });
          }
          for (const key of Object.keys(row.when)) {
            if (!inputs.includes(key)) problems.push({ field: at("deciders", i, "rows", r, "when", key), message: `is not one of this point's inputs (${inputs.join(", ")})` });
          }
        });
      }
    });
    if (point.deciders[last]?.kind !== "quorum") {
      problems.push({ field: at("deciders"), message: "must end in a quorum: when no table row or model answers, people do" });
    }
  }
  return problems;
}

interface AjvError {
  instancePath: string;
  keyword: string;
  message?: string;
  params: Record<string, unknown>;
}
type Validate = ((data: unknown) => boolean) & { errors?: AjvError[] | null };

let compiled: Validate | undefined;
function validator(): Validate {
  if (compiled) return compiled;
  const require = createRequire(import.meta.url);
  // ajv is CommonJS; its class is the default export, or that export's own default.
  const mod = require("ajv/dist/2020") as { default?: unknown };
  const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): Validate };
  compiled = new Ajv({ allErrors: true, strict: false }).compile(schema);
  return compiled;
}

const SUMMARY = new Set(["if", "then", "else", "oneOf", "anyOf", "allOf"]);

/** The schema's problems with `data`, as JSON paths. */
export function schemaProblems(data: unknown): PointProblem[] {
  const validate = validator();
  if (validate(data)) return [];
  const seen = new Set<string>();
  const out: PointProblem[] = [];
  for (const e of validate.errors ?? []) {
    if (SUMMARY.has(e.keyword)) continue;
    const path = e.instancePath.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    const field = path.length ? path.join(".") : null;
    const message =
      e.keyword === "additionalProperties"
        ? `has an unknown field ${JSON.stringify(e.params.additionalProperty)}; only fields named x-... may be added`
        : e.keyword === "required"
          ? `is missing ${JSON.stringify(e.params.missingProperty)}`
          : e.keyword === "propertyNames"
            ? `has a name that is not allowed: ${JSON.stringify(e.params.propertyName)}`
            : (e.message ?? "is invalid");
    const key = `${field}\0${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ field, message });
  }
  return out;
}

/** `boolean` read as `noul`. The declaration is otherwise kept as written. */
function normalise(points: Record<string, Point>): Record<string, Point> {
  const out: Record<string, Point> = {};
  for (const [name, p] of Object.entries(points)) {
    const type = (p.question.type as string) === "boolean" ? "noul" : p.question.type;
    out[name] = { ...p, question: { ...p.question, type } };
  }
  return out;
}

/**
 * Parse and validate a points file's text. Returns its points, with
 * `boolean` read as `noul`. Throws a {@link PointsError} naming the file and
 * each field.
 */
export function parsePoints(text: string, file: string): Record<string, Point> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new PointsError(file, [{ field: null, message: `is not JSON: ${err instanceof Error ? err.message : String(err)}` }]);
  }
  const problems = schemaProblems(data);
  if (problems.length > 0) throw new PointsError(file, problems);
  const points = normalise((data as { points: Record<string, Point> }).points);
  const more = pointProblems(points);
  if (more.length > 0) throw new PointsError(file, more);
  return points;
}

/** One point by name, or undefined. */
export function pointOf(points: Record<string, Point>, name: string): Point | undefined {
  return Object.prototype.hasOwnProperty.call(points, name) ? points[name] : undefined;
}

/** JSON with keys sorted and undefined members left out, the text every hash here is taken over. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The version of a point: the sha256 of its declaration. Editing the question or any decider changes it. */
export const pointVersion = (point: Point): string => sha256(canonical(point));

/** What is answered once: the point, its version and the inputs. */
export const inputsHash = (name: string, version: string, inputs: Record<string, unknown>): string => sha256(canonical({ point: name, version, inputs }));

/** The id of the answer to `name` for inputs hashing to `hash`: the name and the hash's first 12 hex digits. */
export const answerId = (name: string, hash: string): string => `${name}-${hash.slice(0, 12)}`;

/** The quorum a point ends in. */
export function quorumOf(point: Point): { count: number; roles?: string[] } {
  const last = point.deciders[point.deciders.length - 1];
  return last?.kind === "quorum" ? { count: last.count, ...(last.roles ? { roles: last.roles } : {}) } : { count: 1 };
}

// ── The chain ────────────────────────────────────────────────────────────────

function holds(condition: Condition, value: unknown): boolean {
  if (condition === null || typeof condition !== "object") return value === condition;
  const [[op, x]] = Object.entries(condition) as [string, unknown][];
  const number = typeof value === "number";
  switch (op) {
    case "eq":
      return value === x;
    case "ne":
      return value !== x;
    case "lt":
      return number && value < (x as number);
    case "lte":
      return number && value <= (x as number);
    case "gt":
      return number && value > (x as number);
    case "gte":
      return number && value >= (x as number);
    case "in":
      return (x as unknown[]).includes(value);
    default:
      return false;
  }
}

/** Whether every condition in a row's `when` holds for these inputs. An input the state lacks never matches. */
export const matches = (when: Record<string, Condition>, inputs: Record<string, unknown>): boolean =>
  Object.entries(when).every(([key, condition]) => Object.prototype.hasOwnProperty.call(inputs, key) && holds(condition, inputs[key]));

/** A question as the POST /v1/systemone wire format asks it (#2491). */
export interface WireQuestion {
  type: QuestionType;
  instructions: string;
  criteria: Record<string, string> | string[];
}

/** One answer in the wire format's shape. */
export type WireAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "score"; score?: number; legend?: unknown; probabilities?: Record<string, number>; confidence?: number }
  | { type: "unsupported" };

export function wireQuestion(question: Question): WireQuestion {
  return { type: question.type, instructions: question.instructions, criteria: question.criteria };
}

/** What a model decider is asked. */
export interface ModelRequest {
  point: string;
  backend: string;
  /** The pinned model id. */
  model: string;
  question: WireQuestion;
  /** The inputs, as the state. */
  state: Record<string, unknown>;
}

/**
 * The model call, supplied by the caller: the decide Op activity (#2740), a
 * runtime's decider, or a test's stub. It resolves with the model id that
 * answered and one answer in the wire format's shape. Throwing means the
 * backend could not be reached or gave nothing usable.
 */
export type ModelAsk = (request: ModelRequest) => Promise<{ model: string; answer: WireAnswer }>;

const round = (x: number): number => Math.round(x * 1e6) / 1e6;

export type Observation =
  | { observed: true; answer: string | boolean; probabilities: Record<string, number>; confidence: number }
  | { observed: false; answer?: string | boolean | null; probabilities?: Record<string, number>; confidence?: number; reason: string };

/**
 * A model's wire answer against the question and the decider's threshold
 * (chud's rule):
 *
 * - noul p: true when p is at least the threshold, false when 1 - p is,
 *   otherwise not observed. Its confidence is max(p, 1 - p).
 * - choice and score: the choice (a score's most probable level) when the
 *   reported confidence is at least the threshold. A backend that reports no
 *   confidence is read by its largest probability.
 *
 * An answer outside the candidates, or an unsupported question, is not observed.
 */
export function observe(question: Question, answer: WireAnswer | undefined, threshold: number): Observation {
  const allowed = candidates(question);
  if (!answer || answer.type === "unsupported") return { observed: false, reason: "the backend does not support this question type" };
  if (question.type === "noul") {
    const p = Number((answer as { noul?: unknown }).noul);
    if (!(p >= 0 && p <= 1)) return { observed: false, reason: "the answer carries no probability" };
    const probabilities = { true: round(p), false: round(1 - p) };
    const confidence = round(Math.max(p, 1 - p));
    if (p >= threshold) return { observed: true, answer: true, probabilities, confidence };
    if (1 - p >= threshold) return { observed: true, answer: false, probabilities, confidence };
    return { observed: false, answer: p >= 0.5, probabilities, confidence, reason: `confidence ${confidence} is below the threshold ${threshold}` };
  }
  const a = answer as { choice?: unknown; probabilities?: Record<string, unknown>; confidence?: unknown };
  const probabilities = Object.fromEntries(
    Object.entries(a.probabilities ?? {})
      .map(([k, v]) => [k, Number(v)] as const)
      .filter(([, v]) => Number.isFinite(v) && v >= 0 && v <= 1)
      .map(([k, v]) => [k, round(v)]),
  );
  const choice = question.type === "choice" ? a.choice : Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]?.[0];
  const reported = Number(a.confidence);
  const confidence = round(a.confidence !== undefined && Number.isFinite(reported) ? reported : Math.max(0, ...Object.values(probabilities)));
  if (typeof choice !== "string" || !allowed.includes(choice)) {
    return { observed: false, answer: typeof choice === "string" ? choice : null, probabilities, confidence, reason: `the answer ${JSON.stringify(choice ?? null)} is not a candidate` };
  }
  if (confidence >= threshold) return { observed: true, answer: choice, probabilities, confidence };
  return { observed: false, answer: choice, probabilities, confidence, reason: `confidence ${confidence} is below the threshold ${threshold}` };
}

/** A decider that was asked and did not answer, and why. */
export interface Escalation {
  kind: "table" | "model";
  reason: string;
  backend?: string;
  model?: string;
  answer?: string | boolean | null;
  probabilities?: Record<string, number>;
  confidence?: number;
  threshold?: number;
}

export type ChainResult =
  | { status: "answered"; answer: string | boolean; decider: { kind: "table"; row: number }; note?: string; escalations: Escalation[] }
  | {
      status: "proposed";
      answer: string | boolean;
      decider: { kind: "model"; backend: string; model: string };
      probabilities: Record<string, number>;
      confidence: number;
      threshold: number;
      escalations: Escalation[];
    }
  | { status: "escalated"; decider: { kind: "quorum"; count: number; roles?: string[] }; escalations: Escalation[] };

/** A model decider declared `unreachable: "fail"` could not answer, so the ask fails and nothing is written. */
export class DeciderFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeciderFailed";
  }
}

/**
 * Ask a point's deciders in order. A table row answers; a model at or above
 * its threshold proposes; otherwise the question escalates to the quorum.
 * Each decider that did not answer is in `escalations`, with why. A model
 * decider is asked through `ask`; without it, it is not asked.
 */
export async function runChain(name: string, point: Point, inputs: Record<string, unknown>, ask?: ModelAsk): Promise<ChainResult> {
  const escalations: Escalation[] = [];
  for (const d of point.deciders) {
    if (d.kind === "table") {
      const row = d.rows.findIndex((r) => matches(r.when, inputs));
      if (row >= 0) {
        return { status: "answered", answer: d.rows[row].answer, decider: { kind: "table", row }, ...(d.rows[row].note ? { note: d.rows[row].note } : {}), escalations };
      }
      escalations.push({ kind: "table", reason: "no row matches these inputs" });
    } else if (d.kind === "model") {
      if (!ask) {
        escalations.push({ kind: "model", backend: d.backend, model: d.model, threshold: d.threshold, reason: "not asked: no model backend was given to this ask" });
        continue;
      }
      let reply: { model: string; answer: WireAnswer };
      try {
        reply = await ask({ point: name, backend: d.backend, model: d.model, question: wireQuestion(point.question), state: inputs });
      } catch (err) {
        const why = `${d.backend} could not answer: ${err instanceof Error ? err.message : String(err)}`;
        if (d.unreachable === "fail") throw new DeciderFailed(`${name}: ${why}, and the point fails closed (unreachable: "fail")`);
        escalations.push({ kind: "model", backend: d.backend, model: d.model, threshold: d.threshold, reason: `not observed: ${why}` });
        continue;
      }
      if (reply.model !== d.model) {
        escalations.push({ kind: "model", backend: d.backend, model: reply.model, threshold: d.threshold, reason: `not observed: ${reply.model} answered, and the point pins ${d.model}` });
        continue;
      }
      const seen = observe(point.question, reply.answer, d.threshold);
      if (seen.observed) {
        return {
          status: "proposed",
          answer: seen.answer,
          decider: { kind: "model", backend: d.backend, model: reply.model },
          probabilities: seen.probabilities,
          confidence: seen.confidence,
          threshold: d.threshold,
          escalations,
        };
      }
      escalations.push({
        kind: "model",
        backend: d.backend,
        model: reply.model,
        answer: seen.answer ?? null,
        ...(seen.probabilities ? { probabilities: seen.probabilities } : {}),
        ...(seen.confidence !== undefined ? { confidence: seen.confidence } : {}),
        threshold: d.threshold,
        reason: `not observed: ${seen.reason}`,
      });
    } else {
      return { status: "escalated", decider: { kind: "quorum", count: d.count, ...(d.roles ? { roles: d.roles } : {}) }, escalations };
    }
  }
  // Unreachable for a valid point, which ends in a quorum.
  return { status: "escalated", decider: { kind: "quorum", count: 1 }, escalations };
}

// ── Answers on read ──────────────────────────────────────────────────────────

/** Why an answer record carries a warning. Closed, like the record warning codes. */
export const ANSWER_WARNING_CODES = [
  /** The points file the answer kind names can't be read, or is not valid (#2738). */
  "answer-points-unreadable",
  /** The answer's point is not in the points file. */
  "answer-point-unknown",
  /** The point's declaration changed since the answer: it answers an older version of the question. */
  "answer-point-changed",
] as const satisfies readonly ReasonCode[];
export type AnswerWarningCode = (typeof ANSWER_WARNING_CODES)[number];

/** The points file an answer kind names, from `root` with / separators. */
export function pointsFileOf(loaded: LoadedRecordKind, root: string): string {
  const abs = resolve(dirname(loaded.file), loaded.kind.answers!.points);
  return relative(root, abs).split(sep).join(posix.sep);
}

/** The points an answer kind names, read from `source` (the tree read), or the problems reading them. */
export function readPointsThrough(source: RecordSource, file: string): { points: Record<string, Point> } | { error: string; problems: PointProblem[] } {
  // A revision's source reads only files in a directory it has listed.
  const names = source.list(posix.dirname(file));
  if (!names?.includes(posix.basename(file))) {
    return { error: `the points file ${file} does not exist${source.label}`, problems: [{ field: null, message: `does not exist${source.label}` }] };
  }
  let text: string;
  try {
    text = source.read(file);
  } catch (err) {
    return { error: `the points file ${file} can't be read: ${err instanceof Error ? err.message : String(err)}`, problems: [{ field: null, message: "can't be read" }] };
  }
  try {
    return { points: parsePoints(text, file) };
  } catch (err) {
    if (err instanceof PointsError) return { error: `the points file is not valid: ${err.message}`, problems: err.problems };
    throw err;
  }
}

/**
 * Give an answer kind's records their warnings, in place: the points file
 * can't be read, the answer's point is gone, or the point changed since. They
 * never make a record invalid.
 */
export function applyAnswers(loaded: LoadedRecordKind, entries: RecordEntry[], options: ReadRecordsOptions): void {
  const file = pointsFileOf(loaded, options.root);
  const read = readPointsThrough(options.source, file);
  for (const e of entries) {
    if (e.data === null) continue;
    if ("error" in read) {
      e.warnings.push({ code: "answer-points-unreadable", message: read.error });
      continue;
    }
    const name = e.data.point;
    if (typeof name !== "string") continue;
    const point = pointOf(read.points, name);
    if (!point) {
      e.warnings.push({ code: "answer-point-unknown", message: `answers ${name}, which ${file} does not declare` });
      continue;
    }
    if (typeof e.data.point_version === "string" && e.data.point_version !== pointVersion(point)) {
      e.warnings.push({ code: "answer-point-changed", message: `answers ${name} as it was declared at ${e.data.point_version.slice(0, 12)}, and ${file} declares it at ${pointVersion(point).slice(0, 12)} now: ask again for the question as it stands` });
    }
  }
}
