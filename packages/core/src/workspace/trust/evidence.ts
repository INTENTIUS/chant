/**
 * Runner evidence (#2553, #2524 D5 "Evidence").
 *
 * A runner, meaning a CI job or a service, states that a check ran over a
 * set of records at one commit. The statement is an in-toto Statement v1:
 * each record is a subject, named by its path and hashed, and the predicate
 * binds the commit, its tree, the check, and the digests of the claim and of
 * the environment when given. The runner signs it in a DSSE envelope with its
 * own Ed25519 key.
 *
 * Verifying needs only the envelope, the repository's objects and the runner
 * keys the policy at base lists, so it works offline. Evidence is never
 * reused on trust: a verdict reports, subject by subject, whether the records
 * still hash the same, and evidence for records that changed is `stale`.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { canonicalJson } from "../../effect-receipt";
import { IN_TOTO_PAYLOAD_TYPE, signEnvelope, verifyEnvelope, type DsseEnvelope } from "./dsse";
import type { KeyObject } from "node:crypto";
import type { RunnerKey } from "./policy";

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const RUNNER_EVIDENCE_PREDICATE = "https://intentius.io/chant/runner-evidence/v1";

export interface EvidenceStatement {
  _type: typeof STATEMENT_TYPE;
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicateType: typeof RUNNER_EVIDENCE_PREDICATE;
  predicate: {
    runner: string;
    commit: string;
    tree: string;
    check: string;
    claim?: { sha256: string };
    environment?: { sha256: string };
  };
}

/** SHA-256 of a record's text, line endings normalised as seals do (#2524 D4). */
export function recordHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function blobAt(repo: string, commit: string, path: string): string | undefined {
  try {
    return git(repo, ["cat-file", "blob", `${commit}:${path}`]);
  } catch {
    return undefined;
  }
}

export interface EvidenceInput {
  repo: string;
  /** The full commit id the check ran at. Records are hashed as committed there. */
  commit: string;
  paths: string[];
  runner: string;
  check: string;
  claim?: Buffer;
  environment?: Buffer;
}

export function buildStatement(input: EvidenceInput): EvidenceStatement {
  const subject = [...input.paths].sort().map((name) => {
    const text = blobAt(input.repo, input.commit, name);
    if (text === undefined) throw new Error(`${name} is not in commit ${input.commit.slice(0, 8)}`);
    return { name, digest: { sha256: recordHash(text) } };
  });
  return {
    _type: STATEMENT_TYPE,
    subject,
    predicateType: RUNNER_EVIDENCE_PREDICATE,
    predicate: {
      runner: input.runner,
      commit: input.commit,
      tree: git(input.repo, ["rev-parse", `${input.commit}^{tree}`]).trim(),
      check: input.check,
      ...(input.claim ? { claim: { sha256: sha256(input.claim) } } : {}),
      ...(input.environment ? { environment: { sha256: sha256(input.environment) } } : {}),
    },
  };
}

export function signEvidence(statement: EvidenceStatement, key: KeyObject, publicKey: string): DsseEnvelope {
  return signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonicalJson(statement), "utf8"), key, publicKey);
}

export interface SubjectVerdict {
  name: string;
  signed: string;
  /** The hash at the revision checked, or null when the record is not there. */
  now: string | null;
  matches: boolean;
}

export type EvidenceVerdict =
  | {
      ok: true;
      /** `current` when every subject still hashes the same at the revision checked; otherwise `stale`. */
      status: "current" | "stale";
      runner: string;
      class: RunnerKey["class"];
      keyid: string;
      statement: EvidenceStatement;
      subjects: SubjectVerdict[];
    }
  | { ok: false; reason: string };

/**
 * Verify an envelope against the runner keys at base, then compare each
 * subject with the record as committed at `at`.
 */
export function verifyEvidence(envelope: unknown, runners: readonly RunnerKey[], repo: string, at: string): EvidenceVerdict {
  const v = verifyEnvelope(envelope, runners);
  if (!v.ok) return v;
  if (v.payloadType !== IN_TOTO_PAYLOAD_TYPE) return { ok: false, reason: `payload type ${v.payloadType} is not ${IN_TOTO_PAYLOAD_TYPE}` };
  let statement: EvidenceStatement;
  try {
    statement = JSON.parse(v.payload.toString("utf8")) as EvidenceStatement;
  } catch {
    return { ok: false, reason: "the payload is not JSON" };
  }
  if (statement._type !== STATEMENT_TYPE || statement.predicateType !== RUNNER_EVIDENCE_PREDICATE || !Array.isArray(statement.subject)) {
    return { ok: false, reason: `the payload is not a ${RUNNER_EVIDENCE_PREDICATE} statement` };
  }
  // The runner named inside must be the one whose key signed: a runner cannot speak for another.
  if (statement.predicate?.runner !== v.principal) {
    return { ok: false, reason: `the statement names runner ${JSON.stringify(statement.predicate?.runner)}, but ${v.principal}'s key signed it` };
  }
  const subjects = statement.subject.map((s) => {
    const text = blobAt(repo, at, s.name);
    const now = text === undefined ? null : recordHash(text);
    return { name: s.name, signed: s.digest?.sha256, now, matches: now !== null && now === s.digest?.sha256 };
  });
  const runner = runners.find((r) => r.principal === v.principal)!;
  return {
    ok: true,
    status: subjects.every((s) => s.matches) ? "current" : "stale",
    runner: v.principal,
    class: runner.class,
    keyid: v.keyid,
    statement,
    subjects,
  };
}
