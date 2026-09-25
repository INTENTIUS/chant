/**
 * The read contract for `chant workspace records --json` (#2536): the output
 * schema is a valid draft 2020-12 document, its closed code lists match the
 * code, and real output validates against it. The reference workspace (#2543)
 * doesn't exist yet, so the chant repo's own decision files stand in for it.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, test } from "vitest";
import { queryRecords, RECORDS_CONTRACT_VERSION, RECORDS_OUTPUT_SCHEMA_ID, type RecordsDocument } from "./records-cli";
import { READ_ERROR_CODES, RECORD_REASON_CODES, RECORD_WARNING_CODES, recordTextDigest, REVIEW_REASON_CODES, SEAL_WARNING_CODES } from "./records";
import { WORK_WARNING_CODES } from "./work";
import { ANSWER_WARNING_CODES } from "./points";
import schema from "./records.schema.json";
import { PROVENANCE_LEVELS } from "./trust/attestor";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const KIND = "docs/design/decisions/decision.kind.mjs";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

function expectValid(doc: RecordsDocument): void {
  const ok = validate(doc);
  expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
}

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A directory holding a copy of the decisions, kind and schema, outside any git repository. */
function copyDecisions(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-records-contract-")));
  scratch.push(root);
  mkdirSync(join(root, "docs", "design"), { recursive: true });
  cpSync(join(REPO, "docs", "design", "decisions"), join(root, "docs", "design", "decisions"), { recursive: true });
  return root;
}

describe("records output schema", () => {
  test("is a valid draft 2020-12 document with the published $id", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(schema.$id).toBe(RECORDS_OUTPUT_SCHEMA_ID);
    expect(RECORDS_CONTRACT_VERSION).toBe(1);
  });

  test("lists exactly the reason and error codes the code can return", () => {
    expect(schema.$defs.reason.properties.code.enum).toEqual([...RECORD_REASON_CODES]);
    expect(schema.$defs.failure.properties.error.properties.code.enum).toEqual([...READ_ERROR_CODES]);
  });

  test("lists exactly the provenance levels (#2547)", () => {
    expect(schema.$defs.provenance.properties.level.enum).toEqual([...PROVENANCE_LEVELS]);
  });

  test("the chant repo's decisions validate, current and not", async () => {
    for (const current of [false, true]) {
      const doc = await queryRecords({ kind: KIND, current, cwd: REPO });
      expectValid(doc);
      expect("error" in doc).toBe(false);
    }
  });

  test("invalid records validate, each with its reason", async () => {
    const root = copyDecisions();
    const dir = join(root, "docs", "design", "decisions");
    writeFileSync(join(dir, "ws-001-trust-root.md"), "no front matter\n");
    writeFileSync(join(dir, "ws-900-extra.md"), "---\nid: \"ws-900\"\nstate: \"decided\"\n---\n");
    const doc = await queryRecords({ kind: KIND, cwd: root });
    expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.at).toBeNull();
    expect(doc.summary.invalid).toBe(2);
  });

  test("a workspace-sourced decision with no evidence validates, with its warning (#2654)", async () => {
    const root = copyDecisions();
    const dir = join(root, "docs", "design", "decisions");
    const text = readFileSync(join(dir, "ws-003-seal-scope.md"), "utf-8")
      .replace(/^id: .*$/m, 'id: "ws-900"')
      .replace(/^source:\n(?:  .*\n)*/m, 'source:\n  kind: "workspace"\n  member: "app"\n')
      .replace(/^evidence:\n(?:  .*\n)*/m, "evidence: []\n");
    writeFileSync(join(dir, "ws-900-extra.md"), text);
    const doc = await queryRecords({ kind: KIND, current: true, cwd: root });
    expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const r = doc.records.find((x) => x.id === "ws-900");
    expect(r?.valid).toBe(true);
    expect(r?.warnings?.map((w) => w.code)).toEqual(["record-no-evidence"]);
  });

  test("lists exactly the codes a verdict is not counted for (#2671)", () => {
    expect(schema.$defs.verdict.properties.reason.properties.code.enum).toEqual([...REVIEW_REASON_CODES]);
  });

  test("every record carries its digest and quorum, and the chant repo's decisions need the default two (#2671, #2672)", async () => {
    const doc = await queryRecords({ kind: KIND, current: true, cwd: REPO });
    if ("error" in doc) throw new Error(doc.error.message);
    for (const r of doc.records) {
      expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(r.quorum).toMatchObject({ need: 2, needFrom: "default", agreed: 0, met: false, metWithObjections: false });
    }
  });

  test("a decision with verdicts validates, with each verdict counted or not and why (#2671, #2672)", async () => {
    const root = copyDecisions();
    const dir = join(root, "docs", "design", "decisions");
    writeFileSync(
      join(root, "chant.workspace.json"),
      JSON.stringify({ name: "w", schema: 1, quorum: 1, members: [{ name: "docs", dir: "docs", kind: "other", because: "decisions only" }] }),
    );
    const base = readFileSync(join(dir, "ws-003-seal-scope.md"), "utf-8").replace(/^id: .*$/m, 'id: "ws-900"');
    const digest = recordTextDigest(base);
    const entry = (reviewer: string, verdict: string, extra = "") => `  - reviewer: "${reviewer}"\n    verdict: "${verdict}"\n    on: "2026-09-24"${extra}`;
    const reviews = [
      entry("alice", "agree", `\n    digest: "${digest}"`),
      entry("Alice ", "agree", `\n    digest: "${digest}"`),
      entry("lex00", "agree"),
      entry("bob", "dissent", `\n    note: "a case is missing"\n    digest: "${"0".repeat(64)}"`),
    ];
    writeFileSync(join(dir, "ws-900-extra.md"), base.replace(/^reviews: \[\]$/m, `reviews:\n${reviews.join("\n")}`));
    const doc = await queryRecords({ kind: KIND, current: true, cwd: root });
    expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const r = doc.records.find((x) => x.id === "ws-900")!;
    expect(r.valid).toBe(true);
    expect(r.digest).toBe(digest);
    expect(r.warnings.map((w) => w.code)).toEqual(["review-undigested"]);
    const q = r.quorum!;
    expect(q).toMatchObject({ need: 1, needFrom: "declaration", agreed: 1, met: true, metWithObjections: true });
    expect(q.counted.map((v) => v.reviewer)).toEqual(["Alice "]);
    expect(q.notCounted.map((v) => [v.reviewer, v.reason?.code])).toEqual([
      ["alice", "review-duplicate"],
      ["lex00", "review-decider"],
      ["bob", "review-older-digest"],
    ]);
    expect(q.openConcerns.map((c) => c.reviewer)).toEqual(["bob"]);
    // A counted verdict with a reason, or a not-counted one without, is refused.
    const bad = structuredClone(doc);
    const record = bad.records.find((x) => x.id === "ws-900")!;
    record.quorum!.counted[0].reason = { code: "review-duplicate", message: "x" };
    expect(validate(bad)).toBe(false);
  });

  test("lists exactly the warning codes the code can return", () => {
    // A work kind's records carry the work warnings too (#2683), work-done-gap-open included since records walks a done item's region (#2686),
    // an answer kind's the answer warnings (ws-058), and records adds record-unattested for an author seal under a signers file at base (#2688).
    expect(schema.$defs.warning.properties.code.enum).toEqual([...RECORD_WARNING_CODES, ...WORK_WARNING_CODES, ...ANSWER_WARNING_CODES, ...SEAL_WARNING_CODES]);
  });

  test("every failure validates with its code", async () => {
    const root = copyDecisions();
    const docs = [
      await queryRecords({ kind: "missing.kind.mjs", cwd: root }),
      await queryRecords({ kind: KIND, at: "HEAD", cwd: root }),
    ];
    for (const doc of docs) expectValid(doc);
    expect(docs.map((d) => ("error" in d ? d.error.code : "ok"))).toEqual(["kind-unreadable", "not-a-git-repository"]);
  });

  test("a document mixing records and an error is refused", () => {
    expect(validate({ $schema: RECORDS_OUTPUT_SCHEMA_ID, contract: 1, error: { code: "revision-unknown", message: "x" }, records: [] })).toBe(false);
  });
});
