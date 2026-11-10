/**
 * Local evidence (#4868): a check proven on a developer's or an agent's
 * machine, which CI accepts in place of running the check again when the
 * policy at base says so.
 *
 * - The statement is the check statement of ./check-evidence.ts with its own
 *   predicate type ({@link LOCAL_EVIDENCE_PREDICATE}) and the signer's class
 *   (`person` or `agent`) in place of a runner. It binds the commit and its
 *   tree, and counts for any commit with the same tree, so a rebase or an
 *   amend that keeps the tree keeps it current.
 * - It is signed by a key `local.keys` of `.chant/trust.json` lists at base,
 *   for a person or an agent session, and kept under its own notes ref,
 *   {@link LOCAL_EVIDENCE_NOTES_REF}. The ref gate (#4867) and an Op waves
 *   spec's `evidence.requires` read only `refs/notes/chant/evidence` and only
 *   runner keys, so local evidence never counts as runner evidence.
 * - `local.checks` at base names each check it stands in for, and from whom
 *   (`from`, default people only). A check it does not name accepts none.
 *   The checks that gate an apply, a release or a gate
 *   (`LOCAL_EVIDENCE_NEVER`: plan, policy, apply, drift, ...) can't be named:
 *   the policy that names one does not parse, and nothing is accepted.
 *
 * The check runner (`chant ci check`, ../../components/check-steps.ts) reads
 * the evidence per hook with {@link acceptedLocalEvidence} and skips a hook
 * whose evidence is current and accepted, so a job that runs several hooks
 * runs the rest and still passes.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../effect-receipt";
import { gitRevisionSource } from "../record-source";
import { IN_TOTO_PAYLOAD_TYPE, loadRunnerKey, signEnvelope, verifyEnvelope } from "./dsse";
import { STATEMENT_TYPE } from "./evidence";
import { commitAndTree, recordChecks, type EvidenceSigner, type SignedCheck } from "./check-evidence";
import { localEvidenceAllowedFor, readTrustPolicy, type LocalSignerClass, type TrustPolicy } from "./policy";
import { parseEvidenceNote } from "./ref-gate";

/** The predicate type of a local check statement: never the runner evidence one. */
export const LOCAL_EVIDENCE_PREDICATE = "https://intentius.io/chant/local-evidence/v1";

/** Where local evidence is kept: a notes ref the ref gate never reads. */
export const LOCAL_EVIDENCE_NOTES_REF = "refs/notes/chant/local-evidence";

export { LOCAL_EVIDENCE_KEY_ENV } from "./check-evidence-report";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const fullCommit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** The statement a local key signs. Strict, as the runner statement is. */
export const localStatementSchema = z
  .object({
    _type: z.literal(STATEMENT_TYPE),
    subject: z.array(z.never()).length(0),
    predicateType: z.literal(LOCAL_EVIDENCE_PREDICATE),
    predicate: z
      .object({
        signer: z.string().min(1),
        class: z.enum(["person", "agent"]),
        commit: fullCommit,
        tree: fullCommit,
        check: z.string().min(1),
        claim: z.object({ sha256: sha256Hex }).strict().optional(),
      })
      .strict(),
  })
  .strict();
export type LocalStatement = z.infer<typeof localStatementSchema>;

/** A local signer: the key's principal and class as `.chant/trust.json` at base lists them. */
export interface LocalEvidenceSigner extends EvidenceSigner {
  class: LocalSignerClass;
}

/**
 * The signer a local key makes, from `local.keys` of `.chant/trust.json` at
 * `base`. Throws when the key is not an Ed25519 PEM key or is not listed
 * there (a runner's key never is), so nobody keeps evidence CI would ignore.
 */
export function localKeyEvidenceSigner(repo: string, base: string, pem: string): LocalEvidenceSigner {
  let loaded: ReturnType<typeof loadRunnerKey>;
  try {
    loaded = loadRunnerKey(pem);
  } catch (err) {
    throw new Error(`the local evidence key is not an Ed25519 private key in PEM: ${err instanceof Error ? err.message : String(err)}`);
  }
  const policy = readTrustPolicy(gitRevisionSource(repo, base), base);
  if (policy.problems.length > 0) throw new Error(`the policy at ${base.slice(0, 12)} cannot be read: ${policy.problems.join("; ")}`);
  const local = policy.local ?? { keys: [], excluded: [], checks: [] };
  if (policy.runners.some((r) => r.key === loaded.publicKey)) {
    throw new Error(`this is a runner's key in .chant/trust.json at ${base.slice(0, 12)}; local evidence is signed by a person's or an agent's key, and a runner signs with chant ci evidence sign`);
  }
  const listed = local.keys.find((k) => k.key === loaded.publicKey);
  if (!listed) {
    throw new Error(`.chant/trust.json at ${base.slice(0, 12)} lists no local key with this key, so CI would ignore the evidence. Add it under "local": { "keys": [...] } first, with class "person" or "agent":\n  ${loaded.publicKey}`);
  }
  return { principal: listed.principal, class: listed.class, sign: (payloadType, payload) => signEnvelope(payloadType, payload, loaded.key, loaded.publicKey) };
}

/** The local statement for one check over `commit`. */
export function localStatement(input: { commit: string; tree: string; check: string; signer: string; class: LocalSignerClass; claim?: Buffer | string }): LocalStatement {
  if (!input.check.trim()) throw new Error("a check's evidence needs the check's name");
  return {
    _type: STATEMENT_TYPE,
    subject: [],
    predicateType: LOCAL_EVIDENCE_PREDICATE,
    predicate: {
      signer: input.signer,
      class: input.class,
      commit: input.commit,
      tree: input.tree,
      check: input.check,
      ...(input.claim !== undefined ? { claim: { sha256: createHash("sha256").update(input.claim).digest("hex") } } : {}),
    },
  };
}

/** Sign each of `checks` over `at` as local evidence. Writes nothing. */
export function signLocalChecks(repo: string, at: string, checks: readonly { check: string; claim?: Buffer | string }[], signer: LocalEvidenceSigner): SignedCheck[] {
  const { commit, tree } = commitAndTree(repo, at);
  return checks.map(({ check, claim }) => {
    const statement = localStatement({ commit, tree, check, signer: signer.principal, class: signer.class, ...(claim !== undefined ? { claim } : {}) });
    return { check, commit, tree, runner: signer.principal, envelope: signer.sign(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonicalJson(statement), "utf8")) };
  });
}

/** Attach local envelopes under {@link LOCAL_EVIDENCE_NOTES_REF} and push that ref, as `recordChecks` does for runner evidence. */
export function recordLocalChecks(repo: string, signed: readonly SignedCheck[], opts: { push?: boolean; remote?: string } = {}): Promise<{ pushed: boolean; pushWarning?: string }> {
  return recordChecks(repo, signed, { ...opts, notesRef: LOCAL_EVIDENCE_NOTES_REF });
}

function tryGit(repo: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Fetch {@link LOCAL_EVIDENCE_NOTES_REF} from `remote` into the checkout, so
 * a CI job reads what developers pushed. A checkout without the remote, or a
 * remote without the ref, keeps what it has; returns whether the fetch landed.
 */
export function fetchLocalEvidence(repo: string, remote = "origin"): boolean {
  if (tryGit(repo, ["remote", "get-url", remote]) === undefined) return false;
  return tryGit(repo, ["fetch", "--quiet", "--no-tags", remote, `+${LOCAL_EVIDENCE_NOTES_REF}:${LOCAL_EVIDENCE_NOTES_REF}`]) !== undefined;
}

/**
 * Every local envelope that may be for `tree`: the notes of `commit`, of other
 * commits with that tree, and of commits this checkout doesn't have (a shallow
 * CI clone), whose statements are then held to the tree they name.
 */
function localEnvelopes(repo: string, commit: string, tree: string): unknown[] {
  const list = tryGit(repo, ["notes", `--ref=${LOCAL_EVIDENCE_NOTES_REF}`, "list"]);
  if (!list) return [];
  const own: unknown[] = [];
  const others: unknown[] = [];
  for (const line of list.split("\n")) {
    const [blob, annotated] = line.trim().split(/\s+/);
    if (!blob || !annotated) continue;
    if (annotated !== commit) {
      const theirs = tryGit(repo, ["rev-parse", "--verify", "--quiet", `${annotated}^{tree}`]);
      if (theirs !== undefined && theirs !== tree) continue;
    }
    const text = tryGit(repo, ["cat-file", "blob", blob]);
    if (text !== undefined) (annotated === commit ? own : others).push(...parseEvidenceNote(text));
  }
  return [...own, ...others];
}

/** What the local evidence comes to for one check at a commit's tree. */
export type LocalEvidenceVerdict =
  | { check: string; status: "accepted"; signer: string; class: LocalSignerClass; commit: string }
  | { check: string; status: "not-accepted" | "missing" | "untrusted" | "refused"; reason: string };

/** One envelope verified against the local keys at base, or why it does not count. */
function verifyLocal(envelope: unknown, policy: TrustPolicy): { ok: true; statement: LocalStatement; class: LocalSignerClass } | { ok: false; reason: string } {
  const keys = policy.local?.keys ?? [];
  const v = verifyEnvelope(envelope, keys);
  if (!v.ok) return { ok: false, reason: v.code === "envelope-untrusted" ? "no signature verifies against a local key the policy at base lists" : v.reason };
  if (v.payloadType !== IN_TOTO_PAYLOAD_TYPE) return { ok: false, reason: `payload type ${v.payloadType} is not ${IN_TOTO_PAYLOAD_TYPE}` };
  let raw: unknown;
  try {
    raw = JSON.parse(v.payload.toString("utf8"));
  } catch {
    return { ok: false, reason: "the payload is not JSON" };
  }
  const parsed = localStatementSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `the payload is not a ${LOCAL_EVIDENCE_PREDICATE} statement` };
  const key = keys.find((k) => k.principal === v.principal)!;
  // The signer and class inside are the key's own: a key cannot sign as someone else, or as a person when it is an agent's.
  if (parsed.data.predicate.signer !== key.principal || parsed.data.predicate.class !== key.class) {
    return { ok: false, reason: `the statement names ${parsed.data.predicate.class} ${JSON.stringify(parsed.data.predicate.signer)}, but the key of ${key.class} ${key.principal} signed it` };
  }
  return { ok: true, statement: parsed.data, class: key.class };
}

/** The check a local envelope says it is for, read without verifying. */
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

/**
 * Whether CI may skip each of `checks` at `at` on local evidence, judged by
 * the policy at `base` (#4868):
 *
 * - `refused`: the check is one local evidence never stands in for, or the policy at base cannot be read.
 * - `not-accepted`: `local.checks` at base does not name it (the default).
 * - `missing`: nothing current is kept for the tree.
 * - `untrusted`: an envelope is kept for it, and none verifies against a
 *   local key at base whose class the check accepts (a key the change adds
 *   itself, or an agent's key where the check takes people only).
 * - `accepted`: an envelope for the check over `at`'s tree verifies, from a class the check takes.
 */
export function acceptedLocalEvidence(repo: string, at: string, base: string, checks: readonly string[]): LocalEvidenceVerdict[] {
  const policy = readTrustPolicy(gitRevisionSource(repo, base), base);
  if (policy.problems.length > 0) return checks.map((check) => ({ check, status: "refused", reason: `the policy at ${base.slice(0, 12)} cannot be read: ${policy.problems.join("; ")}` }));
  const rules = new Map((policy.local?.checks ?? []).map((c) => [c.check, c.from]));
  if (!checks.some((c) => rules.has(c) && localEvidenceAllowedFor(c))) {
    return checks.map((check) => verdictWithoutEnvelopes(check, rules, base));
  }
  const { commit, tree } = commitAndTree(repo, at);
  const envelopes = localEnvelopes(repo, commit, tree);
  return checks.map((check): LocalEvidenceVerdict => {
    const from = rules.get(check);
    if (!from || !localEvidenceAllowedFor(check)) return verdictWithoutEnvelopes(check, rules, base);
    let untrusted: string | undefined;
    for (const envelope of envelopes) {
      const v = verifyLocal(envelope, policy);
      if (!v.ok) {
        if (claimedCheck(envelope) === check) untrusted ??= `the local evidence for ${check} does not verify against the local keys at ${base.slice(0, 12)}: ${v.reason}`;
        continue;
      }
      const p = v.statement.predicate;
      if (p.check !== check || p.tree !== tree) continue;
      if (!from.includes(v.class)) {
        untrusted ??= `the local evidence for ${check} is from ${v.class} ${p.signer}, and the policy at ${base.slice(0, 12)} takes it from ${from.join(" or ")} only`;
        continue;
      }
      return { check, status: "accepted", signer: p.signer, class: v.class, commit: p.commit };
    }
    if (untrusted) return { check, status: "untrusted", reason: untrusted };
    return { check, status: "missing", reason: `no local evidence for ${check} is kept under ${LOCAL_EVIDENCE_NOTES_REF} for the tree of ${commit.slice(0, 12)}` };
  });
}

function verdictWithoutEnvelopes(check: string, rules: ReadonlyMap<string, LocalSignerClass[]>, base: string): LocalEvidenceVerdict {
  if (!localEvidenceAllowedFor(check)) return { check, status: "refused", reason: `${check} gates an apply, a release or a gate, so it runs whatever evidence exists` };
  if (!rules.has(check)) return { check, status: "not-accepted", reason: `local.checks in .chant/trust.json at ${base.slice(0, 12)} does not name ${check}` };
  return { check, status: "missing", reason: `no local evidence for ${check}` };
}

/** Whether the policy at `base` takes local evidence for any check, so a job knows whether to fetch the notes at all. */
export function acceptsLocalEvidence(repo: string, base: string): boolean {
  const policy = readTrustPolicy(gitRevisionSource(repo, base), base);
  return policy.problems.length === 0 && (policy.local?.checks ?? []).some((c) => localEvidenceAllowedFor(c.check));
}
