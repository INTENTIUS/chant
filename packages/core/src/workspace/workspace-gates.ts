/**
 * Workspace gates (#2554, #2524 D17, ws-039).
 *
 * A workspace gate is one approval for a change across members. A run of
 * `chant workspace run --gate <name>` whose member runs stop at their own
 * gates records a pending fact under `_members/_workspace/_gates/<name>.jsonl`
 * that lists each stopped member gate and the plan it waits on (a cover),
 * with the digest of that list. `chant workspace run approve <name>` records
 * an approval of one such digest.
 *
 * The rule (ws-039): a workspace gate never satisfies a member gate, unless
 * both hold:
 *
 * 1. its approval's digest covers the member's plan: the approval lists the
 *    member, the Op, the gate and the plan digest the member run reached it
 *    with, and the list still hashes to the approval's digest;
 * 2. the member opts in at base: its entry in `chant.workspace.json`, read
 *    from the base revision as other policy is, sets
 *    `acceptWorkspaceGates: true`. A declaration read only from the working
 *    tree never opts a member in.
 *
 * A member run started under the gate (`CHANT_WORKSPACE_GATE`) asks this
 * module through `GateCheckInput.workspace` after its own approvals have
 * not passed the gate. Nothing is written to the member's gate ledger: the
 * run's step record says `via: "workspace"` and names the workspace gate.
 */

import { samePlanDigest } from "../lifecycle/plan-digest";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import type { WorkspaceGateStood } from "../op/gate";
import { appendWorkspaceLine, canonicalDigest, readWorkspaceLines, WORKSPACE_GATES_DIR } from "./workspace-ledger";

/** One member gate a workspace gate covers. */
export interface WorkspaceGateCover {
  member: string;
  op: string;
  gate: string;
  planDigest: string;
  /** The member gate's environment, when it is bound to one. */
  environment?: string;
}

export interface WorkspaceGatePending {
  version: 1;
  kind: "pending";
  gate: string;
  /** The workspace run that recorded it. */
  run: string;
  timestamp: string;
  digest: string;
  covers: WorkspaceGateCover[];
}

export interface WorkspaceGateApproval {
  version: 1;
  kind: "approval";
  gate: string;
  digest: string;
  covers: WorkspaceGateCover[];
  approvedBy: string;
  timestamp: string;
  note?: string;
}

export type WorkspaceGateLine = WorkspaceGatePending | WorkspaceGateApproval;

/** Covers in one order, so the same set always has the same digest. */
export function sortCovers(covers: readonly WorkspaceGateCover[]): WorkspaceGateCover[] {
  const key = (c: WorkspaceGateCover) => `${c.member}\u0000${c.op}\u0000${c.gate}\u0000${c.environment ?? ""}\u0000${c.planDigest}`;
  return [...covers]
    .map((c) => ({ member: c.member, op: c.op, gate: c.gate, planDigest: c.planDigest, ...(c.environment !== undefined ? { environment: c.environment } : {}) }))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The digest a workspace gate's pending fact and approval carry: the member plans it covers. */
export function workspaceGateDigest(covers: readonly WorkspaceGateCover[]): string {
  return canonicalDigest(sortCovers(covers));
}

/** What a member gate asks about. */
export interface MemberGateQuery {
  op: string;
  gate: string;
  planDigest: string;
  environment?: string;
}

/**
 * The rule of ws-039, pure: the newest approval that stands in for the
 * member gate `q`, or null. Null whenever the member has not opted in.
 */
export function workspaceGateStandsIn(
  q: MemberGateQuery,
  ctx: { member: string; optedIn: boolean; approvals: readonly WorkspaceGateApproval[] },
): WorkspaceGateApproval | null {
  if (!ctx.optedIn) return null;
  const covering = ctx.approvals.filter(
    (a) =>
      // The covers must still hash to the digest that was approved.
      workspaceGateDigest(a.covers) === a.digest &&
      a.covers.some(
        (c) =>
          c.member === ctx.member && c.op === q.op && c.gate === q.gate &&
          samePlanDigest(c.planDigest, q.planDigest) &&
          (c.environment ?? null) === (q.environment ?? null),
      ),
  );
  return covering.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)).at(-1) ?? null;
}

const fileFor = (gate: string) => `${gate}.jsonl`;

function isCover(v: unknown): v is WorkspaceGateCover {
  const c = v as WorkspaceGateCover;
  return typeof c === "object" && c !== null && typeof c.member === "string" && typeof c.op === "string" && typeof c.gate === "string" && typeof c.planDigest === "string";
}

function isGateLine(v: unknown): v is WorkspaceGateLine {
  const l = v as WorkspaceGateLine;
  if (typeof l !== "object" || l === null || l.version !== 1 || typeof l.gate !== "string" || typeof l.digest !== "string" || typeof l.timestamp !== "string") return false;
  if (!Array.isArray(l.covers) || !l.covers.every(isCover)) return false;
  if (l.kind === "pending") return typeof l.run === "string";
  if (l.kind === "approval") return typeof l.approvedBy === "string";
  return false;
}

/** A workspace gate's ledger, oldest first. */
export async function readWorkspaceGate(cwd: string, gate: string): Promise<{ pending: WorkspaceGatePending[]; approvals: WorkspaceGateApproval[]; malformed: number }> {
  const { records, malformed } = await readWorkspaceLines(cwd, WORKSPACE_GATES_DIR, fileFor(gate), isGateLine);
  return {
    pending: records.filter((r): r is WorkspaceGatePending => r.kind === "pending"),
    approvals: records.filter((r): r is WorkspaceGateApproval => r.kind === "approval"),
    malformed,
  };
}

export async function appendWorkspaceGatePending(cwd: string, input: Omit<WorkspaceGatePending, "version" | "kind" | "digest" | "covers"> & { covers: readonly WorkspaceGateCover[] }): Promise<WorkspaceGatePending> {
  const covers = sortCovers(input.covers);
  const record: WorkspaceGatePending = { version: 1, kind: "pending", gate: input.gate, run: input.run, timestamp: input.timestamp, digest: workspaceGateDigest(covers), covers };
  await appendWorkspaceLine(cwd, WORKSPACE_GATES_DIR, fileFor(input.gate), record, `Workspace gate pending: ${input.gate}`);
  return record;
}

/**
 * Approve a workspace gate's pending fact: the newest one, or the one whose
 * digest is `digest`. The approval copies its covers. Throws when there is no
 * such fact.
 */
export async function approveWorkspaceGate(
  cwd: string,
  input: { gate: string; digest?: string; approvedBy: string; timestamp: string; note?: string },
): Promise<WorkspaceGateApproval> {
  const { pending } = await readWorkspaceGate(cwd, input.gate);
  const candidates = input.digest === undefined ? pending : pending.filter((p) => p.digest === input.digest);
  const fact = candidates.at(-1);
  if (!fact) {
    throw new Error(
      input.digest === undefined
        ? `workspace gate "${input.gate}" has no pending fact to approve; a chant workspace run --gate ${input.gate} whose members stop at their gates records one`
        : `workspace gate "${input.gate}" has no pending fact with digest ${input.digest}`,
    );
  }
  const record: WorkspaceGateApproval = {
    version: 1,
    kind: "approval",
    gate: input.gate,
    digest: fact.digest,
    covers: fact.covers,
    approvedBy: input.approvedBy,
    timestamp: input.timestamp,
    ...(input.note ? { note: input.note } : {}),
  };
  await appendWorkspaceLine(cwd, WORKSPACE_GATES_DIR, fileFor(input.gate), record, `Workspace gate approval: ${input.gate}`);
  return record;
}

/**
 * Whether the member holding `cwd` opts in to workspace gates at base, and
 * its name. A member of a nested workspace, the root member and a directory
 * no member owns never opt in.
 */
export async function memberAcceptsWorkspaceGates(cwd: string): Promise<{ member: string | null; accepts: boolean }> {
  const ledger = await resolveMemberLedger(cwd);
  if (ledger.members.length !== 1) return { member: ledger.members.join("/") || null, accepts: false };
  const member = ledger.members[0]!;
  const { scopeSource } = await import("./write-scope");
  const source = scopeSource(cwd);
  if (source.from !== "base" || !source.declaration) return { member, accepts: false };
  const entry = source.declaration.members.find((m) => m.name === member);
  return { member, accepts: entry?.acceptWorkspaceGates === true };
}

/** The stand-in a member run started under workspace gate `gate` asks (`GateCheckInput.workspace`). */
export async function memberGateStandIn(cwd: string, gate: string, q: MemberGateQuery): Promise<WorkspaceGateStood | null> {
  const { member, accepts } = await memberAcceptsWorkspaceGates(cwd);
  if (!member || !accepts) return null;
  const { approvals } = await readWorkspaceGate(cwd, gate);
  const found = workspaceGateStandsIn(q, { member, optedIn: accepts, approvals });
  return found ? { gate, digest: found.digest, approvedBy: found.approvedBy, timestamp: found.timestamp } : null;
}
