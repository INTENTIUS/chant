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
 * holds, as for the tick's tags and the run records), or the job's OIDC
 * identity ({@link keylessEvidenceSigner}, #4869), which trades the job's
 * token for a short-lived certificate and returns the same envelope with
 * the certificate and a timestamp in it. {@link runnerEvidenceSigner} picks
 * one from the job's environment, the one place every signing step reads.
 *
 * Reading ({@link readCheckEvidence}) verifies each envelope against the
 * runner keys and keyless identities of `.chant/trust.json` at base, so
 * evidence a change signs with a key or identity it adds itself does not
 * count until that is merged.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../effect-receipt";
import { gitRevisionSource } from "../record-source";
import { X509Certificate } from "node:crypto";
import { IN_TOTO_PAYLOAD_TYPE, loadRunnerKey, pae, signEnvelope, type DsseEnvelope } from "./dsse";
import { RUNNER_EVIDENCE_PREDICATE, STATEMENT_TYPE, verifyEvidence, type EvidenceStatement } from "./evidence";
import { certificateIssuer, certificateSubjects, keylessSignature, requestCertificate, signingToken, subjectPattern, verifyKeylessSignature } from "./keyless";
import { readTrustPolicy, runnersAt } from "./policy";
import { attachEvidence, EVIDENCE_NOTES_REF, parseEvidenceNote } from "./ref-gate";
import { CHECK_EVIDENCE_KEY_ENV, RUNNER_IDENTITY_ENV } from "./check-evidence-report";

export { CHECK_EVIDENCE_KEY_ENV, RUNNER_IDENTITY_ENV };

export { EVIDENCE_NOTES_REF };

/** The named checks the plan job stands for (#4870): its plan, and the policy evaluated inside it. */
export const PLAN_EVIDENCE_CHECKS = ["plan", "policy"] as const;

/**
 * Who signs a check's statement (#4870). `sign` returns the DSSE envelope
 * of the in-toto payload it is given; a keyless signer (#4869) answers
 * once its signature is timestamped.
 */
export interface EvidenceSigner {
  /** The runner principal the statement names, as `.chant/trust.json` at base lists it. */
  principal: string;
  sign(payloadType: string, payload: Buffer): DsseEnvelope | Promise<DsseEnvelope>;
}

/**
 * The signer of a job that signs keyless from its OIDC identity (#4869):
 * it requests the job's token for the policy's audience, trades it at the
 * policy's certificate authority for a certificate over a key made for this
 * run, and signs each envelope with that key, each signature timestamped.
 * The principal is the identity of `keyless.identities` at `base` the
 * certificate matches. Throws when the policy at base lists no keyless
 * identity, the job has no token, or the certificate names an identity the
 * policy does not list, so a job never keeps evidence its readers would
 * ignore. Each envelope is verified against the policy before it is
 * returned.
 */
export async function keylessEvidenceSigner(repo: string, base: string, opts: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): Promise<EvidenceSigner> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetch ?? fetch;
  const policy = readTrustPolicy(gitRevisionSource(repo, base), base);
  if (policy.problems.length > 0) throw new Error(`the policy at ${base.slice(0, 12)} cannot be read: ${policy.problems.join("; ")}`);
  const identities = policy.runnerIdentities ?? [];
  if (!policy.keyless || identities.length === 0) {
    const why = policy.excludedRunners.map((r) => `${r.principal}: ${r.reason}`).join("; ");
    throw new Error(`.chant/trust.json at ${base.slice(0, 12)} lists no keyless identity, so keyless evidence would be ignored. Add one under "keyless"${why ? ` (${why})` : ""}`);
  }
  const { fulcio, timestamp, audience } = policy.keyless;
  const token = await signingToken(env, audience, fetchFn);
  const cert = await requestCertificate(token, fulcio, fetchFn);
  const leaf = new X509Certificate(Buffer.from(cert.certificates[0]!, "base64"));
  const issuer = certificateIssuer(leaf);
  const subjects = certificateSubjects(leaf);
  const listed = identities.find((i) => i.issuer === issuer && subjects.some((s) => subjectPattern(i.subject).test(s)));
  if (!listed) {
    throw new Error(`.chant/trust.json at ${base.slice(0, 12)} lists no keyless identity for this job (issuer ${issuer ?? "none"}, subject ${subjects.join(", ") || "none"}), so the evidence would be ignored`);
  }
  return {
    principal: listed.principal,
    sign: async (payloadType, payload) => {
      const message = pae(payloadType, payload);
      const signature = await keylessSignature(message, cert, timestamp, fetchFn);
      const v = verifyKeylessSignature(message, signature, [listed]);
      if (!v.ok) throw new Error(`the keyless signature does not verify against the policy at ${base.slice(0, 12)}: ${v.reason}`);
      return { payloadType, payload: payload.toString("base64"), signatures: [signature] };
    },
  };
}

/**
 * The job's signer, read from its environment in one place (#4869): the
 * runner key in `key` or `CHANT_RUNNER_KEY` ({@link runnerKeyEvidenceSigner}),
 * else, with `CHANT_RUNNER_IDENTITY=oidc`, the job's OIDC identity
 * ({@link keylessEvidenceSigner}). Undefined when the job has neither, so
 * a project with no runner identity gets the job it had. Throws as those do.
 */
export async function runnerEvidenceSigner(repo: string, base: string, opts: { env?: NodeJS.ProcessEnv; key?: string; fetch?: typeof fetch } = {}): Promise<EvidenceSigner | undefined> {
  const env = opts.env ?? process.env;
  const pem = opts.key ?? env[CHECK_EVIDENCE_KEY_ENV];
  if (pem) return runnerKeyEvidenceSigner(repo, base, pem);
  const identity = env[RUNNER_IDENTITY_ENV];
  if (!identity) return undefined;
  if (identity !== "oidc") throw new Error(`${RUNNER_IDENTITY_ENV} is ${JSON.stringify(identity)}; the one runner identity chant signs with is oidc`);
  return keylessEvidenceSigner(repo, base, { env, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}

/** What {@link runnerEvidenceSigner} would sign with, for a line saying why nothing was signed. */
export function noRunnerIdentity(): string {
  return `no runner identity: neither ${CHECK_EVIDENCE_KEY_ENV} nor ${RUNNER_IDENTITY_ENV}=oidc is set`;
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

/** Where a check's pass was read from (#4926): the forge's run and job ids, and the step whose conclusion said so. */
export interface CheckSource {
  run: number;
  job: number;
  step?: string;
}

/**
 * The check's statement over `commit`, with the digest of what it said when
 * given, and (#4926) the run, job and step a signer outside the check's job
 * read its pass from, so a verifier can look them up.
 */
export function checkStatement(input: { commit: string; tree: string; check: string; runner: string; claim?: Buffer | string; source?: CheckSource }): EvidenceStatement {
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
      ...(input.source ? { source: { run: input.source.run, job: input.source.job, ...(input.source.step ? { step: input.source.step } : {}) } } : {}),
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
export async function signChecks(repo: string, at: string, checks: readonly { check: string; claim?: Buffer | string; source?: CheckSource }[], signer: EvidenceSigner): Promise<SignedCheck[]> {
  const { commit, tree } = commitAndTree(repo, at);
  const out: SignedCheck[] = [];
  for (const { check, claim, source } of checks) {
    const statement = checkStatement({ commit, tree, check, runner: signer.principal, ...(claim !== undefined ? { claim } : {}), ...(source ? { source } : {}) });
    out.push({ check, commit, tree, runner: signer.principal, envelope: await signer.sign(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonicalJson(statement), "utf8")) });
  }
  return out;
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
export async function recordChecks(repo: string, signed: readonly SignedCheck[], opts: { push?: boolean; remote?: string; notesRef?: string } = {}): Promise<{ pushed: boolean; pushWarning?: string }> {
  if (signed.length === 0) return { pushed: false };
  const push = opts.push !== false;
  const remote = opts.remote ?? "origin";
  // #4868: local evidence goes under a notes ref of its own.
  const notesRef = opts.notesRef ?? EVIDENCE_NOTES_REF;
  const hasRemote = push && tryGit(repo, ["remote", "get-url", remote]) !== undefined;
  if (!hasRemote) {
    for (const s of signed) attachEvidence(repo, s.commit, s.envelope, notesRef);
    return push ? { pushed: false, pushWarning: `no remote ${remote}, so the evidence is attached here only` } : { pushed: false };
  }
  let said = "";
  for (let attempt = 1; attempt <= NOTES_PUSH_TRIES; attempt++) {
    // The remote's notes are the ones to add to; a CI checkout has none of its own to keep.
    if (tryGit(repo, ["fetch", "--quiet", "--no-tags", remote, `+${notesRef}:${notesRef}`]) === undefined && attempt > 1) break;
    for (const s of signed) attachEvidence(repo, s.commit, s.envelope, notesRef);
    try {
      execFileSync("git", ["push", "--quiet", remote, `${notesRef}:${notesRef}`], { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return { pushed: true };
    } catch (err) {
      said = String((err as { stderr?: unknown }).stderr ?? (err instanceof Error ? err.message : err)).trim().split("\n")[0] ?? "";
    }
  }
  return { pushed: false, pushWarning: `git push ${remote} ${notesRef} did not land${said ? ` (git said: ${said})` : ""}` };
}

/**
 * Every envelope attached to a commit whose tree is `tree`: `commit`'s own first. Read from `notesRef`
 * (default {@link EVIDENCE_NOTES_REF}; #4868 reads local evidence from its own).
 */
export function envelopesForTree(repo: string, commit: string, tree: string, notesRef: string = EVIDENCE_NOTES_REF): unknown[] {
  const list = tryGit(repo, ["notes", `--ref=${notesRef}`, "list"]);
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
 * the runner keys and keyless identities `.chant/trust.json` lists at
 * `base` (#4869). `missing`: nothing is
 * kept for the tree. `untrusted`: an envelope is kept, and no runner key at
 * base signed it, or it is not a check statement for that tree.
 */
export async function readCheckEvidence(repo: string, at: string, base: string, checks: readonly string[]): Promise<CheckEvidenceVerdict[]> {
  const { tree, commit } = commitAndTree(repo, at);
  const policy = readTrustPolicy(gitRevisionSource(repo, base), base);
  // #4869: the keys and the keyless identities; under keyless.since, the keys only for a commit before it.
  const runners = runnersAt(policy, { repo, commit });
  const envelopes = envelopesForTree(repo, commit, tree);
  return checks.map((check): CheckEvidenceVerdict => {
    let untrusted: string | undefined;
    for (const envelope of envelopes) {
      const v = verifyEvidence(envelope, runners, repo, commit);
      if (!v.ok) {
        if (claimedCheck(envelope) === check) untrusted ??= `the evidence attached for check ${check} does not verify against the runners at ${base.slice(0, 12)}: ${v.reason}`;
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
