/**
 * `chant workspace agent [<name>] [--json]` (#2524 D20, #2548, ws-067): what
 * an agent session reloads from, read from the repository alone.
 *
 * A session is declared in the declaration's `agents` list and bound to one
 * member. This prints the session, its member, its write scope (the files
 * and the record kinds, with their verbs, it may write) and the spec: the
 * `spec` block `chant workspace records --current --json` prints (#2546). An
 * agent that resumes needs nothing else: no memory of an earlier run, no
 * state outside the checkout.
 *
 * The session and its scope come from the declaration at base, as the
 * write paths and `check --changes` read them; the spec from the working
 * tree, which is what the agent works on. Without a name, the session
 * `CHANT_AGENT` names.
 */

import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, WRITE_VERBS, type WriteVerb } from "./declaration";
import type { ReasonCode } from "./reason-codes";
import { declaredKindFiles, queryDeclaredRecords, type SpecView } from "./records-cli";
import { AGENT_ENV, resolveWriter, scopeOf, scopeSource, WriteScopeError } from "./write-scope";

/** The version of the `agent` document this chant writes. */
export const AGENT_CONTRACT_VERSION = 1;

export const AGENT_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/agent/v1/agent.schema.json";

/** Why the session can't be printed. Closed. */
export const AGENT_ERROR_CODES = [...WORKSPACE_ERROR_CODES, "agent-unknown"] as const satisfies readonly ReasonCode[];
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/** A record kind in the session's reach, with the verbs it may write it with. */
export interface AgentKindScope {
  /** The kind file from the workspace root, as the declaration names it. */
  path: string;
  /** The kind file's recordKind.name, or null when it can't be loaded. */
  kind: string | null;
  /** The name the declaration gives it, or null. */
  name: string | null;
  /** The member that declares it, or null for the workspace's own. */
  member: string | null;
  /** Empty when writeScope.agent.records leaves the kind out. */
  verbs: WriteVerb[];
}

interface Head {
  $schema: string;
  contract: number;
  chant: string;
}

export type AgentDocument =
  | (Head & {
      workspace: { name: string; root: string; scopeFrom: "base" | "working-tree" };
      agent: { name: string; member: { name: string; dir: string; kind: string }; principals: string[] };
      scope: {
        /** The one member whose files the session writes. */
        members: string[];
        /** Every declared kind in reach: the workspace's own and the member's. */
        records: AgentKindScope[];
        /** The paths writeScope.agent.protected keeps the session from writing, with the JSON keys each still allows (#3146). */
        protected: { path: string; except: string[] }[];
      };
      /** The spec, as records --current --json prints it. */
      spec: SpecView;
      /** The reads that rebuild the session's context. */
      reload: string[];
    })
  | (Head & { error: { code: AgentErrorCode; message: string } });

/** The session `name` names, as {@link AgentDocument} prints it. Never throws a read or scope error. */
export async function agentSession(q: { cwd: string; name: string }): Promise<AgentDocument> {
  const head: Head = { $schema: AGENT_OUTPUT_SCHEMA_ID, contract: AGENT_CONTRACT_VERSION, chant: readerVersion() };
  try {
    const source = scopeSource(q.cwd);
    if (source.declaration === null || source.from === null) {
      throw new WorkspaceReadError("declaration-missing", "no chant.workspace.json or .jsonc between this directory and the git root, so no agent session is declared");
    }
    const decl = source.declaration;
    const writer = resolveWriter(decl, source.policy, { agent: q.name });
    const agent = writer.agent!;
    const member = decl.members.find((m) => m.name === agent.member)!;
    const scope = scopeOf(decl, writer)!;
    const rules = scope.records;
    // The spec query, over every declared kind in the working tree.
    const set = await queryDeclaredRecords(declaredKindFiles(q.cwd), { cwd: q.cwd, current: true });
    const loadedName = new Map(set.kinds.map((k) => [k.declared.path, "error" in k ? null : k.kind.name]));
    const records: AgentKindScope[] = [...decl.records, ...member.records].map((d) => {
      const kind = loadedName.get(d.path) ?? null;
      const names = [kind, d.name].filter((n): n is string => n !== null);
      const verbs = rules === null ? [...WRITE_VERBS] : WRITE_VERBS.filter((v) => names.some((n) => (rules[n] ?? []).includes(v)));
      return { path: d.path, kind, name: d.name, member: d.member, verbs };
    });
    return {
      ...head,
      workspace: { name: decl.name, root: source.root ?? ".", scopeFrom: source.from },
      agent: { name: agent.name, member: { name: member.name, dir: member.dir, kind: member.kind }, principals: agent.principals },
      scope: { members: [member.name], records, protected: scope.protected.map((p) => ({ path: p.path, except: [...p.except] })) },
      spec: set.spec ?? { kinds: [], records: [] },
      reload: [`chant workspace agent ${agent.name} --json`, "chant workspace records --current --json"],
    };
  } catch (err) {
    if (err instanceof WorkspaceReadError || err instanceof WriteScopeError) {
      return { ...head, error: { code: err.code as AgentErrorCode, message: err instanceof WorkspaceReadError ? err.describe() : err.message } };
    }
    throw err;
  }
}

const USAGE = "chant workspace agent [<name>] [--json]";

/** `chant workspace agent`: exit 0 when the session was printed, 1 otherwise. */
export async function runWorkspaceAgent(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const name = args.extraPositional ?? (process.env[AGENT_ENV] || undefined);
  if (!name) {
    console.error(formatError({ message: `name the agent session, or set ${AGENT_ENV}`, hint: USAGE }));
    return 1;
  }
  const doc = await agentSession({ cwd: process.cwd(), name });
  if (args.json || args.format === "json") console.log(JSON.stringify(doc, null, 2));
  if ("error" in doc) {
    if (!args.json && args.format !== "json") console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
    return 1;
  }
  if (args.json || args.format === "json") return 0;
  const out: string[] = [];
  out.push(`agent     ${doc.agent.name}, bound to member ${doc.agent.member.name} (${doc.agent.member.dir}), scope read from ${doc.workspace.scopeFrom}`);
  for (const r of doc.scope.records) out.push(`records   ${r.name ?? r.kind ?? r.path} (${r.path}): ${r.verbs.length > 0 ? r.verbs.join(", ") : "not writable"}`);
  for (const p of doc.scope.protected) out.push(`protected ${p.path}${p.except.length > 0 ? ` (except ${p.except.join(", ")})` : ""}`);
  out.push(`spec      ${doc.spec.records.length} current records of ${doc.spec.kinds.length} spec kinds`);
  for (const r of doc.spec.records) out.push(`          ${r.kind}/${r.id ?? "?"} ${r.state ?? ""} ${r.path}`);
  out.push(`reload    ${doc.reload.join("; ")}`);
  console.log(out.join("\n"));
  return 0;
}
