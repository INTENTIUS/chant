/**
 * #2707 — the workspace tools of `chant serve mcp`: the read contract and the
 * record writes, for a harness that speaks MCP and has no shell.
 *
 * Served when the server starts at or inside a declared workspace. Each tool
 * is a thin call into the code the CLI runs:
 *
 * - The reads (`workspace-ls`, `workspace-status`, `workspace-graph`,
 *   `workspace-records`) run `chant workspace <command> ... --json` with the
 *   chant this server runs as, in the server's directory, and return the
 *   document it printed, unchanged, with its reason codes (#2536). Running the
 *   command, rather than calling into it, keeps every rule it has, handing the
 *   read to the workspace root's pinned chant included (ws-021), and keeps
 *   anything a command prints away from the protocol on stdout.
 * - The writes (`records-new`, `records-amend`, `records-review`,
 *   `records-close`) call the functions `chant workspace records new|amend|
 *   review|close` call, and return the same JSON result. They keep every rule
 *   the CLI keeps: the kind's schema, a closed record never changing, an
 *   approved one changing only as its approval rule allows, a dissent needing
 *   a note, and `sign` using this host's configured key or refusing with the
 *   CLI's remedy. Through MCP a new record also opens in the kind's first
 *   state, `proposed` for a decision, and its stored source block (#2708) says
 *   it came through MCP: `via: "mcp"` and `client`, the MCP client's
 *   `clientInfo`. Computed provenance, from git, is unchanged.
 *
 * Nothing here listens on a port or authenticates anyone (ws-052): the server
 * speaks over stdio, and `by` is recorded as given, as `--by` is.
 */

import { spawn } from "node:child_process";
import type { ToolContext, ToolDefinition, ToolHandler } from "./types";

/** How the reads run chant: a command and its leading arguments. */
export type ChantCommand = string[];

/**
 * The chant this process runs as: node with the same flags (the tsx loader
 * `bin/chant` registers) and the same entry script.
 */
export function ownChantCommand(): ChantCommand {
  return [process.execPath, ...process.execArgv, process.argv[1]];
}

export interface WorkspaceToolsOptions {
  /** Where reads run and writes resolve kinds: the directory the server started in. */
  cwd: string;
  /** The chant the reads run. Defaults to {@link ownChantCommand}. */
  chantCommand?: ChantCommand;
}

const PROTOCOL =
  "Records are proposals until they are reviewed: a new record opens proposed, and people decide it through reviews and amendments. " +
  "by must name the person or agent that actually decided, as it is recorded as given.";

const kindProp = {
  type: "string",
  description:
    "The record kind: a kind file relative to the server's directory, such as decisions/decision.kind.mjs, or a kind the workspace declaration names. Without it, the one kind the declaration names.",
};
const atProp = { type: "string", description: "Read at this git revision instead of the working tree (--at)." };
const dryRunProp = { type: "boolean", description: "Return the result, with the text it would write, and write nothing (--dry-run)." };
const signProp = {
  type: "boolean",
  description:
    "Seal with this host's configured key, git's user.signingkey with gpg.format ssh, as --sign does. Refused, with the CLI's remedy, when none is set.",
};

export const workspaceReadTools: ToolDefinition[] = [
  {
    name: "workspace-ls",
    description:
      "List the workspace's members and groups: chant workspace ls --json. Returns that document unchanged, which follows ls.schema.json of the read contract, reason codes included.",
    inputSchema: { type: "object", properties: { at: atProp } },
  },
  {
    name: "workspace-status",
    description:
      "What each member has released to an environment, its gates, and the steward that runs it with each Op's last run, from the declaration and the lifecycle ledgers: chant workspace status <env> --json. Returns that document unchanged (status.schema.json).",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "The environment, such as dev." },
        compareTo: { type: "string", description: "A second environment to compare with (--compare-to)." },
      },
      required: ["env"],
    },
  },
  {
    name: "workspace-graph",
    description:
      "The workspace graph: chant workspace graph --json (graph.schema.json); with intent, the intent graph over one region (graph --intent, intent.schema.json); with composites, each composite instance and the components that can deploy it (graph --composites, composites.schema.json). Returns the document unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "array",
          items: { type: "string" },
          description: "Record kind files whose records join the graph (--kind). The plain graph takes one; intent takes several.",
        },
        intent: { type: "string", description: "The region for the intent graph: a workspace path, path:line or path:start-end (--intent)." },
        composites: { type: "boolean", description: "The composites document instead (--composites). Takes no kind or intent." },
        at: atProp,
      },
    },
  },
  {
    name: "workspace-records",
    description:
      "The records of a kind, validated, with supersession, provenance, quorum and warnings: chant workspace records --json (records.schema.json). With since, what changed since a revision or a review session (records-since.schema.json). Returns the document unchanged; with id, only that record is kept in records. " +
      PROTOCOL,
    inputSchema: {
      type: "object",
      properties: {
        kind: kindProp,
        current: { type: "boolean", description: "Leave out records a closed record supersedes (--current)." },
        since: { type: "string", description: "A revision, or a review session id, to compare with (--since)." },
        id: { type: "string", description: "Keep only the record with this id in the document's records." },
        at: atProp,
      },
    },
  },
];

export const workspaceWriteTools: ToolDefinition[] = [
  {
    name: "records-new",
    description:
      "Propose a new record: chant workspace records new. The record opens in the kind's first state (proposed for a decision); another state is refused. Its source block records that it came through MCP (via mcp, and this client's clientInfo). Validated against the kind's schema; nothing is written on refusal, and nothing is committed. " +
      PROTOCOL,
    inputSchema: {
      type: "object",
      properties: {
        kind: kindProp,
        record: { type: "object", description: "The record's fields, as the kind's schema describes them. The id is allocated when left out." },
        prefix: { type: "string", description: "The id prefix to allocate under, when the records use several (--prefix)." },
        by: { type: "string", description: "Who decided: written to the kind's decider field, such as decided_by. Required to sign." },
        sign: signProp,
        dryRun: dryRunProp,
      },
      required: ["record"],
    },
  },
  {
    name: "records-amend",
    description:
      "Set top-level fields of a record: chant workspace records amend. A closed record never changes, and an approved one changes only in its state, evidence and reviews: anything else, its reasoning included, is a new record that supersedes it. A source block given in the fields records that the change came through MCP. " +
      PROTOCOL,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The record's id." },
        kind: kindProp,
        fields: { type: "object", description: "The top-level fields to set; each replaces the whole field." },
        by: { type: "string", description: "Who decided: written to the kind's decider field." },
        sign: signProp,
        dryRun: dryRunProp,
      },
      required: ["id", "fields"],
    },
  },
  {
    name: "records-review",
    description:
      "Give a verdict on a record: chant workspace records review. Appends one entry to its reviews with the digest of the text judged, which moves its quorum. A dissent needs a note. " +
      PROTOCOL,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The record's id." },
        kind: kindProp,
        verdict: { type: "string", enum: ["agree", "dissent", "abstain"] },
        by: { type: "string", description: "The reviewer: the person or agent giving the verdict (--by)." },
        note: { type: "string", description: "Why; required for a dissent (--note)." },
        session: { type: "string", description: "The open review session the verdict is given in (--session)." },
        sign: signProp,
        dryRun: dryRunProp,
      },
      required: ["id", "verdict", "by"],
    },
  },
  {
    name: "records-close",
    description: "Close an open review session and seal it: chant workspace records close. " + PROTOCOL,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The session's id." },
        kind: { type: "string", description: "The session kind file. Without it, the one session kind the declaration names." },
        dryRun: dryRunProp,
      },
      required: ["id"],
    },
  },
];

/** A tool call that can't be made as given: the client gets it as an error result, and nothing runs. */
class ToolInputError extends Error {}

function str(params: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = params[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v === "") throw new ToolInputError(`${key} must be a non-empty string`);
  // A value is passed as one argument; one that starts with - would read as a flag.
  if (v.startsWith("-")) throw new ToolInputError(`${key} may not start with -: ${JSON.stringify(v)}`);
  return v;
}

function bool(params: Record<string, unknown>, key: string): boolean {
  const v = params[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new ToolInputError(`${key} must be true or false`);
  return v;
}

function obj(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = params[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ToolInputError(`${key} must be a JSON object`);
  return v as Record<string, unknown>;
}

function kinds(params: Record<string, unknown>): string[] {
  const v = params.kind;
  if (v === undefined || v === null) return [];
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list)) throw new ToolInputError("kind must be a kind file, or a list of them");
  return list.map((k, i) => str({ [`kind[${i}]`]: k }, `kind[${i}]`, true)!);
}

/** The `chant` arguments each read tool runs, from its input. Exported for the conformance suite's MCP transport. */
export function readArgv(tool: string, params: Record<string, unknown>): string[] {
  const at = str(params, "at");
  const atArgs = at !== undefined ? ["--at", at] : [];
  switch (tool) {
    case "workspace-ls":
      return ["workspace", "ls", ...atArgs, "--json"];
    case "workspace-status": {
      const env = str(params, "env", true)!;
      const compareTo = str(params, "compareTo");
      return ["workspace", "status", env, ...(compareTo !== undefined ? ["--compare-to", compareTo] : []), "--json"];
    }
    case "workspace-graph": {
      const intent = str(params, "intent");
      const composites = bool(params, "composites");
      const kindArgs = kinds(params).flatMap((k) => ["--kind", k]);
      if (composites) return ["workspace", "graph", "--composites", ...kindArgs, ...(intent !== undefined ? ["--intent", intent] : []), ...atArgs, "--json"];
      if (intent !== undefined) return ["workspace", "graph", "--intent", intent, ...kindArgs, ...atArgs, "--json"];
      return ["workspace", "graph", ...kindArgs, ...atArgs, "--json"];
    }
    case "workspace-records": {
      const kind = str(params, "kind");
      const since = str(params, "since");
      return [
        "workspace",
        "records",
        ...(kind !== undefined ? ["--kind", kind] : []),
        ...(bool(params, "current") ? ["--current"] : []),
        ...(since !== undefined ? ["--since", since] : []),
        ...atArgs,
        "--json",
      ];
    }
    default:
      throw new ToolInputError(`${tool} is not a workspace read tool`);
  }
}

/** Run chant and parse the one JSON document it printed. The exit code does not matter: an error document is a document. */
function runRead(command: ChantCommand, argv: string[], cwd: string): Promise<unknown> {
  return new Promise((settle, fail) => {
    const child = spawn(command[0], [...command.slice(1), ...argv], { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (s: string) => (stdout += s));
    child.stderr.setEncoding("utf-8").on("data", (s: string) => (stderr += s));
    child.on("error", (e) => fail(new Error(`could not run chant ${argv.join(" ")}: ${e.message}`)));
    child.on("close", (status) => {
      try {
        settle(JSON.parse(stdout));
      } catch {
        const why = stderr.trim() || stdout.trim() || `exit ${status}`;
        fail(new Error(`chant ${argv.join(" ")} printed no JSON document: ${why}`));
      }
    });
  });
}

/** Keep only the record with `id` in a records document, or in each kind of a declared set. */
function onlyRecord(doc: unknown, id: string): unknown {
  if (doc === null || typeof doc !== "object") return doc;
  const d = doc as Record<string, unknown>;
  if (Array.isArray(d.records)) return { ...d, records: (d.records as { id?: unknown }[]).filter((r) => r.id === id) };
  if (Array.isArray(d.kinds)) return { ...d, kinds: d.kinds.map((k) => onlyRecord(k, id)) };
  return doc;
}

/** The source block a write through MCP lays over the record's (#2708). */
function mcpSource(context: ToolContext | undefined): Record<string, unknown> {
  const c = context?.clientInfo;
  const client =
    c && typeof c.name === "string" && c.name !== ""
      ? {
          name: c.name,
          ...(typeof c.version === "string" && c.version !== "" ? { version: c.version } : {}),
          ...(typeof c.title === "string" && c.title !== "" ? { title: c.title } : {}),
        }
      : undefined;
  return { via: "mcp", ...(client ? { client } : {}) };
}

export interface WorkspaceTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/** The workspace tools, reads then writes, bound to the server's directory. */
export function createWorkspaceTools(options: WorkspaceToolsOptions): WorkspaceTool[] {
  const { cwd } = options;
  const chant = options.chantCommand ?? ownChantCommand();
  const reads: WorkspaceTool[] = workspaceReadTools.map((definition) => ({
    definition,
    handler: async (params) => {
      const argv = readArgv(definition.name, params);
      const id = definition.name === "workspace-records" ? str(params, "id") : undefined;
      const doc = await runRead(chant, argv, cwd);
      return id !== undefined ? onlyRecord(doc, id) : doc;
    },
  }));

  const write = async () => import("../../workspace/records-write");
  /** The kind file a write goes through: the one named, or the one the declaration names; else the CLI's usage failure. */
  const writeKind = async (params: Record<string, unknown>, schema: string, missing: string): Promise<string | object> => {
    const w = await write();
    const named = str(params, "kind");
    return named !== undefined ? w.resolveWriteKind(named, cwd) : w.declaredWriteKind(schema, cwd, missing);
  };
  const sign = (params: Record<string, unknown>): true | undefined => (bool(params, "sign") ? true : undefined);

  const handlers: Record<string, ToolHandler> = {
    "records-new": async (params, context) => {
      const w = await write();
      const record = obj(params, "record");
      const kind = await writeKind(params, w.RECORDS_NEW_SCHEMA_ID, "new needs the kind file");
      if (typeof kind !== "string") return kind;
      return w.newRecord({
        kind,
        fields: JSON.stringify(record),
        prefix: str(params, "prefix"),
        by: str(params, "by"),
        sign: sign(params),
        dryRun: bool(params, "dryRun"),
        cwd,
        through: { source: mcpSource(context), opensInitial: true },
      });
    },
    "records-amend": async (params, context) => {
      const w = await write();
      const id = str(params, "id", true)!;
      const fields = obj(params, "fields");
      const kind = await writeKind(params, w.RECORDS_AMEND_SCHEMA_ID, "--kind <kind file> is required");
      if (typeof kind !== "string") return kind;
      return w.amendRecord({
        kind,
        id,
        fields: JSON.stringify(fields),
        by: str(params, "by"),
        sign: sign(params),
        dryRun: bool(params, "dryRun"),
        cwd,
        through: { source: mcpSource(context) },
      });
    },
    "records-review": async (params) => {
      const w = await write();
      const id = str(params, "id", true)!;
      const kind = await writeKind(params, w.RECORDS_REVIEW_SCHEMA_ID, "--kind <kind file> is required");
      if (typeof kind !== "string") return kind;
      return w.reviewRecord({
        kind,
        id,
        verdict: str(params, "verdict", true)!,
        by: str(params, "by", true)!,
        note: typeof params.note === "string" ? params.note : undefined,
        session: str(params, "session"),
        sign: sign(params),
        dryRun: bool(params, "dryRun"),
        cwd,
      });
    },
    "records-close": async (params) => {
      const w = await write();
      const { closeRecord, RECORDS_CLOSE_SCHEMA_ID } = await import("../../workspace/records-close");
      const id = str(params, "id", true)!;
      const named = str(params, "kind");
      const kind = named !== undefined ? w.resolveWriteKind(named, cwd) : await w.declaredSessionKind(RECORDS_CLOSE_SCHEMA_ID, cwd);
      if (typeof kind !== "string") return kind;
      return closeRecord({ kind, id, dryRun: bool(params, "dryRun"), cwd });
    },
  };

  const writes: WorkspaceTool[] = workspaceWriteTools.map((definition) => ({ definition, handler: handlers[definition.name] }));
  return [...reads, ...writes];
}
