/**
 * `chant workspace points [--open] [--kind <kind file>] [--at <rev>] [--json]`
 * (ws-058, #2739): the workspace's decision points and the questions asked of
 * them, a read-contract output (`points.schema.json`).
 *
 * The points come from each record kind the declaration names with an
 * `answers` block, or from `--kind`, and the questions are that kind's
 * records. A question is open while it is escalated to people or proposed by a
 * model and not yet confirmed, and it lists any model's answer with its
 * confidence, so a reader such as hud can prompt a person and an MCP client
 * can see it. With `--open`, only open questions are listed. It never writes
 * and never calls a model.
 *
 * `points ask` and `points answer` are the writes, in `decide.ts`.
 */

import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { declaredRecordKinds, readDeclaration, readerVersion, WorkspaceReadError, type ErrorLocation, type WorkspaceErrorCode } from "./declaration";
import { declaredKindFile } from "./declared-kinds";
import { answerPoint, askPoint, questionView, POINTS_WRITE_CONTRACT_VERSION, POINTS_WRITE_SCHEMA_ID, type PointsWriteDocument, type QuestionView } from "./decide";
import { candidates, inputOutput, pointsFileOf, pointVersion, quorumOf, readPointsThrough, type Decider, type ModelAsk, type WireAnswer } from "./points";
import type { ReasonCode } from "./reason-codes";
import { gitRevisionSource, workingTreeSource } from "./record-source";
import { readLedgerAnswers, withLedgerAnswers, type LedgerAnswers } from "./answers-ledger";
import { loadRecordKind, RecordReadError, type ReadErrorCode } from "./records";
import { readRecordsFor } from "./records-cli";
import { locateWorkspace } from "./which-chant";

export const POINTS_CONTRACT_VERSION = 1;
export const POINTS_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/points/v1/points.schema.json";

/** Why `points` read nothing. Closed. */
export const POINTS_ERROR_CODES = [
  "declaration-missing",
  "declaration-ambiguous",
  "declaration-unparseable",
  "declaration-invalid",
  "placement-invalid",
  "reader-too-old",
  "root-chant-required",
  "not-a-git-repository",
  "revision-unknown",
] as const satisfies readonly ReasonCode[];

/** Why one answer kind's points or questions could not be read. The document is still printed. Closed. */
export const POINTS_SOURCE_REASON_CODES = [
  "kind-unreadable",
  "kind-invalid",
  "schema-unreadable",
  "schema-id-mismatch",
  "schema-invalid",
  "location-missing",
  /** The points file the kind names can't be read, or is not valid. */
  "points-invalid",
] as const satisfies readonly ReasonCode[];
type SourceReasonCode = (typeof POINTS_SOURCE_REASON_CODES)[number];

/** One point as `points` lists it. */
export interface PointView {
  name: string;
  title: string;
  /** The answer kind file, from the workspace root, whose records answer it. */
  kind: string;
  /** The points file, from the repository root. */
  file: string;
  /** sha256 of the declaration: a question asked under another version answers an older question. */
  version: string;
  questionType: string;
  instructions: string;
  candidates: (string | boolean)[];
  /** What each candidate means, as the points file declares it: an object of strings for noul and choice, an array for score. */
  criteria: Record<string, string> | string[];
  /** Each input: its name, the read-contract output it names, and its description. */
  inputs: { name: string; output: string; description: string }[];
  deciders: Decider[];
  quorum: { count: number; roles?: string[] };
}

/** One answer kind the read covered. */
export interface SourceView {
  /** The kind file, as declared from the workspace root, or as given with --kind. */
  kind: string;
  /** The points file from the repository root, or null when the kind couldn't be loaded. */
  points: string | null;
  reason: { code: SourceReasonCode; message: string } | null;
}

export type PointsDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      at: string | null;
      workspace: { name: string; root: string };
      /** Whether only open questions are listed (--open). */
      open: boolean;
      sources: SourceView[];
      points: PointView[];
      questions: QuestionView[];
      summary: { points: number; questions: number; open: number; escalated: number; proposed: number; answered: number };
    }
  | { $schema: string; contract: number; chant: string; error: { code: WorkspaceErrorCode; message: string; location: ErrorLocation | null } };

export interface PointsQuery {
  cwd: string;
  at?: string;
  open?: boolean;
  /** One answer kind file, in place of the declared ones. */
  kind?: string;
}

/** Read the points and questions. Never throws a read error: a declaration that can't be read is the failure document. */
export async function workspacePoints(query: PointsQuery): Promise<PointsDocument> {
  const head = { $schema: POINTS_OUTPUT_SCHEMA_ID, contract: POINTS_CONTRACT_VERSION, chant: readerVersion() };
  let located;
  let declaration;
  try {
    located = locateWorkspace(query.cwd, query.at);
    declaration = readDeclaration(located.tree);
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    return { ...head, error: { code: err.code, message: err.message, location: err.location ?? null } };
  }
  const kinds =
    query.kind !== undefined
      ? [{ shown: query.kind, file: resolve(query.cwd, query.kind), given: true }]
      : declaredRecordKinds(declaration).map((d) => ({ shown: d.path, file: declaredKindFile(d, located.rootOnDisk), given: false }));

  const sources: SourceView[] = [];
  const points: PointView[] = [];
  const questions: QuestionView[] = [];
  for (const k of kinds) {
    try {
      const loaded = await loadRecordKind(k.file);
      if (!loaded.kind.answers) {
        if (k.given) sources.push({ kind: k.shown, points: null, reason: { code: "kind-invalid", message: `the ${loaded.kind.name} kind has no answers block, so it holds no answers to decision points` } });
        continue;
      }
      // Without --at, the questions a steward keeps on the lifecycle ledger are read too (#2786).
      let ledger = undefined as LedgerAnswers | undefined;
      const read = await readRecordsFor({
        kind: k.file,
        cwd: query.cwd,
        at: query.at,
        overlay: async (base, { loaded: l, root }) => {
          ledger = await readLedgerAnswers({ file: l.file, name: l.kind.name, dirRel: relative(root, l.dir).split(sep).join("/") || "." });
          return withLedgerAnswers(base, ledger);
        },
      });
      const source = read.at !== null && read.top ? gitRevisionSource(read.top, read.at) : workingTreeSource(read.root);
      const file = pointsFileOf(read.loaded, read.root);
      const parsed = readPointsThrough(source, file);
      const declared = "points" in parsed ? parsed.points : {};
      sources.push({ kind: k.shown, points: file, reason: "error" in parsed ? { code: "points-invalid", message: parsed.error } : null });
      for (const [name, p] of Object.entries(declared)) {
        points.push({
          name,
          title: p.title,
          kind: k.shown,
          file,
          version: pointVersion(p),
          questionType: p.question.type,
          instructions: p.question.instructions,
          candidates: candidates(p.question),
          criteria: p.question.criteria,
          inputs: Object.entries(p.inputs).map(([n, description]) => ({ name: n, output: inputOutput(n), description })),
          deciders: p.deciders,
          quorum: quorumOf(p),
        });
      }
      for (const e of read.result.records) {
        const view = questionView(e, typeof e.data?.point === "string" ? declared[e.data.point] : undefined, ledger?.byPath.get(e.path)?.ledger ?? null);
        if (view && (!query.open || view.open)) questions.push(view);
      }
    } catch (err) {
      if (!(err instanceof RecordReadError)) throw err;
      sources.push({ kind: k.shown, points: null, reason: { code: err.code as Exclude<ReadErrorCode, "not-a-git-repository" | "revision-unknown">, message: err.message } });
    }
  }
  const count = (s: string) => questions.filter((q) => q.state === s).length;
  return {
    ...head,
    at: located.at,
    workspace: { name: declaration.name, root: located.root },
    open: !!query.open,
    sources,
    points,
    questions,
    summary: { points: points.length, questions: questions.length, open: questions.filter((q) => q.open).length, escalated: count("escalated"), proposed: count("proposed"), answered: count("answered") },
  };
}

/** The document as lines for a person. */
export function formatPoints(doc: Extract<PointsDocument, { points: unknown }>): string {
  const lines: string[] = [];
  for (const s of doc.sources) if (s.reason) lines.push(`${s.kind}: ${s.reason.code}: ${s.reason.message}`);
  for (const p of doc.points) lines.push(`${p.name}  ${p.questionType}  ${p.title}  (${p.deciders.map((d) => d.kind).join(", ")})`);
  if (doc.points.length === 0) lines.push("no decision points are declared");
  lines.push("");
  for (const q of doc.questions) {
    const model = q.model && q.state !== "answered" ? `  model ${JSON.stringify(q.model.answer)} at ${q.model.confidence ?? "?"}${q.model.observed ? "" : `, below ${q.model.threshold ?? "?"}`}` : "";
    lines.push(`${q.id}  ${q.state}  ${q.title}${model}`);
  }
  const n = doc.summary.questions;
  lines.push(doc.open ? `${n} open ${n === 1 ? "question" : "questions"}` : `${n} ${n === 1 ? "question" : "questions"}, ${doc.summary.open} open`);
  return lines.join("\n");
}

/** A POST /v1/systemone response the caller already has, as the model call: its answer to the point asked. */
export function responseAsk(response: unknown): ModelAsk {
  return async (request) => {
    const r = response as { model?: unknown; answers?: Record<string, unknown> } | null;
    if (r === null || typeof r !== "object") throw new Error("the response is not a JSON object");
    if (typeof r.model !== "string" || r.model === "") throw new Error("the response names no model");
    const answer = r.answers?.[request.point];
    if (answer === null || typeof answer !== "object") throw new Error(`the response has no answer for ${request.point}`);
    return { model: r.model, answer: answer as WireAnswer };
  };
}

const USAGE = [
  "chant workspace points [--open] [--kind <kind file>] [--at <rev>] [--json]",
  "chant workspace points ask <point> --inputs <file|-> [--response <file>] [--subject <id>] [--kind <kind file>] [--dry-run]",
  "chant workspace points answer <id> --answer <value> --by <name> [--by <name>...] [--kind <kind file>] [--dry-run]",
].join("\n");

function usage(verb: "ask" | "answer", message: string): PointsWriteDocument {
  return { $schema: POINTS_WRITE_SCHEMA_ID, contract: POINTS_WRITE_CONTRACT_VERSION, verb, error: { code: "write-usage-invalid", message } };
}

function readJson(verb: "ask" | "answer", flag: string, value: string, cwd: string): { value: unknown } | PointsWriteDocument {
  let text: string;
  try {
    text = readFileSync(value === "-" ? 0 : resolve(cwd, value), "utf-8");
  } catch (err) {
    return { $schema: POINTS_WRITE_SCHEMA_ID, contract: POINTS_WRITE_CONTRACT_VERSION, verb, error: { code: "write-input-invalid", message: `${flag} ${value} could not be read: ${err instanceof Error ? err.message : String(err)}` } };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { $schema: POINTS_WRITE_SCHEMA_ID, contract: POINTS_WRITE_CONTRACT_VERSION, verb, error: { code: "write-input-invalid", message: `${flag} ${value} is not JSON: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

/** `chant workspace points`, and its `ask` and `answer` verbs. */
export async function runWorkspacePoints(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = process.cwd();
  const print = (doc: object): number => {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  };
  const verb = args.extraPositional;
  if (verb === "ask") {
    const point = args.extraPositional2;
    if (!point) return print(usage("ask", "ask needs the point's name"));
    if (args.inputs === undefined) return print(usage("ask", "--inputs <file|-> is required"));
    const inputs = readJson("ask", "--inputs", args.inputs, cwd);
    if (!("value" in inputs)) return print(inputs);
    let ask: ModelAsk | undefined;
    if (args.response !== undefined) {
      const response = readJson("ask", "--response", args.response, cwd);
      if (!("value" in response)) return print(response);
      ask = responseAsk(response.value);
    }
    return print(await askPoint({ cwd, point, inputs: inputs.value, subject: args.subject, kind: args.kind, ask, dryRun: args.dryRun }));
  }
  if (verb === "answer") {
    const id = args.extraPositional2;
    if (!id) return print(usage("answer", "answer needs the question's id"));
    if (args.answer === undefined) return print(usage("answer", "--answer <value> is required"));
    if (!args.bys || args.bys.length === 0) return print(usage("answer", "--by <name> is required, once for each person who answered"));
    return print(await answerPoint({ cwd, id, answer: args.answer, by: args.bys, kind: args.kind, dryRun: args.dryRun }));
  }
  if (verb !== undefined) {
    console.error(formatError({ message: `chant workspace points takes no argument but ask or answer (got ${verb})`, hint: USAGE }));
    return 1;
  }
  const doc = await workspacePoints({ cwd, at: args.at, open: args.open, kind: args.kind });
  if (args.json) console.log(JSON.stringify(doc, null, 2));
  else if ("error" in doc) console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
  else console.log(formatPoints(doc));
  return "error" in doc ? 1 : 0;
}
