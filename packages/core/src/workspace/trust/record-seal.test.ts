/**
 * #2688: author seals. `records new --sign` and `records amend --sign` seal a
 * record's author (decided_by for decisions), and `records` reports whether
 * the seal verifies against the signers file at base.
 *
 * Each case writes through the real write commands and reads back through
 * the real `records` query, in a git repository whose base (`main`) holds
 * the signers file, or doesn't. Every document is checked against its
 * published schema.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterEach, describe, expect, test } from "vitest";
import recordsSchema from "../records.schema.json";
import newSchema from "../records-new.schema.json";
import amendSchema from "../records-amend.schema.json";
import { queryRecords, type RecordView } from "../records-cli";
import { amendRecord, newRecord, reviewRecord, type AmendDocument, type NewDocument } from "../records-write";
import { parseFrontMatter, recordTextDigest } from "../records";
import { RECORD_SEAL_NAMESPACE, recordSealPayload } from "./seal";
import { hasSshKeygen, TestRepo, type Key } from "./test-repo";

const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..");
const DECISIONS = join(REPO, "docs", "design", "decisions");
const KIND = "decisions/decision.kind.mjs";
const FILE = "decisions/ws-003-seal-scope.md";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateRecords = ajv.compile(recordsSchema);
const validateNew = ajv.compile(newSchema);
const validateAmend = ajv.compile(amendSchema);

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

/**
 * A repository whose main holds ws-003 (decided by lex00) and, unless
 * `signers` is false, a signers file listing lex00 and alice. The work
 * happens on a branch, so main stays the base.
 */
function workspace(label: string, opts: { signers?: boolean } = {}) {
  const r = new TestRepo(`record-seal-${label}`);
  repos.push(r);
  const lex = r.key("lex00");
  const alice = r.key("alice");
  const mallory = r.key("mallory");
  r.write(KIND, readFileSync(join(DECISIONS, "decision.kind.mjs"), "utf-8"));
  r.write("decisions/decision.schema.json", readFileSync(join(DECISIONS, "decision.schema.json"), "utf-8"));
  r.write(FILE, readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
  if (opts.signers !== false) r.write(".chant/allowed_signers", `lex00 ${lex.pub}\nalice@example.test ${alice.pub}\n`);
  r.commit("base", lex);
  r.git(["checkout", "-q", "-b", "change"]);
  return { r, lex, alice, mallory };
}

/** ws-003's fields with `over` laid on top and no id, for `records new`. */
function fields(over: Record<string, unknown> = {}): string {
  const fm = parseFrontMatter(readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  const data: Record<string, unknown> = { ...fm.value, title: "Sealed", ...over };
  delete data.id;
  return JSON.stringify(data);
}

async function create(r: TestRepo, key?: Key | string | true, over: Record<string, unknown> = {}): Promise<NewDocument> {
  const doc = await newRecord({ kind: KIND, fields: fields(over), cwd: r.dir, ...(key !== undefined ? { sign: typeof key === "object" ? key.file : key } : {}) });
  expect(validateNew(doc), JSON.stringify(validateNew.errors)).toBe(true);
  return doc;
}

async function amend(r: TestRepo, set: Record<string, unknown>, key?: Key, id = "ws-003"): Promise<AmendDocument> {
  const doc = await amendRecord({ kind: KIND, id, fields: JSON.stringify(set), cwd: r.dir, ...(key ? { sign: key.file } : {}) });
  expect(validateAmend(doc), JSON.stringify(validateAmend.errors)).toBe(true);
  return doc;
}

async function record(r: TestRepo, id = "ws-003"): Promise<RecordView> {
  const doc = await queryRecords({ kind: KIND, cwd: r.dir, base: "main" });
  expect(validateRecords(doc), JSON.stringify(validateRecords.errors)).toBe(true);
  if ("error" in doc) throw new Error(doc.error.message);
  const rec = doc.records.find((x) => x.id === id)!;
  expect(rec.reasons).toEqual([]);
  return rec;
}

const warningCodes = (rec: RecordView) => rec.warnings.map((w) => w.code);

describe("the digest leaves a top-level seal out (#2688)", () => {
  const base = readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8");
  const digest = recordTextDigest(base, ["reviews", "seal"]);

  test("a record with no seal hashes as it did before author seals, and adding one anywhere in the front matter leaves it", () => {
    expect(digest).toBe(recordTextDigest(base, "reviews"));
    const seal = 'seal:\n  signer: "lex00"\n  key: "SHA256:abc"\n  signature: "-----BEGIN SSH SIGNATURE-----\\nx\\n-----END SSH SIGNATURE-----\\n"';
    const atEnd = base.replace("\n---\n\n# Seal scope", `\n${seal}\n---\n\n# Seal scope`);
    const atStart = base.replace("---\nschema: 1\n", `---\n${seal}\nschema: 1\n`);
    const beforeReviews = base.replace("\nreviews: []\n", `\n${seal}\nreviews: []\n`);
    for (const t of [atEnd, atStart, beforeReviews]) {
      expect(t).not.toBe(base);
      expect(recordTextDigest(t, ["reviews", "seal"])).toBe(digest);
      expect(recordTextDigest(t, ["seal", "reviews"])).toBe(digest);
    }
    // Only a top-level key counts: a seal nested in a verdict is the reviews block's.
    expect(recordTextDigest(base.replace("title: ", "sealed: true\ntitle: "), ["reviews", "seal"])).not.toBe(digest);
  });

  test("for a JSON record, the member rule removes reviews, then seal", () => {
    const json = (o: object) => `${JSON.stringify(o, null, 2)}\n`;
    const bare = json({ id: "x-001", decided_by: "lex00", state: "decided" });
    const d = recordTextDigest(bare, ["reviews", "seal"], "json");
    expect(d).toBe(recordTextDigest(bare, "reviews", "json"));
    for (const o of [
      { id: "x-001", decided_by: "lex00", state: "decided", reviews: [], seal: { signer: "lex00" } },
      { id: "x-001", seal: { signer: "lex00" }, decided_by: "lex00", reviews: [], state: "decided" },
      { seal: { signer: "lex00" }, id: "x-001", decided_by: "lex00", state: "decided", reviews: [{ reviewer: "a" }] },
    ]) {
      expect(recordTextDigest(json(o), ["reviews", "seal"], "json")).toBe(d);
    }
  });
});

describe.skipIf(!hasSshKeygen)("author seals under a signers file at base", () => {
  test("records new --sign writes a sealed record that reads as attested, and an unsealed one is read with record-unattested", async () => {
    const { r, lex } = workspace("new");
    const doc = await create(r, lex);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.seal).toMatchObject({ signer: "lex00", key: expect.stringMatching(/^SHA256:/) });
    const text = readFileSync(join(r.dir, doc.path), "utf-8");
    expect(text).toContain('\nseal:\n  signer: "lex00"\n');

    const sealed = await record(r, doc.id);
    expect(sealed.attested).toBe(true);
    expect(sealed.attestation).toMatchObject({ key: doc.seal!.key, message: expect.stringMatching(/sealed by lex00/) });
    expect(sealed.attestation!.code).toBeUndefined();
    expect(warningCodes(sealed)).not.toContain("record-unattested");

    // ws-003 on main carries no seal: reported, and still read.
    const plain = await record(r);
    expect(plain).toMatchObject({ attested: false, valid: true, attestation: { code: "seal-missing" } });
    expect(plain.warnings.find((w) => w.code === "record-unattested")!.message).toMatch(/ws-003 carries no seal/);
  });

  test("the seal signs id, digest, decided_by and state in chant-record, so a hand-editor can verify it with ssh-keygen", async () => {
    const { r, lex } = workspace("hand");
    const doc = await create(r, lex);
    if ("error" in doc) throw new Error(doc.error.message);
    const rec = await record(r, doc.id);
    const payload = recordSealPayload(doc.id, rec.digest, "lex00", "decided");
    expect(payload.toString()).toBe(`${doc.id}\n${rec.digest}\nlex00\ndecided`);
    const sig = join(r.dir, "record.sig");
    writeFileSync(sig, doc.seal!.signature);
    // Throws when the signature does not verify.
    execFileSync("ssh-keygen", ["-Y", "verify", "-f", join(r.dir, ".chant/allowed_signers"), "-I", "lex00", "-n", RECORD_SEAL_NAMESPACE, "-s", sig], { input: payload, stdio: ["pipe", "ignore", "ignore"] });
  });

  test("a review on a sealed record leaves the seal holding: the digest leaves both out", async () => {
    const { r, lex, alice } = workspace("review");
    await amend(r, {}, lex);
    const before = await record(r);
    expect(before.attested).toBe(true);
    const review = await reviewRecord({ kind: KIND, id: "ws-003", verdict: "agree", by: "alice@example.test", cwd: r.dir, on: "2026-09-24", sign: alice.file });
    expect("error" in review ? review.error : null).toBeNull();
    const after = await record(r);
    expect(after.digest).toBe(before.digest);
    expect(after.attested).toBe(true);
    expect(after.quorum!.counted.map((v) => v.reviewer)).toEqual(["alice@example.test"]);
  });

  test("amend --sign signs again over the new digest", async () => {
    const { r, lex } = workspace("resign");
    const first = await amend(r, {}, lex);
    if ("error" in first) throw new Error(first.error.message);
    expect(first.changed).toEqual(["seal"]);
    const before = await record(r);

    const second = await amend(r, { evidence: [] }, lex);
    if ("error" in second) throw new Error(second.error.message);
    expect(second.changed).toEqual(["evidence", "seal"]);
    expect(second.sealDropped).toBeUndefined();
    expect(second.seal!.signature).not.toBe(first.seal!.signature);
    const after = await record(r);
    expect(after.digest).not.toBe(before.digest);
    expect(after.attested).toBe(true);
    expect(warningCodes(after)).not.toContain("record-unattested");

    // Nothing to change and the same key: the same seal, so nothing is written.
    const again = await amend(r, {}, lex);
    expect("error" in again ? again.error : again.changed).toEqual([]);
  });

  test("amend without --sign drops the seal and says so, so the record never carries one that fails", async () => {
    const { r, lex } = workspace("drop");
    await amend(r, {}, lex);
    const doc = await amend(r, { evidence: [] });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.changed).toEqual(["evidence", "seal"]);
    expect(doc.sealDropped).toMatch(/ws-003 was sealed by lex00, and the amendment moves its digest, so the seal was removed: seal it again with records amend ws-003 --sign/);
    expect(readFileSync(join(r.dir, FILE), "utf-8")).not.toMatch(/^seal:/m);
    // Changing only the reviews leaves the digest, so the seal stays.
    await amend(r, {}, lex);
    const reviewsOnly = await amend(r, { reviews: [{ reviewer: "alice@example.test", verdict: "abstain", on: "2026-09-24" }] });
    if ("error" in reviewsOnly) throw new Error(reviewsOnly.error.message);
    expect(reviewsOnly.changed).toEqual(["reviews"]);
    expect(reviewsOnly.sealDropped).toBeUndefined();
    expect((await record(r)).attested).toBe(true);
    const moved = await amend(r, { evidence: [{ title: "a link", url: "https://example.test/a" }] });
    expect("error" in moved ? moved.error : moved.sealDropped).toMatch(/the seal was removed/);
    const rec = await record(r);
    expect(rec).toMatchObject({ attested: false, attestation: { code: "seal-missing" } });
    expect(warningCodes(rec)).toContain("record-unattested");
  });

  test("a stale seal left by hand fails, and an edited state fails", async () => {
    const { r, lex } = workspace("stale");
    await amend(r, {}, lex);
    const path = join(r.dir, FILE);
    // An evidence change made by hand, keeping the old seal.
    writeFileSync(path, readFileSync(path, "utf-8").replace('as_of: null', 'as_of: "2026-09-24T00:00:00Z"'));
    let rec = await record(r);
    expect(rec).toMatchObject({ attested: false, attestation: { code: "seal-signature-invalid" } });
    expect(warningCodes(rec)).toContain("record-unattested");

    // The state is signed too: a decided record hand-promoted to ratified no longer verifies.
    await amend(r, { evidence: JSON.parse(JSON.stringify(rec.data!.evidence)) }, lex);
    expect((await record(r)).attested).toBe(true);
    writeFileSync(path, readFileSync(path, "utf-8").replace('state: "decided"', 'state: "ratified"'));
    rec = await record(r);
    expect(rec.attestation!.code).toBe("seal-signature-invalid");
  });

  test("a signer not in the file: the seal verifies nowhere, and the record is read with record-unattested", async () => {
    const { r, mallory } = workspace("unlisted");
    // decided_by names mallory, whose key the signers file at base doesn't list.
    const doc = await create(r, mallory, { decided_by: "mallory" });
    if ("error" in doc) throw new Error(doc.error.message);
    const rec = await record(r, doc.id);
    expect(rec).toMatchObject({ attested: false, valid: true, attestation: { code: "seal-signer-unlisted", message: expect.stringMatching(/mallory has no key in \.chant\/allowed_signers at base/) } });
    expect(warningCodes(rec)).toContain("record-unattested");

    // Another listed signer's key, claiming to be lex00: signed with alice's key for decided_by lex00.
    const { r: r2, alice } = workspace("wrongkey");
    const forged = await create(r2, alice);
    if ("error" in forged) throw new Error(forged.error.message);
    expect((await record(r2, forged.id)).attestation!.code).toBe("seal-signature-invalid");
  });

  test("provenance and the author seal are reported side by side, each on its own terms", async () => {
    const { r, lex } = workspace("provenance");
    await amend(r, {}, lex);
    // Uncommitted: the commit vouches for nothing, and the seal still verifies.
    let rec = await record(r);
    expect(rec.provenance.level).toBe("unattested");
    expect(rec.attested).toBe(true);
    // Committed with lex00's signature: both hold.
    r.commit("seal ws-003", lex);
    rec = await record(r);
    expect(rec.provenance).toMatchObject({ level: "attested", principal: "lex00" });
    expect(rec.attested).toBe(true);
    // An unsigned commit of an unsealed amendment: neither holds.
    await amend(r, { evidence: [] });
    r.commit("unsigned");
    rec = await record(r);
    expect(rec.provenance.level).toBe("unattested");
    expect(rec.attested).toBe(false);
  });
});

describe.skipIf(!hasSshKeygen)("author seals with no signers file at base", () => {
  test("an unsealed record carries no warning, and a seal is checked for integrity only", async () => {
    const { r, lex } = workspace("inactive", { signers: false });
    const plain = await record(r);
    expect(plain).toMatchObject({ attested: null, attestation: { code: "seal-missing" } });
    expect(warningCodes(plain)).not.toContain("record-unattested");
    await amend(r, {}, lex);
    const sealed = await record(r);
    expect(sealed).toMatchObject({ attested: null, attestation: { code: "seal-unverifiable", key: expect.stringMatching(/^SHA256:/), message: expect.stringMatching(/intact/) } });
    expect(warningCodes(sealed)).not.toContain("record-unattested");
  });
});

describe.skipIf(!hasSshKeygen)("refusals", () => {
  test("a record with no decided_by has no author to seal: record-sign-failed, and nothing is written", async () => {
    const { r, lex } = workspace("noauthor");
    const doc = await create(r, lex, { state: "proposed", choice: null, decided_by: null, decided_on: null });
    expect("error" in doc && doc.error).toMatchObject({ code: "record-sign-failed", message: expect.stringMatching(/names no decided_by/) });
    expect(r.git(["status", "--porcelain"]).trim()).toBe("");
    // A proposal names no author, so it is not warned about under the signers file.
    const unsigned = await create(r, undefined, { state: "proposed", choice: null, decided_by: null, decided_on: null });
    if ("error" in unsigned) throw new Error(unsigned.error.message);
    const rec = await record(r, unsigned.id);
    expect(rec).toMatchObject({ attested: null, attestation: { code: "seal-missing" } });
    expect(warningCodes(rec)).not.toContain("record-unattested");
  });

  test("a key that can't sign is record-sign-failed; seal in the fields is write-input-invalid; a closed record takes no seal", async () => {
    const { r, lex } = workspace("refuse");
    const before = readFileSync(join(r.dir, FILE), "utf-8");
    const bad = await amend(r, {}, { name: "x", file: join(r.dir, "no-such-key"), pub: "" });
    expect("error" in bad && bad.error.code).toBe("record-sign-failed");
    const set = await amend(r, { seal: { signer: "lex00", key: "SHA256:x", signature: "x" } });
    expect("error" in set && set.error.code).toBe("write-input-invalid");
    const from = await create(r, undefined, { seal: { signer: "lex00" } });
    expect("error" in from && from.error.code).toBe("write-input-invalid");
    expect(readFileSync(join(r.dir, FILE), "utf-8")).toBe(before);

    await amend(r, { state: "ratified" });
    const closed = await amend(r, {}, lex);
    expect("error" in closed && closed.error.code).toBe("record-closed");
  });
});
