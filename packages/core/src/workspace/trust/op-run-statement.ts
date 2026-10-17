/**
 * The Op-run statement (#4044): a runner's signed word that an Op ran on a
 * commit and settled as its run record says.
 *
 * `chant ci tick` can take chant's own Op runs as its status source in place
 * of a forge's check runs (`ci.green.source: "runs"`), so a project whose
 * pipelines run as chant Ops gets green and revoked tags with no forge check
 * runs. The run ledger on `chant/lifecycle` is written by whatever ran the
 * Op, so the tick counts a run only when its record carries a statement
 * signed by a runner key, the same keys and role a ci tag needs (#4031):
 * `.chant/trust.json` at base lists the key under `runners`, and its
 * principal holds the `runner` role there. A key the signers file lists is
 * never a runner key (./policy.ts).
 *
 * The statement is an in-toto Statement v1 in a DSSE envelope (./dsse.ts),
 * as runner evidence (#2553), the agent-run statement (#3192) and the ci tag
 * statement (#4031) are:
 *
 * - `subject`: the commit the run built from (`gitSha`), by `digest.gitCommit`.
 * - `predicate`: the signer's principal, and the run's id, Op, env, status
 *   and the SHA-256 of its record without the statement.
 *
 * The runner signs at the end of the run when it is given a key
 * (`chant run <op> --key <file>` or `CHANT_RUNNER_KEY`), and the envelope is
 * stored on the record itself as `statement`, so the record and its
 * signature are one ledger line. Verifying needs the record and the runner
 * keys at base, so it works offline, and every read verifies again.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../effect-receipt";
import type { OpRunRecord } from "../../op/runtime";
import { IN_TOTO_PAYLOAD_TYPE, signEnvelope, verifyEnvelope, type DsseEnvelope } from "./dsse";
import { STATEMENT_TYPE } from "./evidence";
import { CI_TAG_SIGNER_ROLE, type CiTagFailure, type CiTagSigner } from "./ci-tag-statement";
import type { RunnerKey } from "./policy";

export const OP_RUN_PREDICATE = "https://intentius.io/chant/op-run/v1";

const fullCommit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const text = z.string().min(1);

/** The statement a runner signs for an Op run. Strict, so a verifier never acts on a field it does not know. */
export const opRunStatementSchema = z
  .object({
    _type: z.literal(STATEMENT_TYPE),
    subject: z
      .array(
        z
          .object({ name: fullCommit, digest: z.object({ gitCommit: fullCommit }).strict() })
          .strict()
          .refine((s) => s.name === s.digest.gitCommit, "a commit subject is named by its own id"),
      )
      .length(1),
    predicateType: z.literal(OP_RUN_PREDICATE),
    predicate: z
      .object({
        signer: text,
        run: z
          .object({
            id: text,
            op: text,
            env: text,
            status: z.enum(["ok", "fail", "gated", "waiting"]),
            record: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type OpRunStatement = z.infer<typeof opRunStatementSchema>;

/**
 * The SHA-256 of a run record: the canonical JSON (keys sorted, no
 * whitespace) of the record without its `statement`, so storing the
 * statement never changes the hash it signs.
 */
export function opRunRecordDigest(record: OpRunRecord): string {
  const { statement: _statement, ...rest } = record;
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

/** The statement for a settled run, as `signer` would sign it. Throws for a run that knew no commit. */
export function buildOpRunStatement(record: OpRunRecord, signer: string): OpRunStatement {
  const sha = record.gitSha;
  if (!sha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new Error(`run ${record.id} of ${record.op} names no full commit sha, so there is no commit for its statement to sign`);
  }
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: sha, digest: { gitCommit: sha } }],
    predicateType: OP_RUN_PREDICATE,
    predicate: { signer, run: { id: record.id, op: record.op, env: record.env, status: record.status, record: { sha256: opRunRecordDigest(record) } } },
  };
}

/** The envelope a run record carries as `statement`, signed by `signer`. */
export function signOpRunRecord(record: OpRunRecord, signer: CiTagSigner): DsseEnvelope {
  const statement = buildOpRunStatement(record, signer.principal);
  return signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonicalJson(statement), "utf8"), signer.key, signer.publicKey);
}

/** One run record judged: signed by a runner holding the `runner` role, or why not, in the words a ci tag uses. */
export type OpRunVerdict = { status: "signed"; signer: string; keyid: string; reason: string } | { status: CiTagFailure; reason: string };

const normalise = (name: string): string => name.normalize("NFKC").trim().toLowerCase();

/**
 * Verify the statement a run record carries against the runner keys and
 * roles at base: a signature by a runner key whose principal holds the
 * `runner` role, over a statement for this run, its commit and its record as
 * the ledger holds it. Never throws.
 */
export function verifyOpRunStatement(record: OpRunRecord, runners: readonly RunnerKey[], roles: Readonly<Record<string, readonly string[]>>): OpRunVerdict {
  const run = `run ${record.id} of ${record.op}`;
  if (record.statement === undefined) return { status: "unsigned", reason: `${run} carries no statement signed by a runner key` };
  const v = verifyEnvelope(record.statement, runners);
  if (!v.ok) return { status: v.code === "envelope-untrusted" ? "untrusted" : "invalid", reason: `${run}: ${v.reason}` };
  if (!(roles[CI_TAG_SIGNER_ROLE] ?? []).some((p) => normalise(p) === normalise(v.principal))) {
    return { status: "untrusted", reason: `${run} is signed by ${v.principal}'s runner key, and ${v.principal} holds no ${CI_TAG_SIGNER_ROLE} role in .chant/trust.json at base` };
  }
  if (v.payloadType !== IN_TOTO_PAYLOAD_TYPE) return { status: "invalid", reason: `${run}: payload type ${v.payloadType} is not ${IN_TOTO_PAYLOAD_TYPE}` };
  let raw: unknown;
  try {
    raw = JSON.parse(v.payload.toString("utf8"));
  } catch {
    return { status: "invalid", reason: `${run}: the statement's payload is not JSON` };
  }
  const parsed = opRunStatementSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ");
    return { status: "invalid", reason: `${run}: the payload is not a ${OP_RUN_PREDICATE} statement: ${detail}` };
  }
  const p = parsed.data.predicate;
  if (p.signer !== v.principal) return { status: "invalid", reason: `${run}: the statement names signer ${JSON.stringify(p.signer)}, but ${v.principal}'s key signed it` };
  const differs: string[] = [];
  if (parsed.data.subject[0]!.name !== record.gitSha) differs.push(`it is for commit ${parsed.data.subject[0]!.name.slice(0, 12)}, and the record names ${record.gitSha ? record.gitSha.slice(0, 12) : "none"}`);
  if (p.run.id !== record.id) differs.push(`it is for run ${p.run.id}`);
  if (p.run.op !== record.op) differs.push(`it is for Op ${p.run.op}`);
  if (p.run.env !== record.env) differs.push(`it is for env ${p.run.env}`);
  if (p.run.status !== record.status) differs.push(`it says ${p.run.status}, and the record says ${record.status}`);
  const digest = opRunRecordDigest(record);
  if (p.run.record.sha256 !== digest) differs.push(`the record hashed ${p.run.record.sha256.slice(0, 12)} when signed and ${digest.slice(0, 12)} now`);
  if (differs.length > 0) return { status: "mismatch", reason: `${run} is signed by ${v.principal}, but the statement does not match its record: ${differs.join("; ")}` };
  return { status: "signed", signer: v.principal, keyid: v.keyid, reason: `signed by ${v.principal} (${CI_TAG_SIGNER_ROLE})` };
}
