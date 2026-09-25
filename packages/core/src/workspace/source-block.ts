/**
 * A record's stored source block (#2708): where a proposal came from.
 *
 * chant's provenance (`trust/provenance.ts`) is computed from git: who
 * committed a record, and with which key. It says nothing about the harness,
 * model and session a decision was proposed in, or the conversation behind it.
 * A record kind that declares `source: { field }` opts in to a stored block
 * holding that, next to whatever else its source field says (a decision's
 * issue row or workspace member, a work item's finding):
 *
 * - `via`: how the record reached the workspace, `cli`, `mcp` or `harvest`;
 * - `client`: the MCP client's `clientInfo` (`name`, `version`), or the CLI;
 * - `harness`: the harness's id, such as `claude-code` or `codex`;
 * - `model`: the model id the harness reports;
 * - `session`: the harness's session or conversation id, as a string, or as
 *   `{ id, record }` with the chant session record it was held in (#2697);
 * - `turns`: the turn range the decision was made in, `{ from, to }`;
 * - `transcript`: `{ path | uri, sha256 }`, pinning a transcript by hash and
 *   never copying it, the way evidence pins a file.
 *
 * Every field is optional, and the block is data about the proposal, not
 * trust: nothing here raises or lowers a record's standing. The rules are
 * three. The fields that are present must have these shapes
 * (`record-schema-invalid` otherwise, beside the kind's own schema). A record
 * written with `via: "harvest"` must open in the kind's first state, since a
 * harvest proposes and a person decides (`source-harvest-not-proposed`, a
 * write refusal). And `records` warns `source-transcript-drift` when the
 * pinned transcript can be read here and its bytes hash to something else.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sha256Hex } from "../content-digest";

/** How a record reached the workspace. Closed. */
export const SOURCE_VIAS = ["cli", "mcp", "harvest"] as const;
export type SourceVia = (typeof SOURCE_VIAS)[number];

const text = z.string().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be the lowercase hex SHA-256 of the transcript's bytes");

/** The proposal fields of a source block. Other fields of the block are the kind's, and left to its schema. */
export const sourceBlockSchema = z.object({
  via: z.enum(SOURCE_VIAS).optional(),
  client: z.object({ name: text, version: text.optional(), title: text.optional() }).strict().optional(),
  harness: text.optional(),
  model: text.optional(),
  session: z
    .union([
      text,
      z.null(),
      z
        .object({ id: text.optional(), record: text.optional() })
        .strict()
        .refine((s) => s.id !== undefined || s.record !== undefined, { message: "names neither the harness's session id nor a chant session record" }),
    ])
    .optional(),
  turns: z
    .object({ from: z.number().int().min(0), to: z.number().int().min(0) })
    .strict()
    .refine((t) => t.to >= t.from, { message: "ends before it starts" })
    .optional(),
  transcript: z
    .union([z.object({ path: text, sha256 }).strict(), z.object({ uri: text, sha256 }).strict()])
    .optional(),
});

export type SourceBlock = z.infer<typeof sourceBlockSchema>;

/** The source block of `data`, when `field` holds an object. */
export function sourceBlock(data: Record<string, unknown> | null, field: string): Record<string, unknown> | undefined {
  const v = data?.[field];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** What is wrong with the proposal fields of `block`, as `<path> <message>` lines. Empty when nothing is. */
export function sourceBlockProblems(block: Record<string, unknown>, field: string): string[] {
  const parsed = sourceBlockSchema.safeParse(block);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `/${[field, ...i.path].join("/")} ${i.message}`);
}

/**
 * The file a transcript pin names, when it can be read here: a `path`
 * (absolute, `~/` from the home directory, or else from the workspace root)
 * or a `file:` URI. Any other URI is not fetched, so it is never reachable.
 */
export function transcriptFile(transcript: { path?: string; uri?: string }, workspaceDir: string): string | undefined {
  if (transcript.path !== undefined) {
    const p = transcript.path;
    if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
    return isAbsolute(p) ? p : resolve(workspaceDir, p);
  }
  if (transcript.uri !== undefined && transcript.uri.startsWith("file:")) {
    try {
      return fileURLToPath(transcript.uri);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The `source-transcript-drift` message for `block`, or undefined: when its
 * transcript pin is well formed, the file it names can be read here, and its
 * bytes hash to something other than the pin. A transcript that can't be
 * read says nothing either way.
 */
export function transcriptDrift(block: Record<string, unknown>, field: string, workspaceDir: string): string | undefined {
  const parsed = sourceBlockSchema.shape.transcript.safeParse(block.transcript);
  if (!parsed.success || parsed.data === undefined) return undefined;
  const t = parsed.data as { path?: string; uri?: string; sha256: string };
  const file = transcriptFile(t, workspaceDir);
  if (file === undefined) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch {
    return undefined;
  }
  const actual = sha256Hex(bytes);
  if (actual === t.sha256) return undefined;
  const named = t.path ?? t.uri!;
  return `${field}.transcript ${named} is pinned at sha256 ${t.sha256.slice(0, 12)}, and the file here hashes to ${actual.slice(0, 12)}: it is not the transcript the record means`;
}
