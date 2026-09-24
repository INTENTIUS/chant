/**
 * The read contract for `chant workspace check --json` and `--format json`
 * (#2536, #2524 D15): the output schema is a valid draft 2020-12 document, its
 * closed code lists match the code, and real output validates against it, for
 * the chant repo (#2557), for built workspaces, and for `--at <rev>`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, declaration, git, REPO, repo, scratchDir, validSchema } from "./__fixtures__/contract-repo";
import schema from "./check.schema.json";
import { WORKSPACE_ERROR_CODES } from "./declaration";
import { CHECK_CODES, CHECK_CONTRACT_VERSION, CHECK_ERROR_CODES, CHECK_OUTPUT_SCHEMA_ID, runChecks, type CheckDocument } from "./lineage-check";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

function result(doc: CheckDocument): Extract<CheckDocument, { findings: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const ruleIds = (doc: Extract<CheckDocument, { findings: unknown }>) => doc.declaration?.diagnostics.map((d) => d.ruleId) ?? [];

describe("check output schema", () => {
  test("is a valid draft 2020-12 document with the published $id", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(CHECK_OUTPUT_SCHEMA_ID);
    expect(CHECK_CONTRACT_VERSION).toBe(1);
  });

  test("lists exactly the codes the code can return", () => {
    expect(schema.$defs.lockFinding.properties.code.enum).toEqual([...CHECK_CODES]);
    expect(schema.$defs.failure.properties.error.properties.code.enum).toEqual([...CHECK_ERROR_CODES]);
    expect(schema.$defs.diagnostic.properties.code.enum).toEqual([...WORKSPACE_ERROR_CODES]);
  });
});

describe("chant workspace check on the chant repo (#2557)", () => {
  test("validates in the working tree and at HEAD", async () => {
    const now = result(await runChecks(REPO));
    expectValid(now);
    expect(now.workspace).toEqual({ name: "chant", root: "." });
    expect(now.declaration?.file).toBe("chant.workspace.json");

    const head = result(await runChecks(join(REPO, "packages", "core"), "HEAD"));
    expectValid(head);
    expect(head.at).toBe(git(REPO, "rev-parse", "HEAD"));
    expect(head.workspace).toEqual({ name: "chant", root: "." });
    expect(head.declaration?.file).toBe("../../chant.workspace.json");
  });
});

describe("chant workspace check on built workspaces", () => {
  test("a lock with no declaration: the lock findings carry their reason code", async () => {
    const root = repo({ ".chant/workspace.lock.json": "{ not json" });
    const doc = result(await runChecks(root));
    expectValid(doc);
    expect(doc.workspace).toBeNull();
    expect(doc.declaration).toBeUndefined();
    expect(doc.ok).toBe(false);
    expect(doc.findings.map((f) => f.code)).toEqual(["lock-invalid"]);
  });

  test("declaration findings carry WSP ids, and an unreadable declaration is WSP001 with its reason code", async () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "gone", dir: "gone", kind: "chant" },
        { name: "infra", dir: "infra", kind: "terraform" },
      ]),
      "infra/main.tf": "",
    });
    const doc = result(await runChecks(root));
    expectValid(doc);
    expect(doc.ok).toBe(false);
    expect(doc.workspace).toEqual({ name: "acme", root: "." });
    expect(ruleIds(doc)).toEqual(["WSP004", "WSP003"]);

    const tooOld = repo({ "chant.workspace.json": declaration([], { minReader: "999.0.0" }) });
    const pinned = repo({ "chant.workspace.json": declaration([], { pins: [{ package: "@intentius/chant", version: "0.0.1" }] }) });
    for (const [dir, code] of [
      [tooOld, "reader-too-old"],
      [pinned, "root-chant-required"],
    ] as const) {
      const d = result(await runChecks(dir));
      expectValid(d);
      expect(d.workspace).toEqual({ name: null, root: "." });
      expect(d.declaration?.diagnostics.map((x) => [x.ruleId, x.code])).toEqual([["WSP001", code]]);
    }
  });

  test("--at <rev> checks the declaration and lock as they were at the revision", async () => {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "web", dir: "web", kind: "chant" }]),
      "web/chant.config.ts": "",
    });
    const first = commitAll(root, "one");
    // Break the working tree after the commit: the declaration, a member and the lock.
    writeFileSync(join(root, "chant.workspace.json"), "{ broken");
    mkdirSync(join(root, "web", ".chant"), { recursive: true });
    writeFileSync(join(root, "web", ".chant", "workspace.lock.json"), "{ broken");

    const at = result(await runChecks(join(root, "web"), first));
    expectValid(at);
    expect(at.at).toBe(first);
    expect(at.ok).toBe(true);
    expect(at.lock).toBeNull();
    expect(at.declaration).toMatchObject({ file: "../chant.workspace.json", diagnostics: [], ok: true });

    const now = result(await runChecks(join(root, "web")));
    expectValid(now);
    expect(now.ok).toBe(false);
    expect(now.findings.map((f) => f.code)).toEqual(["lock-invalid"]);
    expect(now.declaration?.diagnostics.map((d) => [d.ruleId, d.code])).toEqual([["WSP001", "declaration-unparseable"]]);
  });

  test("--at outside git or at an unknown revision is a failure document", async () => {
    const outside = scratchDir("chant-check-nogit-");
    const empty = repo({});
    const docs = [await runChecks(outside, "HEAD"), await runChecks(empty, "no-such-rev")];
    for (const d of docs) expectValid(d);
    expect(docs.map((d) => ("error" in d ? d.error.code : "ok"))).toEqual(["not-a-git-repository", "revision-unknown"]);
  });
});
