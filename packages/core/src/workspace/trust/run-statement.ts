/**
 * The agent-run statement (#3192, ws-090): a runner's or steward's signed
 * word that an agent run happened as its record says.
 *
 * The run record (#3033, ws-076) is written by whatever ran the agent, so on
 * its own it is as trustworthy as that writer. A statement is an in-toto
 * Statement v1 in a DSSE envelope (./dsse.ts), signed with an Ed25519 key the
 * trust policy at base lists under `runners` in `.chant/trust.json`, the same
 * keys runner evidence uses (#2553, ws-069). A person's key, one the signers
 * file lists, is never a runner key.
 *
 * - `subject`: each commit the run made, by its id (`digest.gitCommit`), with
 *   its `git patch-id --stable` as an annotation when it has a patch.
 * - `predicate`: the signer's principal, the run's id and the SHA-256 of its
 *   record (the start and end lines), the work item, the harness, the model
 *   and provider, and the principal the run worked for (studio-036 b).
 *
 * The statement is stored as a run-ledger fact: a `statement` line in the
 * run's own file on `chant/lifecycle`, after its end. Verifying needs only
 * the envelope, the run's record and the runner keys at base, so it works
 * offline, and a verifier re-checks every stored statement rather than
 * trusting that it was checked when written.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../effect-receipt";
import type { ReasonCode } from "../reason-codes";
import type { RunEndLine, RunStartLine, RunView } from "../runs";
import { IN_TOTO_PAYLOAD_TYPE, signEnvelope, verifyEnvelope, type DsseEnvelope } from "./dsse";
import { STATEMENT_TYPE } from "./evidence";
import type { KeyObject } from "node:crypto";
import type { RunnerKey } from "./policy";

export const AGENT_RUN_PREDICATE = "https://intentius.io/chant/agent-run/v1";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const fullCommit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const patchId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const text = z.string().min(1);

/** The statement a runner signs for a run. Strict, so a verifier never acts on a field it does not know. */
export const runStatementSchema = z
  .object({
    _type: z.literal(STATEMENT_TYPE),
    subject: z.array(
      z
        .object({
          name: fullCommit,
          digest: z.object({ gitCommit: fullCommit }).strict(),
          annotations: z.object({ patchId }).strict().optional(),
        })
        .strict()
        .refine((s) => s.name === s.digest.gitCommit, "a commit subject is named by its own id"),
    ),
    predicateType: z.literal(AGENT_RUN_PREDICATE),
    predicate: z
      .object({
        signer: text,
        run: z.object({ id: text, record: z.object({ sha256: sha256Hex }).strict() }).strict(),
        unit: z.object({ id: text, kind: text.nullable() }).strict().nullable(),
        harness: z.object({ name: text, version: text.nullable() }).strict(),
        model: text.nullable(),
        provider: text.nullable(),
        by: text.nullable(),
      })
      .strict(),
  })
  .strict();
export type RunStatement = z.infer<typeof runStatementSchema>;

/**
 * The SHA-256 of a run's record: the canonical JSON (keys sorted, no
 * whitespace) of the array `[start line, end line]` as the ledger holds them.
 * Statement lines are not part of it, so storing a statement never changes
 * the hash it signs.
 */
export function runRecordDigest(start: RunStartLine, end: RunEndLine): string {
  return createHash("sha256").update(canonicalJson([start, end]), "utf8").digest("hex");
}

/** The statement for an ended run, as `signer` would sign it. The run's commits are its subjects, sorted by id. */
export function buildRunStatement(run: RunView, signer: string): RunStatement {
  if (!run.record) throw new Error(`agent run ${run.id} has not ended, so it has no record to sign`);
  const commits = [...new Map(run.commits.map((c) => [c.sha, c])).values()].sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  return {
    _type: STATEMENT_TYPE,
    subject: commits.map((c) => ({ name: c.sha, digest: { gitCommit: c.sha }, ...(c.patchId ? { annotations: { patchId: c.patchId } } : {}) })),
    predicateType: AGENT_RUN_PREDICATE,
    predicate: {
      signer,
      run: { id: run.id, record: { sha256: run.record.sha256 } },
      unit: run.unit ? { id: run.unit.id, kind: run.unit.kind } : null,
      harness: { name: run.harness.name, version: run.harness.version },
      model: run.model,
      provider: run.provider,
      by: run.by,
    },
  };
}

/** The payload bytes a signer signs: the statement's canonical JSON. Any serialization verifies; this one is reproducible. */
export function runStatementPayload(statement: RunStatement): Buffer {
  return Buffer.from(canonicalJson(statement), "utf8");
}

export function signRunStatement(statement: RunStatement, key: KeyObject, publicKey: string): DsseEnvelope {
  return signEnvelope(IN_TOTO_PAYLOAD_TYPE, runStatementPayload(statement), key, publicKey);
}

// ── Verifying ────────────────────────────────────────────────────────────────

/**
 * Why a stored statement does not verify. Each is in `reason-codes.ts`.
 * `envelope-invalid` and `envelope-untrusted` are runner evidence's codes:
 * the envelope is the same, and so is the rule for its keys.
 */
export const RUN_STATEMENT_FAILURE_CODES = ["envelope-invalid", "envelope-untrusted", "run-statement-invalid", "run-statement-signer-mismatch", "run-statement-mismatch"] as const satisfies readonly ReasonCode[];
export type RunStatementFailureCode = (typeof RUN_STATEMENT_FAILURE_CODES)[number];

/** One stored statement, judged against the runner keys at base and the run's record. */
export type RunStatementVerdict =
  | { status: "verified"; signer: string; class: RunnerKey["class"]; keyid: string; statement: RunStatement; reason: string }
  | {
      status: "mismatch" | "untrusted" | "invalid";
      code: RunStatementFailureCode;
      reason: string;
      /** Set when a listed runner key signed it, so the failure is in what it says. */
      signer?: string;
      class?: RunnerKey["class"];
      keyid?: string;
    };

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * Verify one envelope for `run`: a signature by a runner key at base, a
 * well-formed statement whose signer is that key's principal, for this run,
 * and agreeing with its record. Never throws.
 */
export function verifyRunStatement(envelope: unknown, runners: readonly RunnerKey[], run: RunView): RunStatementVerdict {
  const v = verifyEnvelope(envelope, runners);
  if (!v.ok) return { status: v.code === "envelope-untrusted" ? "untrusted" : "invalid", code: v.code, reason: v.reason };
  const runner = runners.find((r) => r.principal === v.principal)!;
  const signed = { signer: v.principal, class: runner.class, keyid: v.keyid };
  if (v.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    return { status: "invalid", code: "run-statement-invalid", reason: `payload type ${v.payloadType} is not ${IN_TOTO_PAYLOAD_TYPE}`, ...signed };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(v.payload.toString("utf8"));
  } catch {
    return { status: "invalid", code: "run-statement-invalid", reason: "the payload is not JSON", ...signed };
  }
  const parsed = runStatementSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ");
    return { status: "invalid", code: "run-statement-invalid", reason: `the payload is not a ${AGENT_RUN_PREDICATE} statement: ${detail}`, ...signed };
  }
  const statement = parsed.data;
  const p = statement.predicate;
  // A runner cannot speak for another: the principal inside is the one whose key signed.
  if (p.signer !== v.principal) {
    return { status: "invalid", code: "run-statement-signer-mismatch", reason: `the statement names signer ${JSON.stringify(p.signer)}, but ${v.principal}'s key signed it`, ...signed };
  }
  const differs: string[] = [];
  if (p.run.id !== run.id) differs.push(`it is for run ${p.run.id}`);
  else if (!run.record) differs.push("the run has no end in the ledger");
  else if (p.run.record.sha256 !== run.record.sha256) differs.push(`the record hashed ${p.run.record.sha256.slice(0, 12)} when signed and ${run.record.sha256.slice(0, 12)} now`);
  if (!same(p.unit, run.unit)) differs.push(`unit ${JSON.stringify(p.unit?.id ?? null)}, the record says ${JSON.stringify(run.unit?.id ?? null)}`);
  if (!same(p.harness, run.harness)) differs.push(`harness ${JSON.stringify(p.harness.name)}, the record says ${JSON.stringify(run.harness.name)}`);
  if (p.model !== run.model) differs.push(`model ${JSON.stringify(p.model)}, the record says ${JSON.stringify(run.model)}`);
  if (p.provider !== run.provider) differs.push(`provider ${JSON.stringify(p.provider)}, the record says ${JSON.stringify(run.provider)}`);
  if (p.by !== run.by) differs.push(`by ${JSON.stringify(p.by)}, the record says ${JSON.stringify(run.by)}`);
  if (differs.length > 0) {
    return { status: "mismatch", code: "run-statement-mismatch", reason: `signed by ${v.principal}, but the statement does not match run ${run.id}'s record: ${differs.join("; ")}`, ...signed };
  }
  const n = statement.subject.length;
  return { status: "verified", ...signed, statement, reason: `signed by ${v.principal} (${runner.class}) over the run's record and ${n} commit${n === 1 ? "" : "s"}` };
}

/** A run's attestation: its best statement, or why it has none. */
export interface RunAttestation {
  /**
   * `signed`: a statement verifies. `unsigned`: the ledger holds none.
   * Otherwise the best failure among the stored statements, `mismatch`
   * before `untrusted` before `invalid`.
   */
  status: "signed" | "unsigned" | "mismatch" | "untrusted" | "invalid";
  signer: string | null;
  class: RunnerKey["class"] | null;
  keyid: string | null;
  /** The code of the failure `status` reports, or null when signed or unsigned. */
  code: RunStatementFailureCode | null;
  reason: string;
  /** The commits the verified statement names, sorted. Empty unless signed. */
  commits: string[];
  /** One verdict per stored statement, in ledger order. */
  statements: RunStatementVerdict[];
}

const RANK = { mismatch: 0, untrusted: 1, invalid: 2 } as const;

/** Judge every statement the ledger holds for `run`. */
export function attestRun(run: RunView, runners: readonly RunnerKey[]): RunAttestation {
  const verdicts = run.statements.map((s) => verifyRunStatement(s.envelope, runners, run));
  const good = verdicts.find((v): v is Extract<RunStatementVerdict, { status: "verified" }> => v.status === "verified");
  if (good) {
    return { status: "signed", signer: good.signer, class: good.class, keyid: good.keyid, code: null, reason: good.reason, commits: good.statement.subject.map((s) => s.name), statements: verdicts };
  }
  if (verdicts.length === 0) {
    const reason = run.state === "running" ? "the run has not ended, and a statement is signed over an ended run" : "the ledger holds no statement for this run";
    return { status: "unsigned", signer: null, class: null, keyid: null, code: null, reason, commits: [], statements: verdicts };
  }
  const worst = [...verdicts].sort((a, b) => RANK[a.status as keyof typeof RANK] - RANK[b.status as keyof typeof RANK])[0] as Exclude<RunStatementVerdict, { status: "verified" }>;
  return {
    status: worst.status,
    signer: worst.signer ?? null,
    class: worst.class ?? null,
    keyid: worst.keyid ?? null,
    code: worst.code,
    reason: worst.reason,
    commits: [],
    statements: verdicts,
  };
}
