/**
 * The read contract for `chant workspace records --json` (#2536): the output
 * schema is a valid draft 2020-12 document, its closed code lists match the
 * code, and real output validates against it. The reference workspace (#2543)
 * doesn't exist yet, so the chant repo's own decision files stand in for it.
 */

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, test } from "vitest";
import { queryRecords, RECORDS_CONTRACT_VERSION, RECORDS_OUTPUT_SCHEMA_ID, type RecordsDocument } from "./records-cli";
import { READ_ERROR_CODES, RECORD_REASON_CODES } from "./records";
import schema from "./records.schema.json";

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
