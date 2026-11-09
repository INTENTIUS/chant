/**
 * Evidence for each named check a generated pipeline runs (#4870).
 *
 * A check job (`chant ci check`, the plan job's note job, a wave job) signs,
 * for each check that passed, the runner evidence statement of #2553
 * (./evidence.ts): the commit, its tree, the check's name, and the digest of
 * what the check said (`claim`) when there is one. No record is a subject:
 * a check reads the tree, and the statement binds the tree.
 *
 * The envelope is kept on `chant/lifecycle` at
 * `_evidence/<tree>/<check>.json`, keyed by the tree rather than the commit,
 * so the merge of a pull request whose tree is the pull request head's finds
 * the evidence its head was given, and #4868's rebase that keeps the tree
 * keeps it too. A newer signing of the same check on the same tree replaces
 * the older one.
 *
 * Who signs is an {@link EvidenceSigner}: today a runner key the policy at
 * base lists ({@link runnerKeyEvidenceSigner}, the key `CHANT_RUNNER_KEY`
 * holds, as for the tick's tags and the run records). #4869 adds a signer
 * that trades the job's OIDC token for a short-lived certificate and returns
 * the same envelope with the certificate in it; nothing that calls a signer
 * changes.
 *
 * Reading ({@link readCheckEvidence}) verifies each envelope against the
 * runner keys of `.chant/trust.json` at base, so evidence a change signs
 * with a key it adds itself does not count until that key is merged.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../effect-receipt";
import { pushLifecycleReport, readBlobFromPath, writeLedgerFiles } from "../../lifecycle/git";
import { gitRevisionSource } from "../record-source";
import { IN_TOTO_PAYLOAD_TYPE, loadRunnerKey, signEnvelope, type DsseEnvelope } from "./dsse";
import { RUNNER_EVIDENCE_PREDICATE, STATEMENT_TYPE, verifyEvidence, type EvidenceStatement } from "./evidence";
import { readTrustPolicy } from "./policy";

export { CHECK_EVIDENCE_KEY_ENV } from "./check-evidence-report";

/** The ledger directory the envelopes are kept under. */
export const CHECK_EVIDENCE_LEDGER_DIR = "_evidence";

/** The named checks the plan job stands for (#4870): its plan, and the policy evaluated inside it. */
export const PLAN_EVIDENCE_CHECKS = ["plan", "policy"] as const;

/**
 * Who signs a check's statement (#4870). `sign` returns the DSSE envelope
 * of the in-toto payload it is given. The seam #4869's keyless signer plugs
 * into.
 */
export interface EvidenceSigner {
  /** The runner principal the statement names, as `.chant/trust.json` at base lists it. */
  principal: string;
  sign(payloadType: string, payload: Buffer): DsseEnvelope;
}

/**
 * The signer a runner key makes: the principal `.chant/trust.json` at
 * `base` lists the key under `runners`. Throws when the key is not an
 * Ed25519 PEM key, is a signer's (a person's) key, or is not listed, so a
 * job never keeps evidence its readers would ignore.
 */
export function runnerKeyEvidenceSigner(repo: string, base: string, pem: string): EvidenceSigner {
  let loaded: ReturnType<typeof loadRunnerKey>;
  try {
    loaded = loadRunnerKey(pem);
  } catch (err) {
    throw new Error(`the runner key is not an Ed25519 private key in PEM: ${err instanceof Error ? err.message : String(err)}`);
  }
  const policy = readTrustPolicy(gitRevisionSource(repo, base), base);
  if (policy.problems.length > 0) throw new Error(`the policy at ${base.slice(0, 12)} cannot be read: ${policy.problems.join("; ")}`);
  if (policy.signers.some((s) => s.key === loaded.publicKey)) {
    throw new Error(`the runner key is a signer's key in ${policy.signersPath}; check evidence is signed by a CI identity's key, never by a person's`);
  }
  const listed = policy.runners.find((r) => r.key === loaded.publicKey);
  if (!listed) throw new Error(`.chant/trust.json at ${base.slice(0, 12)} lists no runner with this key, so the evidence would be ignored. Add it under "runners" first:\n  ${loaded.publicKey}`);
  return { principal: listed.principal, sign: (payloadType, payload) => signEnvelope(payloadType, payload, loaded.key, loaded.publicKey) };
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The full commit id and tree of `rev`. Throws when `rev` names no commit. */
export function commitAndTree(repo: string, rev: string): { commit: string; tree: string } {
  const commit = git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return { commit, tree: git(repo, ["rev-parse", `${commit}^{tree}`]) };
}

/** The file name a check's envelope is kept under: anything that is not a plain file-name character becomes `_`. */
export function checkEvidenceFile(check: string): string {
  return `${check.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/** The check's statement over `commit`, with the digest of what it said when given. */
export function checkStatement(input: { commit: string; tree: string; check: string; runner: string; claim?: Buffer | string }): EvidenceStatement {
  if (!input.check.trim()) throw new Error("a check's evidence needs the check's name");
  return {
    _type: STATEMENT_TYPE,
    subject: [],
    predicateType: RUNNER_EVIDENCE_PREDICATE,
    predicate: {
      runner: input.runner,
      commit: input.commit,
      tree: input.tree,
      check: input.check,
      ...(input.claim !== undefined ? { claim: { sha256: createHash("sha256").update(input.claim).digest("hex") } } : {}),
    },
  };
}

/** One check signed. */
export interface SignedCheck {
  check: string;
  commit: string;
  tree: string;
  runner: string;
  envelope: DsseEnvelope;
  /** Where on `chant/lifecycle` it is kept. */
  path: string;
}

/** Sign each of `checks` over `at` with `signer`. Writes nothing. */
export function signChecks(repo: string, at: string, checks: readonly { check: string; claim?: Buffer | string }[], signer: EvidenceSigner): SignedCheck[] {
  const { commit, tree } = commitAndTree(repo, at);
  return checks.map(({ check, claim }) => {
    const statement = checkStatement({ commit, tree, check, runner: signer.principal, ...(claim !== undefined ? { claim } : {}) });
    return {
      check,
      commit,
      tree,
      runner: signer.principal,
      envelope: signer.sign(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonicalJson(statement), "utf8")),
      path: `${CHECK_EVIDENCE_LEDGER_DIR}/${tree}/${checkEvidenceFile(check)}`,
    };
  });
}

/**
 * Keep the envelopes on `chant/lifecycle` in one commit, then push the
 * branch. Returns why the push did not land, when it did not; the local
 * branch holds them either way.
 */
export async function recordChecks(repo: string, signed: readonly SignedCheck[], opts: { push?: boolean } = {}): Promise<{ pushed: boolean; pushWarning?: string }> {
  if (signed.length === 0) return { pushed: false };
  const first = signed[0]!;
  await writeLedgerFiles(
    signed.map((s) => ({ path: s.path, content: JSON.stringify(s.envelope, null, 2) + "\n" })),
    `evidence: ${signed.map((s) => s.check).join(", ")} at ${first.commit.slice(0, 12)} by ${first.runner}`,
    { cwd: repo },
  );
  if (opts.push === false) return { pushed: false };
  return pushLifecycleReport({ cwd: repo });
}

/** What the ledger holds for one check at a commit's tree. */
export type CheckEvidenceVerdict =
  | { check: string; status: "current"; runner: string; commit: string }
  | { check: string; status: "missing" | "untrusted" | "stale"; reason: string };

/**
 * Read and verify the evidence for each of `checks` at `at`'s tree, against
 * the runner keys `.chant/trust.json` lists at `base`. `missing`: nothing is
 * kept for the tree. `untrusted`: an envelope is kept, and no runner key at
 * base signed it, or it is not a check statement for that tree.
 */
export async function readCheckEvidence(repo: string, at: string, base: string, checks: readonly string[]): Promise<CheckEvidenceVerdict[]> {
  const { tree, commit } = commitAndTree(repo, at);
  const policy = readTrustPolicy(gitRevisionSource(repo, base), base);
  const out: CheckEvidenceVerdict[] = [];
  for (const check of checks) {
    const text = await readBlobFromPath(`${CHECK_EVIDENCE_LEDGER_DIR}/${tree}`, checkEvidenceFile(check), { cwd: repo, ledgerPrefix: "" });
    if (text === null) {
      out.push({ check, status: "missing", reason: `no evidence for check ${check} is kept for the tree of ${commit.slice(0, 12)}` });
      continue;
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      out.push({ check, status: "untrusted", reason: `the evidence kept for check ${check} is not JSON` });
      continue;
    }
    const v = verifyEvidence(envelope, policy.runners, repo, commit);
    if (!v.ok) {
      out.push({ check, status: "untrusted", reason: `the evidence kept for check ${check} does not verify against the runner keys at ${base.slice(0, 12)}: ${v.reason}` });
    } else if (v.statement.predicate.check !== check || v.statement.predicate.tree !== tree) {
      out.push({ check, status: "untrusted", reason: `the evidence kept for check ${check} is for check ${v.statement.predicate.check} on tree ${v.statement.predicate.tree.slice(0, 12)}` });
    } else if (v.status !== "current") {
      out.push({ check, status: "stale", reason: `the records check ${check} read changed after it was signed` });
    } else {
      out.push({ check, status: "current", runner: v.runner, commit: v.statement.predicate.commit });
    }
  }
  return out;
}

/** The command that produces a check's evidence, for a refusal to name. */
export function checkEvidenceCommand(check: string): string {
  return `chant ci evidence sign --check-id ${check}`;
}

/**
 * Why `at` is refused for want of evidence, or null when every one of
 * `required` has current evidence. Names each missing check and the
 * command that produces it.
 */
export async function missingCheckEvidence(repo: string, at: string, base: string, required: readonly string[]): Promise<string | null> {
  if (required.length === 0) return null;
  const verdicts = await readCheckEvidence(repo, at, base, required);
  const missing = verdicts.filter((v): v is Exclude<CheckEvidenceVerdict, { status: "current" }> => v.status !== "current");
  if (missing.length === 0) return null;
  return `${at.slice(0, 12)} lacks the evidence the policy at ${base.slice(0, 12)} requires: ${missing
    .map((v) => `${v.check} (${v.reason}; run it in CI, where ${checkEvidenceCommand(v.check)} signs it)`)
    .join("; ")}`;
}
