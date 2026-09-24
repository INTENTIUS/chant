/**
 * The write contract for `chant workspace records new|amend|review` (#2670):
 * each output schema is a valid draft 2020-12 document under the workspace
 * schema scheme, its closed code list matches the code, and real output,
 * written, dry-run and refused, validates against it.
 */

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, test } from "vitest";
import { RECORD_WARNING_CODES } from "./records";
import amendSchema from "./records-amend.schema.json";
import newSchema from "./records-new.schema.json";
import reviewSchema from "./records-review.schema.json";
import {
  AMEND_ERROR_CODES,
  amendRecord,
  NEW_ERROR_CODES,
  newRecord,
  RECORDS_AMEND_SCHEMA_ID,
  RECORDS_NEW_SCHEMA_ID,
  RECORDS_REVIEW_SCHEMA_ID,
  RECORDS_WRITE_CONTRACT_VERSION,
  REVIEW_ERROR_CODES,
  reviewRecord,
} from "./records-write";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const KIND = "docs/design/decisions/decision.kind.mjs";

const ajv = new Ajv2020({ strict: true, allErrors: true });

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A directory holding a copy of the chant repo's decisions, outside any git repository. */
function copyDecisions(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-records-write-contract-")));
  scratch.push(root);
  mkdirSync(join(root, "docs", "design"), { recursive: true });
  cpSync(join(REPO, "docs", "design", "decisions"), join(root, "docs", "design", "decisions"), { recursive: true });
  return root;
}

const SCHEMAS = [
  { name: "records-new", schema: newSchema, id: RECORDS_NEW_SCHEMA_ID, codes: NEW_ERROR_CODES },
  { name: "records-amend", schema: amendSchema, id: RECORDS_AMEND_SCHEMA_ID, codes: AMEND_ERROR_CODES },
  { name: "records-review", schema: reviewSchema, id: RECORDS_REVIEW_SCHEMA_ID, codes: REVIEW_ERROR_CODES },
] as const;

function expectValid(schema: object, doc: unknown): void {
  const validate = ajv.getSchema((schema as { $id: string }).$id) ?? ajv.compile(schema);
  expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

describe.each(SCHEMAS)("$name output schema", ({ name, schema, id, codes }) => {
  test("is a valid draft 2020-12 document under the workspace scheme, at contract 1", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(schema.$id).toBe(id);
    expect(id).toBe(`https://intentius.io/chant/schemas/workspace/${name}/v1/${name}.schema.json`);
    expect(RECORDS_WRITE_CONTRACT_VERSION).toBe(1);
    for (const branch of ["result", "failure"] as const) {
      expect(schema.$defs[branch].properties.contract).toEqual({ const: 1 });
      expect(schema.$defs[branch].properties.$schema).toEqual({ const: id });
    }
  });

  test("lists exactly the error and warning codes the code can return", () => {
    expect(schema.$defs.failure.properties.error.properties.code.enum).toEqual([...codes]);
    expect(schema.$defs.warning.properties.code.enum).toEqual([...RECORD_WARNING_CODES]);
  });

  test("refuses a document mixing a result and an error", () => {
    const validate = ajv.getSchema(id) ?? ajv.compile(schema);
    expect(validate({ $schema: id, contract: 1, error: { code: "record-not-found", message: "x" }, path: "a.md" })).toBe(false);
  });
});

describe("real output validates", () => {
  const fields = JSON.stringify({
    schema: 1,
    title: "A decision written through chant",
    state: "proposed",
    area: "D4",
    source: { kind: "workspace", member: "app" },
    question: "Does the write contract hold?",
    options: [{ id: "a", label: "yes", how: null, tradeoff: null }],
    choice: null,
    rejected: [],
    supersedes: [],
    evidence: [],
    decided_by: null,
    decided_on: null,
    reviews: [],
    constrains: ["INTENTIUS/chant#2670"],
  });

  test("records new, as a dry run against the chant repo's own decisions", async () => {
    const doc = await newRecord({ kind: KIND, fields, dryRun: true, cwd: REPO });
    expectValid(newSchema, doc);
    expect(doc).toMatchObject({ dryRun: true, path: expect.stringMatching(/^docs\/design\/decisions\/ws-\d{3}-a-decision-written-through-chant\.md$/) });
  });

  test("each command written, dry-run and refused", async () => {
    const root = copyDecisions();
    const made = await newRecord({ kind: KIND, fields, cwd: root });
    expectValid(newSchema, made);
    if ("error" in made) throw new Error(made.error.message);
    expectValid(newSchema, await newRecord({ kind: KIND, fields: "[]", cwd: root }));
    expectValid(newSchema, await newRecord({ kind: "missing.kind.mjs", fields, cwd: root }));

    for (const dryRun of [true, false]) expectValid(amendSchema, await amendRecord({ kind: KIND, id: made.id, fields: JSON.stringify({ area: "D5" }), dryRun, cwd: root }));
    expectValid(amendSchema, await amendRecord({ kind: KIND, id: "ws-003", fields: JSON.stringify({ title: "x" }), cwd: root }));

    for (const dryRun of [true, false]) {
      expectValid(reviewSchema, await reviewRecord({ kind: KIND, id: made.id, verdict: "dissent", by: "alice", note: "Not yet.", session: "S-0001", dryRun, cwd: root }));
    }
    expectValid(reviewSchema, await reviewRecord({ kind: KIND, id: made.id, verdict: "dissent", by: "alice", cwd: root }));
  });
});
