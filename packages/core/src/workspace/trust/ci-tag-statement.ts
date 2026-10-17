/**
 * The statement a ci tag carries (#4031): a runner's signed word that a
 * commit went green, or went red after it was green.
 *
 * `ci/green/<sha>` and `ci/revoked/<sha>` are plain git tags (ws-103), so
 * anyone who may push a tag could make one by hand and go around CI. When the
 * declaration sets `ci.green.signedSince`, a tag on a commit committed at or
 * after that time counts only when its annotation holds a statement signed by
 * a runner key, and readers ignore and report a tag without a valid one.
 *
 * The statement reuses what runner evidence (#2553, ws-069) and the agent-run
 * statement (#3192, ws-090) already use: an in-toto Statement v1 in a DSSE
 * envelope (./dsse.ts), signed with an Ed25519 key that `.chant/trust.json`
 * at base lists under `runners`. The key's principal must also hold the
 * `runner` role there, since a tag says CI ran. A key the signers file lists
 * is never a runner key (./policy.ts).
 *
 * - `subject`: the tagged commit, by `digest.gitCommit`.
 * - `predicate`: the signer's principal and the tag's JSON record as the
 *   annotation holds it (`tag`, `commit`, `branch`, `at`, and the phases'
 *   runs for a green tag or the failed phase and run for a revoked one).
 *
 * The envelope sits in the annotation's JSON record as `statement`, beside
 * the fields it signs, so a reader that does not know it reads the record as
 * before. Verifying needs the tag, the envelope and the runner keys at base,
 * so it works offline, and every read verifies again.
 */

import { z } from "zod";
import { canonicalJson } from "../../effect-receipt";
import { IN_TOTO_PAYLOAD_TYPE, signEnvelope, verifyEnvelope, type DsseEnvelope } from "./dsse";
import { STATEMENT_TYPE } from "./evidence";
import type { KeyObject } from "node:crypto";
import type { RunnerKey } from "./policy";

export const CI_TAG_PREDICATE = "https://intentius.io/chant/ci-tag/v1";

/** The role a tag's signer must hold in `.chant/trust.json` (#4031): the core class `runner`. */
export const CI_TAG_SIGNER_ROLE = "runner";

const fullCommit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const text = z.string().min(1);

/** The statement a ci tag carries. Strict at the top, so a verifier never acts on a field it does not know. */
export const ciTagStatementSchema = z
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
    predicateType: z.literal(CI_TAG_PREDICATE),
    predicate: z
      .object({
        signer: text,
        record: z
          .object({ schema: z.literal(1), tag: z.enum(["green", "revoked"]), commit: fullCommit, branch: text, at: text })
          .passthrough(),
      })
      .strict(),
  })
  .strict();
export type CiTagStatement = z.infer<typeof ciTagStatementSchema>;

/** A tag's JSON record, without the statement. */
export type CiTagRecord = Record<string, unknown> & { tag: "green" | "revoked"; commit: string; branch: string };

/** Whoever signs the tags a tick makes: a runner key and the principal `.chant/trust.json` lists it for. */
export interface CiTagSigner {
  principal: string;
  key: KeyObject;
  publicKey: string;
}

export function buildCiTagStatement(record: CiTagRecord, signer: string): CiTagStatement {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: record.commit, digest: { gitCommit: record.commit } }],
    predicateType: CI_TAG_PREDICATE,
    predicate: { signer, record: record as CiTagStatement["predicate"]["record"] },
  };
}

/** The envelope a tag's record carries as `statement`, signed by `signer`. */
export function signCiTagRecord(record: CiTagRecord, signer: CiTagSigner): DsseEnvelope {
  const statement = buildCiTagStatement(record, signer.principal);
  return signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonicalJson(statement), "utf8"), signer.key, signer.publicKey);
}

/**
 * Why a tag is ignored: it has no statement, the statement is not one, no
 * runner key at base signed it, or it signs another tag's facts. The same
 * words a run's attestation uses (`./run-statement.ts`).
 */
export type CiTagFailure = "unsigned" | "invalid" | "untrusted" | "mismatch";

export type CiTagVerdict =
  | { status: "signed"; signer: string; keyid: string; reason: string }
  | { status: CiTagFailure; reason: string };

const normalise = (name: string): string => name.normalize("NFKC").trim().toLowerCase();

/**
 * Verify the statement in a tag's record. `expect` is what the tag itself
 * says: the commit its name gives, its kind and the declared branch. The
 * signer's key must be a runner key at base and its principal must hold the
 * `runner` role in `roles`. Never throws.
 */
export function verifyCiTagStatement(
  record: Record<string, unknown> | null,
  expect: { sha: string; kind: "green" | "revoked"; branch: string },
  runners: readonly RunnerKey[],
  roles: Readonly<Record<string, readonly string[]>>,
): CiTagVerdict {
  const tag = `ci/${expect.kind}/${expect.sha}`;
  if (record === null) return { status: "unsigned", reason: `${tag} has no JSON record in its annotation, so it carries no statement (a lightweight tag, or one made by hand)` };
  const { statement: envelope, ...fields } = record;
  if (envelope === undefined) return { status: "unsigned", reason: `${tag} carries no statement signed by a runner key` };
  const v = verifyEnvelope(envelope, runners);
  if (!v.ok) return { status: v.code === "envelope-untrusted" ? "untrusted" : "invalid", reason: `${tag}: ${v.reason}` };
  if (!(roles[CI_TAG_SIGNER_ROLE] ?? []).some((p) => normalise(p) === normalise(v.principal))) {
    return { status: "untrusted", reason: `${tag} is signed by ${v.principal}'s runner key, and ${v.principal} holds no ${CI_TAG_SIGNER_ROLE} role in .chant/trust.json at base` };
  }
  if (v.payloadType !== IN_TOTO_PAYLOAD_TYPE) return { status: "invalid", reason: `${tag}: payload type ${v.payloadType} is not ${IN_TOTO_PAYLOAD_TYPE}` };
  let raw: unknown;
  try {
    raw = JSON.parse(v.payload.toString("utf8"));
  } catch {
    return { status: "invalid", reason: `${tag}: the statement's payload is not JSON` };
  }
  const parsed = ciTagStatementSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ");
    return { status: "invalid", reason: `${tag}: the payload is not a ${CI_TAG_PREDICATE} statement: ${detail}` };
  }
  const p = parsed.data.predicate;
  if (p.signer !== v.principal) return { status: "invalid", reason: `${tag}: the statement names signer ${JSON.stringify(p.signer)}, but ${v.principal}'s key signed it` };
  const differs: string[] = [];
  if (parsed.data.subject[0]!.name !== expect.sha) differs.push(`it is for commit ${parsed.data.subject[0]!.name.slice(0, 12)}`);
  if (p.record.commit !== expect.sha) differs.push(`its record names commit ${p.record.commit.slice(0, 12)}`);
  if (p.record.tag !== expect.kind) differs.push(`it signs a ${p.record.tag} tag`);
  if (p.record.branch !== expect.branch) differs.push(`it is for branch ${p.record.branch}, and ci.green names ${expect.branch}`);
  if (canonicalJson(p.record) !== canonicalJson(fields)) differs.push("the annotation's record is not the one signed");
  if (differs.length > 0) return { status: "mismatch", reason: `${tag} is signed by ${v.principal}, but the statement does not match the tag: ${differs.join("; ")}` };
  return { status: "signed", signer: v.principal, keyid: v.keyid, reason: `signed by ${v.principal} (${CI_TAG_SIGNER_ROLE})` };
}
