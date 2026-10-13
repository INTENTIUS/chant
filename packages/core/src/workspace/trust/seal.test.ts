/**
 * #2687: sealed verdicts. A review counts under a signers file at base only
 * when its reviewer signed it.
 *
 * Each case writes verdicts through `records review` and reads them back
 * through the real `records` query, in a git repository whose base (`main`)
 * holds the signers file, or doesn't. Every document is checked against its
 * published schema.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../../cli/main";
import recordsSchema from "../records.schema.json";
import reviewSchema from "../records-review.schema.json";
import { queryRecords, type RecordView } from "../records-cli";
import { amendRecord, reviewRecord, type ReviewDocument } from "../records-write";
import type { QuorumVerdict } from "../records";
import { REVIEW_SEAL_NAMESPACE, reviewSealPayload } from "./seal";
import { hasSshKeygen, TestRepo, type Key } from "./test-repo";

const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..");
const DECISIONS = join(REPO, "docs", "design", "decisions");
const KIND = "decisions/decision.kind.mjs";
const FILE = "decisions/ws-003-seal-scope.md";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateRecords = ajv.compile(recordsSchema);
const validateReview = ajv.compile(reviewSchema);

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

/**
 * A repository whose main holds ws-003 (decided by lex00) and, unless
 * `signers` is false, a signers file listing alice and bob. The work happens
 * on a branch, so main stays the base.
 */
function workspace(label: string, opts: { signers?: boolean } = {}) {
  const r = new TestRepo(`seal-${label}`);
  repos.push(r);
  const alice = r.key("alice");
  const bob = r.key("bob");
  const mallory = r.key("mallory");
  r.write(KIND, readFileSync(join(DECISIONS, "decision.kind.mjs"), "utf-8"));
  r.write("decisions/decision.schema.json", readFileSync(join(DECISIONS, "decision.schema.json"), "utf-8"));
  r.write(FILE, readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
  if (opts.signers !== false) r.write(".chant/allowed_signers", `alice@example.test ${alice.pub}\nbob@example.test ${bob.pub}\n`);
  r.commit("base", alice);
  r.git(["checkout", "-q", "-b", "change"]);
  return { r, alice, bob, mallory };
}

async function review(r: TestRepo, by: string, sign?: Key | string | true, verdict = "agree"): Promise<ReviewDocument> {
  const doc = await reviewRecord({ kind: KIND, id: "ws-003", verdict, by, cwd: r.dir, on: "2026-09-24", ...(sign !== undefined ? { sign: typeof sign === "object" ? sign.file : sign } : {}) });
  expect(validateReview(doc), JSON.stringify(validateReview.errors)).toBe(true);
  return doc;
}

async function record(r: TestRepo): Promise<RecordView> {
  const doc = await queryRecords({ kind: KIND, cwd: r.dir, base: "main" });
  expect(validateRecords(doc), JSON.stringify(validateRecords.errors)).toBe(true);
  if ("error" in doc) throw new Error(doc.error.message);
  const rec = doc.records.find((x) => x.id === "ws-003")!;
  expect(rec.reasons).toEqual([]);
  return rec;
}

/** Every verdict, counted or not, in list order, as `reviewer:reason code:seal code`. */
function verdicts(rec: RecordView): string[] {
  const q = rec.quorum!;
  return [...q.counted, ...q.notCounted]
    .sort((a, b) => a.index - b.index)
    .map((v: QuorumVerdict) => `${v.reviewer}:${v.reason?.code ?? "counted"}:${v.attestation.code ?? "attested"}`);
}

function verdict(rec: RecordView, index: number): QuorumVerdict {
  const q = rec.quorum!;
  return [...q.counted, ...q.notCounted].find((v) => v.index === index)!;
}

describe.skipIf(!hasSshKeygen)("sealed verdicts under a signers file at base", () => {
  test("a sealed agree counts; an unsealed one, one by an unlisted principal and one signed with another's key do not", async () => {
    const { r, alice, bob, mallory } = workspace("active");
    const sealed = await review(r, "alice@example.test", alice);
    if ("error" in sealed) throw new Error(sealed.error.message);
    expect(sealed.review.seal).toMatchObject({ signer: "alice@example.test", key: expect.stringMatching(/^SHA256:/) });
    await review(r, "bob@example.test");
    await review(r, "mallory@example.test", mallory);
    // alice's key, claiming to be bob.
    await review(r, "Bob@Example.test ", alice);

    const rec = await record(r);
    expect(verdicts(rec)).toEqual([
      "alice@example.test:counted:attested",
      "bob@example.test:review-unattested:seal-missing",
      "mallory@example.test:review-unattested:seal-signer-unlisted",
      "Bob@Example.test :review-unattested:seal-signature-invalid",
    ]);
    const a = verdict(rec, 0);
    expect(a.attested).toBe(true);
    expect(a.attestation.key).toBe((sealed.review.seal as { key: string }).key);
    expect(verdict(rec, 1)).toMatchObject({ attested: false, reason: { message: expect.stringMatching(/carries no seal/) } });
    expect(verdict(rec, 2).reason!.message).toMatch(/mallory@example\.test has no key in \.chant\/allowed_signers at base/);
    expect(verdict(rec, 3).reason!.message).toMatch(/does not verify for Bob@Example\.test/);
    expect(rec.quorum).toMatchObject({ agreed: 1, met: false });
    expect(bob).toBeDefined();
  });

  test("two sealed agrees meet the quorum", async () => {
    const { r, alice, bob } = workspace("met");
    await review(r, "alice@example.test", alice);
    await review(r, "bob@example.test", bob);
    const rec = await record(r);
    expect(rec.quorum).toMatchObject({ agreed: 2, met: true, notCounted: [] });
  });

  test("an amendment leaves a sealed verdict on the older digest, and rewriting its digest breaks the seal", async () => {
    const { r, alice } = workspace("amend");
    await review(r, "alice@example.test", alice);
    const before = await record(r);
    const amended = await amendRecord({ kind: KIND, id: "ws-003", fields: JSON.stringify({ evidence: [] }), cwd: r.dir });
    expect("error" in amended ? amended.error : null).toBeNull();

    const after = await record(r);
    expect(after.digest).not.toBe(before.digest);
    // The seal still verifies over the text it judged; the verdict stops counting because the text moved.
    expect(verdicts(after)).toEqual(["alice@example.test:review-older-digest:attested"]);

    // Bringing the verdict up to date by hand, without a new signature.
    const path = join(r.dir, FILE);
    writeFileSync(path, readFileSync(path, "utf-8").replace(before.digest, after.digest));
    const forged = await record(r);
    expect(forged.digest).toBe(after.digest);
    expect(verdicts(forged)).toEqual(["alice@example.test:review-unattested:seal-signature-invalid"]);
    expect(verdict(forged, 0).attested).toBe(false);
  });

  test("attack: a seal lifted from another verdict, or made in the commit namespace, does not verify", async () => {
    const { r, alice } = workspace("lift");
    // An abstain, turned into an agree by hand: the seal covers the verdict.
    await review(r, "alice@example.test", alice, "abstain");
    const path = join(r.dir, FILE);
    writeFileSync(path, readFileSync(path, "utf-8").replace('verdict: "abstain"', 'verdict: "agree"'));
    let rec = await record(r);
    expect(verdicts(rec)).toEqual(["alice@example.test:review-unattested:seal-signature-invalid"]);

    // A good signature by alice over the right bytes, in the git namespace.
    const text = readFileSync(path, "utf-8");
    const payload = reviewSealPayload("ws-003", rec.digest, "agree", "alice@example.test", "2026-09-24");
    const gitSig = r.sshSign(alice, payload, "git");
    const current = /signature: ("[^"]*")/.exec(text)![1];
    writeFileSync(path, text.replace(current, JSON.stringify(gitSig)));
    rec = await record(r);
    expect(verdicts(rec)).toEqual(["alice@example.test:review-unattested:seal-signature-invalid"]);

    // The same bytes in the review namespace do verify, which shows it was the namespace.
    writeFileSync(path, text.replace(current, JSON.stringify(r.sshSign(alice, payload, REVIEW_SEAL_NAMESPACE))));
    rec = await record(r);
    expect(verdicts(rec)).toEqual(["alice@example.test:counted:attested"]);
  });

  test("--sign with no file uses git's ssh user.signingkey", async () => {
    const { r, bob } = workspace("gitkey");
    r.git(["config", "gpg.format", "ssh"]);
    r.git(["config", "user.signingkey", bob.file]);
    const doc = await review(r, "bob@example.test", true);
    expect("error" in doc ? doc.error : null).toBeNull();
    expect(verdicts(await record(r))).toEqual(["bob@example.test:counted:attested"]);
  });

  test("a key that can't sign is refused with review-sign-failed, and nothing is written", async () => {
    const { r } = workspace("nokey");
    const before = readFileSync(join(r.dir, FILE), "utf-8");
    const doc = await review(r, "alice@example.test", join(r.dir, "no-such-key"));
    expect("error" in doc && doc.error.code).toBe("review-sign-failed");
    r.git(["config", "gpg.format", "openpgp"]);
    const git = await review(r, "alice@example.test", true);
    expect("error" in git && git.error.message).toMatch(/gpg\.format openpgp/);
    expect(readFileSync(join(r.dir, FILE), "utf-8")).toBe(before);
  });
});

describe.skipIf(!hasSshKeygen)("sealed verdicts with no signers file at base", () => {
  test("an unsealed verdict counts, and a seal is checked for integrity and reported without gating", async () => {
    const { r, alice, bob } = workspace("inactive", { signers: false });
    await review(r, "carol");
    await review(r, "alice@example.test", alice);
    await review(r, "bob@example.test", bob, "abstain");
    const path = join(r.dir, FILE);
    // bob's abstain turned into an agree by hand: its seal no longer covers it.
    writeFileSync(path, readFileSync(path, "utf-8").replace('verdict: "abstain"', 'verdict: "agree"'));
    const rec = await record(r);
    expect(verdicts(rec)).toEqual([
      "carol:counted:seal-missing",
      "alice@example.test:counted:seal-unverifiable",
      "bob@example.test:counted:seal-signature-invalid",
    ]);
    expect(verdict(rec, 0).attested).toBeNull();
    expect(verdict(rec, 1)).toMatchObject({ attested: null, attestation: { key: expect.stringMatching(/^SHA256:/), message: expect.stringMatching(/intact/) } });
    expect(verdict(rec, 2).attested).toBe(false);
    expect(rec.quorum).toMatchObject({ agreed: 3, met: true });
  });
});

describe("--sign on the command line", () => {
  test("takes a key file, or nothing for git's key", () => {
    expect(parseArgs(["workspace", "records", "review", "ws-003", "--sign", "~/.ssh/id_ed25519", "--by", "a"]).sign).toBe("~/.ssh/id_ed25519");
    expect(parseArgs(["workspace", "records", "review", "ws-003", "--sign", "--by", "a"]).sign).toBe(true);
    expect(parseArgs(["workspace", "records", "review", "ws-003", "--by", "a", "--sign"]).sign).toBe(true);
    expect(parseArgs(["workspace", "records", "review", "ws-003", "--by", "a"]).sign).toBeUndefined();
  });

  test("records new and amend take it too, for the author seal (#2688)", () => {
    expect(parseArgs(["workspace", "records", "new", "decisions/decision.kind.mjs", "--from", "-", "--sign"]).sign).toBe(true);
    expect(parseArgs(["workspace", "records", "amend", "ws-003", "--set", "-", "--sign", "k"]).sign).toBe("k");
  });
});
