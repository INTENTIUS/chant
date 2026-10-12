/**
 * The chant repo's own workspace declaration reads through
 * `chant workspace status` and validates against the output schema (#2557).
 * It reads the real checkout, 28 members and a git call or more for each,
 * which is 5 to 9 s: split from status-contract.test.ts so the unit budget
 * keeps to fixtures built here (#3880).
 */

import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, test } from "vitest";
import { listWorkspace } from "./ls";
import { workspaceStatus, type StatusDocument } from "./status";
import schema from "./status.schema.json";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

function expectValid(doc: StatusDocument): void {
  expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

function result(doc: StatusDocument): Extract<StatusDocument, { members: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("the chant repo's own declaration", () => {
  test("validates and lists every declared member", async () => {
    const doc = result(await workspaceStatus({ cwd: join(REPO, "packages", "core"), env: "prod", compareTo: "staging" }));
    expectValid(doc);
    expect(doc.workspace).toMatchObject({ name: "chant", root: ".", file: "chant.workspace.json" });
    const ls = listWorkspace({ cwd: REPO });
    if ("error" in ls) throw new Error(ls.error.message);
    expect(doc.members.map((m) => m.name)).toEqual(ls.members.map((m) => m.name));
  });
});
