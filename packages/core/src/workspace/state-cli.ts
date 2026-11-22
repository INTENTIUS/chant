/**
 * `chant workspace state [dir] [--member <name>] [--env <name>] [--at <rev>] [--json]`
 * (#5456): where each member's state lives, per environment. See
 * `./state-locations.ts` for what the document holds and who computes it.
 *
 * Members are read the way `chant workspace graph` reads them, each under its
 * own chant, so the answer is the one each member's lexicon gives for its own
 * configuration. `--env` is handed to every member's read, and the document
 * keeps the entries of that environment and the ones that name none. Like
 * `workspace graph`, the command exits 1 when a member could not be read.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { readerVersion } from "./declaration";
import { workspaceGraph } from "./graph-cli";
import {
  STATE_CONTRACT_VERSION,
  STATE_OUTPUT_SCHEMA_ID,
  stateDocument,
  type StateDocument,
} from "./state-locations";
import { handToRootChant } from "./which-chant";

const USAGE = "chant workspace state [dir] [--member <name>] [--env <name>] [--at <rev>] [--json]";

type Located = Extract<StateDocument, { members: unknown }>;

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join("  ").trimEnd());
}

const where = (loc: Record<string, unknown>): string =>
  Object.entries(loc)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");

/** The document as text: one row per location, and a line for each member with none. */
export function formatState(doc: Located): string {
  const rows = [["MEMBER", "ENV", "UNIT", "BACKEND", "LOCATION", "LOCK", "REACH"]];
  const notes: string[] = [];
  for (const m of doc.members) {
    if (m.states.length === 0) {
      notes.push(m.reason ? `${m.member}: ${m.status} (${m.reason.code}: ${m.reason.message})` : `${m.member}: its lexicon publishes no state location${m.published ? "s for this environment" : ""}`);
      continue;
    }
    for (const s of m.states) {
      rows.push([m.member, s.environment ?? "-", s.unit ?? "-", s.backend.kind, where(s.backend.location), s.lock?.mechanism ?? "none", s.reach.status]);
    }
  }
  const lines = rows.length > 1 ? table(rows) : [];
  if (notes.length > 0) lines.push("", ...notes);
  lines.push("", `${doc.summary.members} member${doc.summary.members === 1 ? "" : "s"}, ${doc.summary.published} with state locations, ${doc.summary.locations} location${doc.summary.locations === 1 ? "" : "s"}, ${doc.summary.unreachable} unreachable`);
  return lines.join("\n");
}

export async function runWorkspaceState(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = resolve(args.extraPositional ?? ".");
  if (!existsSync(cwd)) {
    console.error(formatError({ message: `${cwd} does not exist`, hint: USAGE }));
    return 1;
  }
  const handed = await handToRootChant(cwd, args.at);
  if (handed !== undefined) return handed;

  const { doc: graph, failed } = await workspaceGraph({
    cwd,
    at: args.at,
    members: args.members,
    args: { ...(args.env ? { env: args.env } : {}) },
    onStderr: (text) => process.stderr.write(text),
  });
  const head = { $schema: STATE_OUTPUT_SCHEMA_ID, contract: STATE_CONTRACT_VERSION, chant: readerVersion() };
  if ("error" in graph) {
    const error = { code: graph.error.code, message: graph.error.message, location: graph.error.location };
    if (args.json) console.log(JSON.stringify({ ...head, error }, null, 2));
    else console.error(formatError({ message: `${error.code}: ${error.message}`, hint: USAGE }));
    return 1;
  }
  const doc = stateDocument(graph, { ...head, at: graph.at }, args.env ?? null);
  console.log(args.json ? JSON.stringify(doc, null, 2) : formatState(doc));
  return failed ? 1 : 0;
}
