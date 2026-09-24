/**
 * `chant workspace graph --intent <path[:start-end]> [--at <rev>] [--kind <kind file>...] [--json]`
 * (#2651): the intent graph over one region (`intent.ts`), printed as JSON
 * with `--json` or as a walk, one line per node, in the order of #2650
 * section B: the region, its decisions, their artifacts, the commits, and the
 * findings.
 */

import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { intentGraph, type ArtifactNode, type CommitNode, type DecisionNode, type IntentDocument, type IntentEdge, type IntentNode } from "./intent";

const USAGE = "chant workspace graph --intent <path[:start-end]> [--at <rev>] [--kind <kind file>...] [--json]";

type Result = Exclude<IntentDocument, { error: unknown }>;

function edgesFrom(doc: Result, from: string, kind: IntentEdge["kind"]): IntentEdge[] {
  return doc.edges.filter((e) => e.from === from && e.kind === kind);
}

function ofKind<K extends IntentNode["kind"]>(doc: Result, kind: K): Extract<IntentNode, { kind: K }>[] {
  return doc.nodes.filter((n): n is Extract<IntentNode, { kind: K }> => n.kind === kind);
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : "none");

function decisionLine(d: DecisionNode): string {
  const via = d.constrains.length > 0 ? d.constrains.map((c) => `${c.entry} (${c.granularity})`).join(", ") : "through supersession only";
  const by = d.decided_by ? `, decided by ${d.decided_by}${d.decided_on ? ` on ${d.decided_on}` : ""}` : "";
  const reviews = `${d.reviews.agree} agree, ${d.reviews.dissent} dissent, ${d.reviews.abstain} abstain`;
  const superseded = d.supersededBy ? `, superseded by ${d.supersededBy}` : "";
  return `decision  ${d.record} ${d.state ?? "stateless"}${superseded}: ${d.title ?? d.path}; constrains ${via}${by}; ${reviews}; ${d.provenance.level}${d.valid ? "" : `; invalid: ${d.reasons.map((r) => r.code).join(", ")}`}`;
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
  for (const d of ofKind(doc, "decision")) out.push(decisionLine(d));
  for (const a of ofKind(doc, "artifact")) out.push(artifactLine(doc, a));
  for (const c of ofKind(doc, "commit")) out.push(...commitLine(doc, c));
  for (const l of ofKind(doc, "link")) {
    const r = l.row;
    out.push(`link      ${r.consumer} reads ${"producer" in r ? `${r.producer} ${r.output}` : r.input} (${r.status})`);
  }
  for (const f of ofKind(doc, "finding")) out.push(`finding   ${f.code}: ${f.message}`);
  for (const r of doc.reasons) out.push(`reason    ${r.code}: ${r.message}`);
  const kinds = doc.kinds.length === 0 ? "; no --kind, so no decisions were read" : "";
  out.push(`${doc.summary.commits} commits, ${doc.summary.decisions} decisions, ${doc.summary.artifacts} artifacts, ${doc.summary.findings} findings${kinds}`);
  return out.join("\n");
}

export async function runWorkspaceIntent(ctx: CommandContext, cwd: string): Promise<number> {
  const { args } = ctx;
  if (!args.intent) {
    console.error(formatError({ message: "--intent needs a region: a path, path:line or path:start-end", hint: USAGE }));
    return 1;
  }
  const kinds = args.kinds ?? (args.kind !== undefined ? [args.kind] : []);
  const { doc, failed } = await intentGraph({ cwd, region: args.intent, at: args.at, kinds: kinds.map((k) => resolve(k)) });
  if (args.json) console.log(JSON.stringify(doc, null, 2));
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
    return 1;
  }
  if (!args.json) console.log(formatIntent(doc));
  return failed ? 1 : 0;
}
