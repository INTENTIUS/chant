/**
 * `chant workspace graph --intent <path[:start-end]> [--at <rev>] [--kind <kind file>...] [--json]`
 * (#2651): the intent graph over one region (`intent.ts`), printed as JSON
 * with `--json` or as a walk, one line per node, in the order of #2650
 * section B: the region, its decisions, their artifacts, the commits, and the
 * findings. Under each decision come the commits made inside its window, and
 * when any of them is not the decision's own work, the question #2650 B puts
 * to the person about it (#2656). Without `--kind`, the walk reads every
 * record kind the declaration names (#2680).
 */

import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { intentRecord, type IntentRecordDocument } from "./intent-record";
import { intentGraph, type ArtifactNode, type CommitNode, type DecisionNode, type IntentDocument, type IntentEdge, type IntentNode, type WorkNode } from "./intent";

const USAGE = "chant workspace graph --intent <path[:start-end]> [--at <rev>] [--kind <kind file>...] [--json]";
const RECORD_USAGE = "chant workspace graph --intent --record <id> [--at <rev>] [--kind <kind file>...] [--json]";

type Result = Exclude<IntentDocument, { error: unknown }>;
type RecordResult = Exclude<IntentRecordDocument, { error: unknown }>;

function edgesFrom(doc: Result, from: string, kind: IntentEdge["kind"]): IntentEdge[] {
  return doc.edges.filter((e) => e.from === from && e.kind === kind);
}

function ofKind<K extends IntentNode["kind"]>(doc: Result, kind: K): Extract<IntentNode, { kind: K }>[] {
  return doc.nodes.filter((n): n is Extract<IntentNode, { kind: K }> => n.kind === kind);
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : "none");

/** What the walk asks about a commit made inside a decision's window that is not the decision's own work (#2650 B4, step 5). */
export const IN_WINDOW_QUESTION = "is this drift, a superseding decision nobody wrote down, or the decision being wrong?";

/** The commits inside a decision's window, under its line, then the question once when any is not its own work. */
function withinLines(doc: Result, d: DecisionNode): string[] {
  const within = doc.edges.filter((e): e is Extract<IntentEdge, { kind: "within" }> => e.kind === "within" && e.to === d.id);
  const out: string[] = [];
  for (const e of within) {
    const c = doc.nodes.find((n): n is CommitNode => n.kind === "commit" && n.id === e.from);
    if (!c) continue;
    const unit = edgesFrom(doc, c.id, "produced-by")
      .map((p) => doc.nodes.find((n) => n.id === p.to))
      .map((n) => (n && "ref" in n ? n.ref : undefined))
      .filter(Boolean);
    const by = unit.length > 0 ? `unit ${unit.join(", ")}` : "no unit";
    const label = e.state === "decided" ? "decided " : "within  ";
    out.push(`  ${label}  ${short(c.sha)} ${c.subject}; ${by}${e.state === "decided" ? `, ${d.record}'s own work` : `, in ${d.record}'s window and not its work`}`);
  }
  if (within.some((e) => e.state === "decided-by-window")) out.push(`  ask       ${IN_WINDOW_QUESTION}`);
  return out;
}

function decisionLine(d: DecisionNode): string {
  const via = d.constrains.length > 0 ? d.constrains.map((c) => `${c.entry} (${c.granularity})`).join(", ") : "through supersession only";
  const by = d.decided_by ? `, decided by ${d.decided_by}${d.decided_on ? ` on ${d.decided_on}` : ""}` : "";
  const decidedIn = d.decidedIn ? ` in ${short(d.decidedIn.sha)}` : "";
  const reviews = `${d.reviews.agree} agree, ${d.reviews.dissent} dissent, ${d.reviews.abstain} abstain`;
  const superseded = d.supersededBy ? `, superseded by ${d.supersededBy}` : "";
  return `decision  ${d.record} ${d.state ?? "stateless"}${superseded}: ${d.title ?? d.path}; constrains ${via}${by}${decidedIn}; ${reviews}; ${d.provenance.level}${d.valid ? "" : `; invalid: ${d.reasons.map((r) => r.code).join(", ")}`}`;
}

/** A work item, then the commits made inside its window (#2683). */
function workLines(doc: Result, w: WorkNode): string[] {
  const via = w.constrains.length > 0 ? w.constrains.map((c) => `${c.entry} (${c.granularity})`).join(", ") : "through a link only";
  const implemented = w.implements.length > 0 ? `; implements ${w.implements.map((d) => `${d.id} (${d.state ?? "unknown"})`).join(", ")}` : "";
  const readiness = w.ready ? "; ready" : w.blockedBy.length > 0 ? `; blocked by ${w.blockedBy.map((b) => `${b.id} (${b.state ?? "unknown"})`).join(", ")}` : "";
  const owner = w.owner ? `, owned by ${w.owner}` : "";
  const from = w.source ? `; from ${w.source.finding} on ${w.source.region}` : "";
  const out = [`work      ${w.record} ${w.state ?? "stateless"}${owner}: ${w.title ?? w.path}; constrains ${via}${implemented}${readiness}${from}`];
  for (const e of doc.edges.filter((x) => x.kind === "within" && x.to === w.id)) {
    const c = doc.nodes.find((n): n is CommitNode => n.kind === "commit" && n.id === e.from);
    if (c) out.push(`  worked    ${short(c.sha)} ${c.subject}; in ${w.record}'s window`);
  }
  for (const x of w.warnings) out.push(`  warning   ${x.code}: ${x.message}`);
  return out;
}

function artifactLine(doc: Result, a: ArtifactNode): string {
  const by = doc.edges
    .filter((e): e is Extract<IntentEdge, { kind: "pins" }> => e.kind === "pins" && e.to === a.id)
    .map((e) => `${e.from.slice(e.from.indexOf("/") + 1)} at ${short(e.pinnedSha256)} (${e.pinState})`);
  return `artifact  ${a.path} ${a.pinState}; pinned by ${by.join(", ")}; now ${short(a.currentSha256)}`;
}

function commitLine(doc: Result, c: CommitNode): string[] {
  const lines = c.lines && c.lines.length > 0 ? `, lines ${c.lines.map((l) => (l.start === l.end ? `${l.start}` : `${l.start}-${l.end}`)).join(", ")}` : "";
  const out = [`commit    ${short(c.sha)} ${c.date.slice(0, 10)} ${c.author.name}: ${c.subject}${lines}; ${c.signature.level}`];
  for (const e of edgesFrom(doc, c.id, "produced-by")) {
    const unit = doc.nodes.find((n) => n.id === e.to);
    out.push(`  unit      ${unit && "ref" in unit ? unit.ref : e.to}`);
    for (const s of edgesFrom(doc, e.to, "serves")) out.push(`  contract  ${s.to.slice("contract:".length)}`);
    for (const s of edgesFrom(doc, e.to, "cites-evidence")) out.push(`  evidence  ${s.to.slice("evidence:".length)}`);
  }
  return out;
}

/** The walk as text, one line each, in the order of #2650 section B. */
export function formatIntent(doc: Result): string {
  const out: string[] = [];
  const region = doc.nodes.find((n) => n.id === doc.region);
  if (region?.kind === "region") {
    const lines = region.lines ? `:${region.lines.start}${region.lines.end === region.lines.start ? "" : `-${region.lines.end}`}` : "";
    const where = doc.at ? `at ${short(doc.at)}` : "in the working tree";
    out.push(`region    ${region.path}${lines} (${region.type}, member ${region.member ?? "none"}${region.generated ? ", generated" : ""}) ${where}${region.node ? `, from node ${region.node}` : ""}`);
  }
  const files = ofKind(doc, "file");
  if (files.length > 0) out.push(`files     ${files.length} under the region, ${files.filter((f) => f.generated).length} generated`);
  for (const d of ofKind(doc, "decision")) out.push(decisionLine(d), ...withinLines(doc, d));
  for (const w of ofKind(doc, "work")) out.push(...workLines(doc, w));
  for (const a of ofKind(doc, "artifact")) out.push(artifactLine(doc, a));
  for (const c of ofKind(doc, "commit")) out.push(...commitLine(doc, c));
  for (const l of ofKind(doc, "link")) {
    const r = l.row;
    out.push(`link      ${r.consumer} reads ${"producer" in r ? `${r.producer} ${r.output}` : r.input} (${r.status})`);
  }
  for (const f of ofKind(doc, "finding")) {
    const by = f.addressedBy && f.addressedBy.length > 0 ? `; addressed by ${f.addressedBy.map((w) => `${w.id} (${w.state ?? "unknown"})`).join(", ")}` : "";
    out.push(`finding   ${f.code}: ${f.message}${by}`);
  }
  for (const r of doc.reasons) out.push(`reason    ${r.code}: ${r.message}`);
  const kinds = doc.kinds.length === 0 ? "; no --kind, so no decisions were read" : "";
  const work = ofKind(doc, "work").length;
  out.push(`${doc.summary.commits} commits, ${doc.summary.decisions} decisions, ${work > 0 ? `${work} work ${work === 1 ? "item" : "items"}, ` : ""}${doc.summary.artifacts} artifacts, ${doc.summary.findings} findings${kinds}`);
  return out.join("\n");
}

/** The record walk as text: the record, its window, then each commit with its bucket, and the counts. */
export function formatIntentRecord(doc: RecordResult): string {
  const r = doc.record;
  const out = [`record    ${r.record} ${r.state ?? "stateless"}${r.supersededBy ? `, superseded by ${r.supersededBy}` : ""}: ${r.title ?? r.path}`];
  out.push(`window    ${doc.window.from ? `from ${short(doc.window.from)}` : "no history"}${doc.window.until ? ` until ${short(doc.window.until)}` : ""}${r.decidedIn ? `; decided in ${short(r.decidedIn.sha)} ${r.decidedIn.date.slice(0, 10)}: ${r.decidedIn.subject}` : "; not decided in the history read"}`);
  for (const c of r.constrains) out.push(`entry     ${c.entry}${c.walked ? "" : c.exists === false ? " (not in the tree read)" : " (not walked)"}`);
  for (const c of doc.commits) {
    const why =
      c.bucket === "own"
        ? `unit ${c.unit}`
        : c.bucket === "worked"
          ? `worked by ${c.workedBy.map((w) => w.record).join(", ")}`
          : c.bucket === "within-other"
            ? `within ${c.alsoWithin.map((w) => w.record).join(", ")}`
            : "nothing else accounts for it";
    out.push(`${c.bucket.padEnd(12)} ${short(c.sha)} ${c.date.slice(0, 10)} ${c.subject}; ${why}; ${c.files.join(", ") || c.entries.join(", ")}`);
  }
  for (const x of doc.reasons) out.push(`reason    ${x.code}: ${x.message}`);
  const n = doc.counts;
  out.push(`${n.commits} commits in the window: ${n.own} own, ${n.worked} worked, ${n.withinOther} within another record's window, ${n.unexplained} unexplained; ${n.outsideWindow} outside it`);
  return out.join("\n");
}

async function runRecord(ctx: CommandContext, cwd: string, kinds: string[] | undefined): Promise<number> {
  const { args } = ctx;
  const { doc, failed } = await intentRecord({ cwd, record: args.record!, at: args.at, kinds: kinds?.map((k) => resolve(k)) });
  if (args.json) console.log(JSON.stringify(doc, null, 2));
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: RECORD_USAGE }));
    return 1;
  }
  if (!args.json) console.log(formatIntentRecord(doc));
  return failed ? 1 : 0;
}

export async function runWorkspaceIntent(ctx: CommandContext, cwd: string): Promise<number> {
  const { args } = ctx;
  if (args.record !== undefined) {
    if (args.intent) {
      console.error(formatError({ message: "--record walks a record, so --intent takes no region with it", hint: RECORD_USAGE }));
      return 1;
    }
    return runRecord(ctx, cwd, args.kinds ?? (args.kind !== undefined ? [args.kind] : undefined));
  }
  if (!args.intent) {
    console.error(formatError({ message: "--intent needs a region: a path, path:line or path:start-end", hint: USAGE }));
    return 1;
  }
  // No --kind: undefined, so the walk reads the kinds the declaration names (#2680).
  const kinds = args.kinds ?? (args.kind !== undefined ? [args.kind] : undefined);
  const { doc, failed } = await intentGraph({ cwd, region: args.intent, at: args.at, kinds: kinds?.map((k) => resolve(k)) });
  if (args.json) console.log(JSON.stringify(doc, null, 2));
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
    return 1;
  }
  if (!args.json) console.log(formatIntent(doc));
  return failed ? 1 : 0;
}
