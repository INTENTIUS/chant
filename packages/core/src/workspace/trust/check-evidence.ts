/**
 * Evidence for each named check a generated pipeline runs (#4870).
 *
 * A check job (`chant ci check`, the plan job's note job, a wave job) signs,
 * for each check that passed, the runner evidence statement of #2553
 * (./evidence.ts): the commit, its tree, the check's name, and the digest of
 * what the check said (`claim`) when there is one. No record is a subject:
 * a check reads the tree, and the statement binds the tree.
 *
 * The envelope is attached where #4867's ref gate reads evidence: a line
 * of the commit's git note under `refs/notes/chant/evidence`
 * (`EVIDENCE_NOTES_REF`, ./ref-gate.ts), which the job then pushes. The
 * statement names no record, so it counts for the tree it was signed over:
 * {@link readCheckEvidence} also reads the notes of other commits with the
 * same tree, so the squash of a pull request whose tree is the head's finds
 * the evidence the head was given, as #4868's rebase that keeps the tree
 * will.
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
import { gitRevisionSource } from "../record-source";
import { IN_TOTO_PAYLOAD_TYPE, loadRunnerKey, signEnvelope, type DsseEnvelope } from "./dsse";
import { RUNNER_EVIDENCE_PREDICATE, STATEMENT_TYPE, verifyEvidence, type EvidenceStatement } from "./evidence";
import { readTrustPolicy } from "./policy";
import { attachEvidence, EVIDENCE_NOTES_REF, parseEvidenceNote } from "./ref-gate";

export { CHECK_EVIDENCE_KEY_ENV } from "./check-evidence-report";

export { EVIDENCE_NOTES_REF };

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
    };
  });
}

/** How many times {@link recordChecks} fetches, attaches and pushes when another job pushed the notes first. */
const NOTES_PUSH_TRIES = 3;

function tryGit(repo: string, args: string[]): string | undefined {
  try {
    return git(repo, args);
  } catch {
    return undefined;
  }
}

/**
 * Attach each envelope to its commit's evidence note and push
 * `refs/notes/chant/evidence` to `origin`. The remote's notes are fetched
 * first, so the push adds to them; a push another job beat is tried again
 * on the newer notes. Returns why the push did not land, when it did not;
 * the local notes hold the envelopes either way.
 */
export async function recordChecks(repo: string, signed: readonly SignedCheck[], opts: { push?: boolean; remote?: string } = {}): Promise<{ pushed: boolean; pushWarning?: string }> {
  if (signed.length === 0) return { pushed: false };
  const push = opts.push !== false;
  const remote = opts.remote ?? "origin";
  const hasRemote = push && tryGit(repo, ["remote", "get-url", remote]) !== undefined;
  if (!hasRemote) {
    for (const s of signed) attachEvidence(repo, s.commit, s.envelope);
    return push ? { pushed: false, pushWarning: `no remote ${remote}, so the evidence is attached here only` } : { pushed: false };
  }
  let said = "";
  for (let attempt = 1; attempt <= NOTES_PUSH_TRIES; attempt++) {
    // The remote's notes are the ones to add to; a CI checkout has none of its own to keep.
    if (tryGit(repo, ["fetch", "--quiet", "--no-tags", remote, `+${EVIDENCE_NOTES_REF}:${EVIDENCE_NOTES_REF}`]) === undefined && attempt > 1) break;
    for (const s of signed) attachEvidence(repo, s.commit, s.envelope);
    try {
      execFileSync("git", ["push", "--quiet", remote, `${EVIDENCE_NOTES_REF}:${EVIDENCE_NOTES_REF}`], { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return { pushed: true };
    } catch (err) {
      said = String((err as { stderr?: unknown }).stderr ?? (err instanceof Error ? err.message : err)).trim().split("\n")[0] ?? "";
    }
  }
  return { pushed: false, pushWarning: `git push ${remote} ${EVIDENCE_NOTES_REF} did not land${said ? ` (git said: ${said})` : ""}` };
}

/** Every envelope attached to a commit whose tree is `tree`: `commit`'s own first. */
function envelopesForTree(repo: string, commit: string, tree: string): unknown[] {
  const list = tryGit(repo, ["notes", `--ref=${EVIDENCE_NOTES_REF}`, "list"]);
  if (!list) return [];
  const own: unknown[] = [];
  const others: unknown[] = [];
  for (const line of list.split("\n")) {
    const [blob, annotated] = line.trim().split(/\s+/);
    if (!blob || !annotated) continue;
    const same = annotated === commit || tryGit(repo, ["rev-parse", "--verify", "--quiet", `${annotated}^{tree}`]) === tree;
    if (!same) continue;
    const text = tryGit(repo, ["cat-file", "blob", blob]);
    if (text !== undefined) (annotated === commit ? own : others).push(...parseEvidenceNote(text));
  }
  return [...own, ...others];
}

/** What the evidence notes hold for one check at a commit's tree. */
export type CheckEvidenceVerdict =
  | { check: string; status: "current"; runner: string; commit: string }
  | { check: string; status: "missing" | "untrusted"; reason: string };

/**
 * Read and verify the evidence for each of `checks` at `at`'s tree, against
 * the runner keys `.chant/trust.json` lists at `base`. `missing`: nothing is
 * kept for the tree. `untrusted`: an envelope is kept, and no runner key at
 * base signed it, or it is not a check statement for that tree.
 */
export async function readCheckEvidence(repo: string, at: string, base: string, checks: readonly string[]): Promise<CheckEvidenceVerdict[]> {
  const { tree, commit } = commitAndTree(repo, at);
  const policy = readTrustPolicy(gitRevisionSource(repo, base), base);
  const envelopes = envelopesForTree(repo, commit, tree);
  return checks.map((check): CheckEvidenceVerdict => {
    let untrusted: string | undefined;
    for (const envelope of envelopes) {
      const v = verifyEvidence(envelope, policy.runners, repo, commit);
      if (!v.ok) {
        if (claimedCheck(envelope) === check) untrusted ??= `the evidence attached for check ${check} does not verify against the runner keys at ${base.slice(0, 12)}: ${v.reason}`;
        continue;
      }
      if (v.statement.predicate.check !== check || v.statement.predicate.tree !== tree) continue;
      if (v.status === "current") return { check, status: "current", runner: v.runner, commit: v.statement.predicate.commit };
    }
    if (untrusted) return { check, status: "untrusted", reason: untrusted };
    return { check, status: "missing", reason: `no evidence for check ${check} is attached under ${EVIDENCE_NOTES_REF} to a commit with the tree of ${commit.slice(0, 12)}` };
  });
}

/** The check an envelope says it is for, read without verifying, so a refusal can name it. */
function claimedCheck(envelope: unknown): string | undefined {
  try {
    const payload = (envelope as { payload?: unknown }).payload;
    if (typeof payload !== "string") return undefined;
    const check = (JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { predicate?: { check?: unknown } }).predicate?.check;
    return typeof check === "string" ? check : undefined;
  } catch {
    return undefined;
  }
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
