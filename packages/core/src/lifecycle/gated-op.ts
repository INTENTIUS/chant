/**
 * One gated operation outside op waves (#4762): ask for a gated request
 * (#4551), spend its approval, act, and record how it ended. The walk every
 * engine's state operation shares: a Terraform root's export or lock
 * release, a Pulumi stack's, a migration whose request carries its proof.
 *
 * It came from the terraform lexicon's `state-ops.ts` (#4618), which still
 * exports it as `gatedStateOp`, so a product written against the lexicon
 * keeps working.
 *
 * A request asked again binds the same digest: chant's digest covers the
 * request's `at`, so {@link requestedAt} reuses the `at` of the newest
 * standing, unspent request with the same kind, subject, requester and
 * fields. The spend is pushed before `act` runs, so no approval acts twice.
 */
import { createHash } from "node:crypto";
import {
  finishGatedRequest,
  readGatedRequests,
  requestGate,
  spendGatedRequest,
  type GatedRequest,
  type GatedRequestRules,
  type RequestGateInput,
  type RequestGateResult,
} from "./gated-request";

/** The gated-request ledger, injectable for tests. Default chant's on `chant/lifecycle`. */
export interface GatedRequestLedger {
  requestGate: typeof requestGate;
  spendGatedRequest: typeof spendGatedRequest;
  finishGatedRequest: typeof finishGatedRequest;
  readGatedRequests: typeof readGatedRequests;
}

/** chant's ledger on `chant/lifecycle`. */
export const chantGatedLedger: GatedRequestLedger = { requestGate, spendGatedRequest, finishGatedRequest, readGatedRequests };

/**
 * The time a request was first asked, so asking again binds the same
 * digest. The newest standing, unspent request with the same kind, subject,
 * requester and fields gives its `at`; with none, `now`. With `reuseApplied`
 * (#4808) a request that applied already counts too, so the same call asked
 * again answers `spent` rather than asking anew: a retried job never acts
 * twice on one approval.
 */
export async function requestedAt(
  op: string,
  request: Omit<GatedRequest, "at">,
  options: { now?: string; cwd?: string; ledger?: Pick<GatedRequestLedger, "readGatedRequests">; reuseApplied?: boolean } = {},
): Promise<string> {
  const now = options.now ?? new Date().toISOString();
  const read = await (options.ledger ?? chantGatedLedger).readGatedRequests(op, options.cwd ? { cwd: options.cwd } : undefined).catch(() => []);
  const same = JSON.stringify(Object.entries(request.fields).sort());
  const standing = read
    .filter((g) => (options.reuseApplied || !g.applied) && g.request.kind === request.kind && g.request.subject === request.subject && g.request.by === request.by)
    .filter((g) => JSON.stringify(Object.entries(g.request.fields).sort()) === same)
    .filter((g) => g.applied || !g.pending.expiresAt || g.pending.expiresAt > now)
    .at(-1);
  return standing?.request.at ?? now;
}

/** The digest `requestGate` puts in `fields.proof` for an attachment. */
export const attachmentDigest = (attachment: string): string => `sha256:${createHash("sha256").update(attachment).digest("hex")}`;

export interface GatedOpInput {
  op: string;
  /** The request, less `at`, which {@link requestedAt} fills. */
  request: Omit<GatedRequest, "at"> & { at?: string };
  rules: GatedRequestRules;
  description?: string;
  expiry?: string;
  base?: string;
  /** A document the request carries, such as a migration's proof; its digest joins the request. */
  attachment?: string;
  /** Reuse the `at` of a request with the same fields that applied already, so the call answers `spent` ({@link requestedAt}, #4808). */
  reuseApplied?: boolean;
  cwd?: string;
  now?: string;
  runId?: string;
  commit?: string;
  ledger?: GatedRequestLedger;
  gates?: RequestGateInput["gates"];
  /**
   * A last check just before the spend, for a fact that can change while the
   * request waited (a run that may hold the lock came back). A string refuses
   * the operation with that reason, and the approval is not spent.
   */
  beforeSpend?: () => Promise<string | undefined>;
  /** The flat facts of a failed act's finished line, beside its `error`, such as the binary's exit code and last lines. */
  failedDetail?: (error: Error) => Record<string, string | number | boolean>;
}

/** How a gated operation ended. Only `done` and `failed` acted. */
export type GatedOpResult<T> =
  | Exclude<RequestGateResult, { status: "approved" }>
  | { status: "held"; digest: string; request: GatedRequest; reason: string }
  | { status: "done"; digest: string; request: GatedRequest; approvedBy: string; output: T; recorded: boolean }
  | { status: "failed"; digest: string; request: GatedRequest; approvedBy: string; error: Error; recorded: boolean };

/**
 * What an approved operation's act returns: its output, and the flat facts
 * its finished line records. `failed` records the finished line as failed
 * while the output still comes back, for an act that ran and did not succeed
 * (a migration whose write left a change).
 */
export type GatedOpAct<T> = (approved: { digest: string; request: GatedRequest; approvedBy: string }) => Promise<{ output: T; detail?: Record<string, string | number | boolean>; failed?: boolean }>;

/**
 * Run `act` once its request is approved: ask (or read) the request, spend
 * the approval, act, and record how it ended. A spend that cannot be pushed
 * throws before `act` runs. A finished line that cannot be written is
 * reported as `recorded: false`; the act already ran.
 */
export async function gatedOp<T>(input: GatedOpInput, act: GatedOpAct<T>): Promise<GatedOpResult<T>> {
  const ledger = input.ledger ?? chantGatedLedger;
  // The proof's digest is a field of the stored request, so the standing request is matched with it.
  const fields = input.attachment !== undefined ? { ...input.request.fields, proof: attachmentDigest(input.attachment) } : input.request.fields;
  const at = input.request.at ?? (await requestedAt(input.op, { ...input.request, fields }, { ...(input.now ? { now: input.now } : {}), ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.reuseApplied ? { reuseApplied: true } : {}), ledger }));
  const request: GatedRequest = { kind: input.request.kind, subject: input.request.subject, by: input.request.by, at, fields };
  const asked = await ledger.requestGate({
    op: input.op,
    request,
    rules: input.rules,
    ...(input.description ? { description: input.description } : {}),
    ...(input.expiry ? { expiry: input.expiry } : {}),
    ...(input.base ? { base: input.base } : {}),
    ...(input.attachment !== undefined ? { attachment: input.attachment } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.gates ? { gates: input.gates } : {}),
  });
  if (asked.status !== "approved") return asked;
  const { digest } = asked;
  const approvedBy = asked.approval.resolvedBy;
  const held = await input.beforeSpend?.();
  if (held) return { status: "held", digest, request: asked.request, reason: held };
  const spent = await ledger.spendGatedRequest({
    op: input.op,
    gate: request.subject,
    digest,
    approval: asked.approval,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const finish = async (result: "applied" | "failed", detail?: Record<string, string | number | boolean>): Promise<boolean> => {
    try {
      const f = await ledger.finishGatedRequest({ op: input.op, gate: request.subject, digest, applied: spent.timestamp, result, ...(detail ? { detail } : {}), ...(input.cwd ? { cwd: input.cwd } : {}) });
      return f.pushed;
    } catch {
      return false;
    }
  };
  try {
    const { output, detail, failed } = await act({ digest, request: asked.request, approvedBy });
    return { status: "done", digest, request: asked.request, approvedBy, output, recorded: await finish(failed ? "failed" : "applied", detail) };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { status: "failed", digest, request: asked.request, approvedBy, error, recorded: await finish("failed", { ...(input.failedDetail?.(error) ?? {}), error: error.message.slice(0, 400) }) };
  }
}
