/**
 * A rejection of a release at a gate (#5354): `chant reject <op> <gate>`
 * writes one line to `_gates/<op>/rejected.jsonl` on `chant/lifecycle`,
 * bound to the digest the gate waits on (a release's digest at a stage's
 * gate) and to the release, with who rejected it and why.
 *
 * The file sits in a directory under `_gates/`, beside `applied.jsonl`, so
 * a reader of `_gates/<op>.jsonl` that predates rejections never reads one
 * as an approval.
 *
 * A rejection takes the proof rules an approval takes. Its seal signs
 * {@link gateRejectionPayload} in the {@link GATE_REJECTION_NAMESPACE}
 * namespace, so an approval's seal can never stand in for a rejection's or
 * the other way round. Whether a rejection counts at a gate is decided by
 * `../op/gate-reject.ts`.
 *
 * Pure: no git, no clock, no file.
 */

import type { GateApprover } from "../op/gate-approval";
import type { GateOrigin } from "./gate-origin";
import type { GateApprovalSeal } from "./gate-ledger";
import { checkGateSignature, unlistedWhat, unlistedWhere, type GateSignerKeys } from "./gate-seal";

/** The ssh signature namespace of a rejection's seal (#5354), apart from an approval's `chant-gate`. */
export const GATE_REJECTION_NAMESPACE = "chant-gate-reject";

/** One rejection of the digest a gate waits on. */
export interface GateRejectionRecord {
  version: 1;
  kind: "rejection";
  op: string;
  gate: string;
  /** Who rejected it: an actor name, as `chant approve` records `resolvedBy`. */
  rejectedBy: string;
  /** Why, on one line. Required: the run that stops on it says why. */
  reason: string;
  timestamp: string;
  /** The digest rejected: at a stage's gate, the release's digest. */
  planDigest?: string;
  /** The environment the gate is for, copied off the pending fact it answers. */
  environment?: string;
  /** The release rejected, copied off the pending fact it answers, or named with `--release`. */
  releaseDigest?: string;
  /** The address the rejection was made at, such as a pull request or a review thread. */
  url?: string;
  /** A person or an agent. Only a person's rejection counts, as only a person's approval counts toward a quorum. */
  approver?: GateApprover;
  /** The channel it was recorded on. */
  origin?: GateOrigin;
  /** The commit the gate was waiting on, off the pending fact. */
  gitSha?: string;
  /** An ssh signature or a passkey's assertion over {@link gateRejectionPayload} by `rejectedBy`. */
  seal?: GateApprovalSeal;
}

/** Where a gate's rejections are kept: `_gates/<op>/rejected.jsonl`. */
export function gateRejectionPath(op: string): { dir: string; file: string } {
  return { dir: `_gates/${op}`, file: "rejected.jsonl" };
}

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The rejection lines of a `rejected.jsonl` file, oldest first. A line that is not one is skipped. */
export function parseGateRejections(text: string): GateRejectionRecord[] {
  const out: GateRejectionRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<GateRejectionRecord>;
      if (r.version !== 1 || r.kind !== "rejection" || !isText(r.op) || !isText(r.gate) || !isText(r.rejectedBy) || !isText(r.reason) || !isText(r.timestamp)) continue;
      if (Number.isNaN(Date.parse(r.timestamp))) continue;
      if ([r.planDigest, r.environment, r.releaseDigest].some((v) => v !== undefined && typeof v !== "string")) continue;
      out.push(r as GateRejectionRecord);
    } catch {
      // Not a line this reads.
    }
  }
  return out;
}

/** What is wrong with a rejection's reason, or null: it is one line of printable text. */
export function rejectionReasonProblem(reason: string | undefined): string | null {
  if (reason === undefined || reason.trim() === "") return "a rejection says why: --reason <text>";
  if (/[\r\n\u2028\u2029]/.test(reason)) return "--reason is one line";
  if (/[\u0000-\u001f\u007f]/.test(reason)) return "--reason is printable text";
  return null;
}

/** The fields a rejection's seal covers. */
export type SealedGateRejection = Pick<GateRejectionRecord, "op" | "gate" | "environment" | "planDigest" | "releaseDigest" | "rejectedBy" | "timestamp" | "reason">;

/**
 * The bytes a rejection's seal signs (#5354): a first line `chant-reject`,
 * then the op, the gate, the environment, the digest, the release, who
 * rejected it, the time and the reason, joined by LF with no final newline.
 * An absent field signs an empty line. Its first line and its namespace
 * keep it apart from an approval's payload (`gateSealPayload`).
 */
export function gateRejectionPayload(r: SealedGateRejection): Buffer {
  return Buffer.from(
    ["chant-reject", r.op, r.gate, r.environment ?? "", r.planDigest ?? "", r.releaseDigest ?? "", r.rejectedBy, r.timestamp, r.reason].join("\n"),
    "utf-8",
  );
}

const normalise = (name: string): string => name.normalize("NFKC").trim().toLowerCase();

/**
 * Why a rejection's seal does not prove who rejected, or null when it does
 * (#5354): it verifies for `rejectedBy` over {@link gateRejectionPayload}
 * in the rejection namespace, against a key the signers file at base lists
 * for them or a passkey `.chant/trust.json` lists. The check an approval's
 * seal takes (`gateSealRefusal`), over the rejection's own bytes.
 */
export function rejectionSealRefusal(signers: GateSignerKeys & { signersPath: string; active: boolean }, r: GateRejectionRecord): string | null {
  const what = `the rejection at gate ${r.gate} by ${r.rejectedBy}`;
  if (!signers.active) return `there is no signers file (${signers.signersPath}) at base, so no seal proves ${r.rejectedBy}`;
  if (r.seal === undefined || r.seal === null) return `${what} is not signed`;
  const seal = r.seal as unknown as { signer?: unknown; signature?: unknown };
  if (typeof seal !== "object" || Array.isArray(seal) || typeof seal.signer !== "string" || typeof seal.signature !== "string") return `the seal on ${what} is malformed: it needs signer and signature`;
  if (normalise(seal.signer) !== normalise(r.rejectedBy)) return `the seal on ${what} is by ${seal.signer}`;
  const check = checkGateSignature(signers, r.rejectedBy, seal as { signature: string } & Record<string, unknown>, gateRejectionPayload(r), GATE_REJECTION_NAMESPACE);
  if (check.ok) return null;
  const where = `${signers.signersPath} at base`;
  return check.unlisted ? `${r.rejectedBy} has no ${unlistedWhat(seal)} in ${unlistedWhere(seal, where)}, so the seal can't count` : `the seal does not verify for ${r.rejectedBy} against ${where}: ${check.reason}`;
}
