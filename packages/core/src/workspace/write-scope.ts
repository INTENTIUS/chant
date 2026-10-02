/**
 * Write scope per member and record kind, for each principal class, and the
 * agent sessions bound to one member (#2524 D5, D20; #2548; ws-067).
 *
 * The declaration's `writeScope` block gives a restricted class the members
 * whose files it may write and the record kinds it may write, with which
 * verbs (`new`, `amend`, `review`, `close`). A class with no entry is not
 * restricted. The declaration's `agents` list names agent sessions, each
 * bound to one member: a session writes that member's files, and the records
 * of kinds that member or the workspace declares, as `writeScope.agent`
 * allows. An agent's members can't be widened.
 *
 * Two places apply it, both reading the scope from the base revision so a
 * change can't widen its own scope (#2524 threat model):
 *
 * - The write paths: `chant workspace records new|amend|review|close` and the
 *   MCP record tools refuse a write outside the writer's scope with
 *   `write-scope-member` or `write-scope-kind`, and an unknown session with
 *   `agent-unknown`. The session comes from `CHANT_AGENT`.
 * - The enforcement boundary: `chant workspace check --changes <range>`
 *   judges every commit in the range, by its `Chant-Agent` trailer, its
 *   attested principal, or its author, and reports each path written outside
 *   that writer's scope. Run in CI with an attestation policy, the principal
 *   is the signer the policy at base trusts; on a developer machine it is
 *   detection only (ws-002).
 *
 * A principal's class comes from the role grants in the trust policy at base,
 * through {@link principalClass} alone (the agent, runner and service roles),
 * or from naming an agent session. Claiming a session only ever narrows what
 * a writer may do, so an unverified `CHANT_AGENT` or trailer is safe to honour.
 */

import { execFileSync } from "node:child_process";
import { posix, relative, sep } from "node:path";
import {
  PRINCIPAL_CLASSES,
  readDeclaration,
  WorkspaceReadError,
  type AgentDeclaration,
  type ClassScope,
  type Declaration,
  type PrincipalClass,
  type WriteVerb,
} from "./declaration";
import type { ReasonCode } from "./reason-codes";
import { memberHolding } from "./record-assets";
import { gitRoot } from "./record-source";
import { normalisePrincipal, parseFrontMatter } from "./records";
import { emptyPolicy, type TrustPolicy } from "./trust/policy";
import { commitProvenance, policyAtBase, resolveBase } from "./trust/provenance";
import { locateWorkspace } from "./which-chant";

/** The environment variable naming the agent session a write is made in. */
export const AGENT_ENV = "CHANT_AGENT";

/** The commit trailer naming the agent session a commit was made in. */
export const AGENT_TRAILER = "Chant-Agent";

/** Why a write is outside its writer's scope. Closed. */
export const WRITE_SCOPE_CODES = ["write-scope-member", "write-scope-kind", "agent-unknown"] as const satisfies readonly ReasonCode[];
export type WriteScopeCode = (typeof WRITE_SCOPE_CODES)[number];

/** The classes a role grant puts a principal in, in the order they are tried. Human is the rest. */
const ROLE_CLASSES = ["agent", "runner", "service"] as const satisfies readonly PrincipalClass[];

/**
 * The role grants a class is read from. Every read of roles for write scope
 * goes through here, so where the grants live (`.chant/trust.json` today,
 * possibly the declaration, #2547) is decided in one place: the policy.
 */
export function roleGrants(policy: TrustPolicy): Record<string, string[]> {
  return policy.roles;
}

/** The class a principal is in: the first of agent, runner and service whose role it holds at base, or human. */
export function principalClass(policy: TrustPolicy, principal: string | null): PrincipalClass {
  if (principal === null) return "human";
  const name = normalisePrincipal(principal);
  const grants = roleGrants(policy);
  return ROLE_CLASSES.find((cls) => (grants[cls] ?? []).some((p) => normalisePrincipal(p) === name)) ?? "human";
}

/** Who is writing, as the scope judges it. */
export interface Writer {
  /** The principal named, or null when none is. */
  principal: string | null;
  class: PrincipalClass;
  /** The agent session the writer is bound to, or null. */
  agent: AgentDeclaration | null;
}

export class WriteScopeError extends Error {
  constructor(
    readonly code: WriteScopeCode,
    message: string,
  ) {
    super(message);
    this.name = "WriteScopeError";
  }
}

/**
 * The writer: in the session `agent` names (refused with agent-unknown when
 * the declaration declares none by that name), in the session that lists
 * `principal`, or else in the class `principal`'s roles give it.
 */
export function resolveWriter(declaration: Declaration | null, policy: TrustPolicy, given: { agent?: string | null; principal?: string | null }): Writer {
  const principal = given.principal ?? null;
  const agents = declaration?.agents ?? [];
  if (given.agent !== undefined && given.agent !== null) {
    const agent = agents.find((a) => a.name === given.agent);
    if (!agent) {
      const known = agents.map((a) => a.name).join(", ");
      throw new WriteScopeError(
        "agent-unknown",
        declaration === null
          ? `agent session ${JSON.stringify(given.agent)} is not declared: there is no workspace declaration`
          : `agent session ${JSON.stringify(given.agent)} is not declared: the declaration's agents ${known ? `are ${known}` : "list none"}`,
      );
    }
    return { principal, class: "agent", agent };
  }
  if (principal !== null) {
    const name = normalisePrincipal(principal);
    const agent = agents.find((a) => a.principals.some((p) => normalisePrincipal(p) === name));
    if (agent) return { principal, class: "agent", agent };
  }
  return { principal, class: principalClass(policy, principal), agent: null };
}

/** The scope that applies to `writer`, or null when its class is not restricted. An agent is always restricted to its member. */
export function scopeOf(declaration: Declaration | null, writer: Writer): ClassScope | null {
  const entry = declaration?.writeScope?.[writer.class];
  if (writer.class === "agent") return { members: null, records: entry?.records ?? null, pointer: entry?.pointer ?? "/agents" };
  return entry ?? null;
}

export type ScopeVerdict = { ok: true } | { ok: false; code: Exclude<WriteScopeCode, "agent-unknown">; message: string };

const OK: ScopeVerdict = { ok: true };

function who(writer: Writer): string {
  if (writer.agent) return `agent session ${writer.agent.name}, bound to member ${writer.agent.member},`;
  const name = writer.principal !== null ? `${writer.principal} (${writer.class})` : `a ${writer.class} writer`;
  return writer.class === "agent" ? `${name}, which no agent session lists,` : name;
}

/** Whether `writer` may write in `member` (null: a path in no member). */
function memberAllowed(writer: Writer, scope: ClassScope, member: string | null): boolean {
  if (writer.class === "agent") return member !== null && member === writer.agent?.member;
  return scope.members === null || (member !== null && scope.members.includes(member));
}

/** The record kind a write goes to, as the scope reads it. */
export interface ScopedKind {
  /** The kind file's `recordKind.name`. */
  name: string;
  /** The name the declaration gives it, or null. */
  declaredName: string | null;
  /** The member that declares the kind, or null for the workspace's own kinds. */
  member: string | null;
  /** True when the declaration names the kind; an undeclared kind belongs to the member holding its records. */
  declared: boolean;
}

/** Whether `writer` may write a record of `kind` with `verb`. A delete is never in a restricted scope. */
export function judgeRecord(declaration: Declaration | null, writer: Writer, kind: ScopedKind, verb: WriteVerb | "delete"): ScopeVerdict {
  const scope = scopeOf(declaration, writer);
  if (scope === null) return OK;
  // The workspace's own kinds are in every member's reach; a member's kinds only in its own.
  const inReach = kind.declared && kind.member === null ? true : memberAllowed(writer, scope, kind.member);
  if (!inReach) {
    const where = kind.member === null ? "in no member" : `of member ${kind.member}`;
    return {
      ok: false,
      code: "write-scope-member",
      message: `${who(writer)} may not write ${kind.name} records, which are ${where}: ${writer.class === "agent" ? "an agent session writes only its own member" : `writeScope.${writer.class}.members leaves it out`}`,
    };
  }
  if (verb === "delete") {
    return { ok: false, code: "write-scope-kind", message: `${who(writer)} may not delete a ${kind.name} record: a record is never deleted, and a new one supersedes it` };
  }
  if (scope.records === null) return OK;
  const names = [kind.name, ...(kind.declaredName !== null && kind.declaredName !== kind.name ? [kind.declaredName] : [])];
  const verbs = names.flatMap((n) => scope.records![n] ?? []);
  if (verbs.includes(verb)) return OK;
  return {
    ok: false,
    code: "write-scope-kind",
    message:
      verbs.length === 0
        ? `${who(writer)} may not write ${kind.name} records: writeScope.${writer.class}.records does not list the kind`
        : `${who(writer)} may ${[...new Set(verbs)].join(", ")} ${kind.name} records, and not ${verb} them (writeScope.${writer.class}.records)`,
  };
}

/** Whether `writer` may write the file at `path`, from the workspace root. */
export function judgePath(declaration: Declaration | null, writer: Writer, path: string): ScopeVerdict {
  const scope = scopeOf(declaration, writer);
  if (scope === null) return OK;
  const member = memberHolding(path, declaration?.members ?? []);
  if (memberAllowed(writer, scope, member)) return OK;
  const where = member === null ? "is in no member" : `is in member ${member}`;
  return {
    ok: false,
    code: "write-scope-member",
    message: `${who(writer)} may not write ${path}, which ${where}: ${writer.class === "agent" ? "an agent session writes only its own member" : `writeScope.${writer.class}.members leaves it out`}`,
  };
}

// ── The scope a write is judged by ───────────────────────────────────────────

/** The declaration and policy a write on this machine is judged by. */
export interface ScopeSource {
  declaration: Declaration | null;
  /** Where the declaration was read: the base revision, or the working tree when there is no base or no declaration at it. */
  from: "base" | "working-tree" | null;
  /** The workspace root on disk, or null without a declaration. */
  rootOnDisk: string | null;
  /** The workspace root from the git root, "." for the git root, or null without a declaration. */
  root: string | null;
  policy: TrustPolicy;
}

function readAt(cwd: string, at?: string): { declaration: Declaration; rootOnDisk: string; root: string } | null {
  try {
    const located = locateWorkspace(cwd, at);
    return { declaration: readDeclaration(located.tree), rootOnDisk: located.rootOnDisk, root: located.root };
  } catch (err) {
    if (err instanceof WorkspaceReadError) return null;
    throw err;
  }
}

/**
 * The scope for a write from `cwd`: the declaration and the trust policy at
 * the base revision (`origin/HEAD`, `main` or `master`), so a write can't
 * widen its own scope by editing its copy of the declaration. Without a base,
 * or without a declaration at it, the working tree's declaration.
 */
export function scopeSource(cwd: string): ScopeSource {
  const top = gitRoot(cwd);
  const base = top ? resolveBase(top) : null;
  const policy = top && base ? policyAtBase(top, base) : emptyPolicy(null);
  if (base?.commit) {
    const atBase = readAt(cwd, base.commit);
    if (atBase) return { ...atBase, from: "base", policy };
  }
  const here = readAt(cwd);
  return here ? { ...here, from: "working-tree", policy } : { declaration: null, from: null, rootOnDisk: null, root: null, policy };
}

const toPosix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));

/**
 * The kind a write goes to, as {@link judgeRecord} reads it: the declared
 * entry whose file is `kindFile`, or, for a kind the declaration does not
 * name, the member holding `recordsDir`.
 */
export function scopedKind(source: ScopeSource, kindName: string, kindFile: string, recordsDir: string): ScopedKind {
  const decl = source.declaration;
  if (!decl || source.rootOnDisk === null) return { name: kindName, declaredName: null, member: null, declared: false };
  const path = toPosix(relative(source.rootOnDisk, kindFile));
  const declared = [...decl.records, ...decl.members.flatMap((m) => m.records)].find((r) => r.path === path);
  if (declared) return { name: kindName, declaredName: declared.name, member: declared.member, declared: true };
  const dir = toPosix(relative(source.rootOnDisk, recordsDir));
  return { name: kindName, declaredName: null, member: dir.startsWith("..") ? null : memberHolding(dir === "" ? "." : dir, decl.members), declared: false };
}

/**
 * Refuse a record write outside the writer's scope (#2548): throws a
 * {@link WriteScopeError}. `agent` is the session the write names
 * (`CHANT_AGENT`), and `principal` who the write names as its author.
 */
export function refuseRecordWrite(
  cwd: string,
  write: { kindName: string; kindFile: string; recordsDir: string; verb: WriteVerb; agent?: string | null; principal?: string | null },
): void {
  const source = scopeSource(cwd);
  if (source.declaration === null && (write.agent === undefined || write.agent === null)) return;
  const writer = resolveWriter(source.declaration, source.policy, { agent: write.agent, principal: write.principal });
  const verdict = judgeRecord(source.declaration, writer, scopedKind(source, write.kindName, write.kindFile, write.recordsDir), write.verb);
  if (!verdict.ok) throw new WriteScopeError(verdict.code, verdict.message);
}

// ── The check over a range ───────────────────────────────────────────────────

/** A commit as the scope check judged it. */
export interface ScopeCommit {
  commit: string;
  subject: string;
  /** The attested principal, or the author's email when the commit is not attested. */
  principal: string;
  /** Whether the principal is a signer the policy at base attests, or only the author the commit claims. */
  attested: boolean;
  class: PrincipalClass;
  /** The agent session, from the Chant-Agent trailer or the principal, or null. */
  agent: string | null;
  /** Paths in the workspace the commit writes. */
  paths: number;
}

export interface ScopeFinding {
  /** `finding:<code>:<commit>:<path>`, or `finding:agent-unknown:<commit>`. */
  id: string;
  code: WriteScopeCode;
  commit: string;
  /** From the workspace root, or null for a finding on the whole commit. */
  path: string | null;
  principal: string;
  class: PrincipalClass;
  agent: string | null;
  /** For a record file: how it was written, as the records commands name it, or delete. */
  verb: WriteVerb | "delete" | null;
  message: string;
}

export interface ScopeReport {
  /** The commit the declaration and the trust policy were read at. */
  base: string;
  /** The classes with a writeScope entry, and agent when any session is declared. */
  restricted: PrincipalClass[];
  agents: string[];
  commits: ScopeCommit[];
  findings: ScopeFinding[];
}

/** A record kind the check knows, to tell a record file from another path. */
export interface CheckKind {
  scoped: ScopedKind;
  /** The records directory, from the repository root. */
  dir: string;
  match: RegExp;
  /** The reviews field, when the kind has one; the verdicts field of a session kind. */
  reviewFields: string[];
  /** The state field and closed states of a session kind, for telling a close. */
  session: { stateField: string; closed: string[]; fills: string[] } | null;
  format: string;
}

function git(top: string, args: string[]): string {
  return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
}

function show(top: string, rev: string, path: string): string | null {
  try {
    return git(top, ["show", `${rev}:${path}`]);
  } catch {
    return null;
  }
}

/** How a commit wrote a record file it modified: review when only the reviews (or a session's verdicts) changed, close when a session moved into a closed state, else amend. */
function modifiedVerb(top: string, commit: string, path: string, kind: CheckKind): WriteVerb {
  if (kind.format !== "markdown-front-matter") return "amend";
  const before = show(top, `${commit}^`, path);
  const after = show(top, commit, path);
  if (before === null || after === null) return "amend";
  const a = parseFrontMatter(before);
  const b = parseFrontMatter(after);
  if (!a.ok || !b.ok) return "amend";
  const keys = new Set([...Object.keys(a.value), ...Object.keys(b.value)]);
  const changed = [...keys].filter((k) => JSON.stringify(a.value[k]) !== JSON.stringify(b.value[k]));
  if (kind.session) {
    const state = b.value[kind.session.stateField];
    if (typeof state === "string" && kind.session.closed.includes(state) && a.value[kind.session.stateField] !== state) return "close";
    if (changed.every((k) => kind.reviewFields.includes(k) || kind.session!.fills.includes(k))) return "review";
    return "amend";
  }
  return changed.length > 0 && changed.every((k) => kind.reviewFields.includes(k)) ? "review" : "amend";
}

/**
 * Judge every commit in `base..head` against the write scope the declaration
 * at `base` gives (#2548). Returns null when that declaration restricts no
 * one: no writeScope block and no agent session. Merges are skipped; the
 * commits they bring are judged instead.
 */
export async function checkWriteScope(q: {
  top: string;
  base: string;
  head: string;
  /** The workspace root from the repository root, "" for the top. */
  prefix: string;
  declaration: Declaration;
  kinds: CheckKind[];
}): Promise<ScopeReport | null> {
  const { top, base, head, prefix, declaration } = q;
  if (declaration.writeScope === null && declaration.agents.length === 0) return null;
  const policy = policyAtBase(top, { commit: base, from: "flag" });
  const { activeAttestors } = await import("./trust/attestor");
  const attestors = await activeAttestors();
  const restricted = PRINCIPAL_CLASSES.filter((c) => declaration.writeScope?.[c] !== undefined || (c === "agent" && declaration.agents.length > 0));
  const report: ScopeReport = { base, restricted, agents: declaration.agents.map((a) => a.name), commits: [], findings: [] };
  const list = git(top, ["rev-list", "--reverse", "--no-merges", `${base}..${head}`]).split("\n").filter(Boolean);
  for (const commit of list) {
    const [subject, email, trailers] = git(top, ["log", "-1", `--format=%s%x00%ae%x00%(trailers:key=${AGENT_TRAILER},valueonly,separator=%x01)`, commit]).split("\0");
    const named = (trailers ?? "").split("\x01").map((s) => s.trim()).filter(Boolean)[0] ?? null;
    const prov = policy.active ? commitProvenance(top, policy, commit, attestors) : null;
    const attested = prov?.level === "attested" && prov.principal !== undefined;
    const principal = attested ? prov!.principal! : email.trim();
    const changed = git(top, ["diff-tree", "--no-commit-id", "-r", "--name-status", "--no-renames", "-z", commit])
      .split("\0")
      .filter(Boolean);
    const paths: { status: string; path: string }[] = [];
    for (let i = 0; i + 1 < changed.length; i += 2) {
      const full = changed[i + 1];
      if (prefix !== "" && !full.startsWith(`${prefix}/`)) continue;
      paths.push({ status: changed[i], path: full });
    }
    let writer: Writer;
    try {
      writer = resolveWriter(declaration, policy, { agent: named, principal });
    } catch (err) {
      if (!(err instanceof WriteScopeError)) throw err;
      report.commits.push({ commit, subject, principal, attested, class: "agent", agent: named, paths: paths.length });
      report.findings.push({ id: `finding:${err.code}:${commit}`, code: err.code, commit, path: null, principal, class: "agent", agent: named, verb: null, message: `${commit.slice(0, 8)} has ${AGENT_TRAILER}: ${named}: ${err.message}` });
      continue;
    }
    report.commits.push({ commit, subject, principal, attested, class: writer.class, agent: writer.agent?.name ?? null, paths: paths.length });
    if (scopeOf(declaration, writer) === null) continue;
    for (const p of paths) {
      const inWorkspace = prefix === "" ? p.path : p.path.slice(prefix.length + 1);
      const kind = q.kinds.find((k) => posix.dirname(p.path) === k.dir && k.match.test(posix.basename(p.path)));
      let verb: WriteVerb | "delete" | null = null;
      let verdict: ScopeVerdict;
      if (kind) {
        verb = p.status === "A" ? "new" : p.status === "D" ? "delete" : modifiedVerb(top, commit, p.path, kind);
        verdict = judgeRecord(declaration, writer, kind.scoped, verb);
      } else {
        verdict = judgePath(declaration, writer, inWorkspace);
      }
      if (verdict.ok) continue;
      report.findings.push({
        id: `finding:${verdict.code}:${commit}:${inWorkspace}`,
        code: verdict.code,
        commit,
        path: inWorkspace,
        principal,
        class: writer.class,
        agent: writer.agent?.name ?? null,
        verb,
        message: `${commit.slice(0, 8)} ${p.status === "D" ? "deletes" : p.status === "A" ? "adds" : "changes"} ${inWorkspace}: ${verdict.message}`,
      });
    }
  }
  return report;
}
