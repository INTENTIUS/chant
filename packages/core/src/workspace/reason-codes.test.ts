/**
 * One closed list of reason codes (#2536, #2524 D15): every command's own
 * list is a subset of `REASON_CODES`, together they cover it, the output
 * schemas name nothing outside it, and no source file under `workspace/`
 * emits a code outside it. The read-contract page documents every code.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO } from "./__fixtures__/contract-repo";
import { CHANGES_ERROR_CODES, CHANGES_FINDING_CODES } from "./changes";
import { MEMBER_RUN_REASON_CODES } from "./compose-graph";
import { COMPOSITES_ENVIRONMENT_REASON_CODES, COMPOSITES_ERROR_CODES, COMPOSITES_REASON_CODES, COMPOSITES_RUNTIME_REASON_CODES } from "./composites";
import { WORKSPACE_ERROR_CODES } from "./declaration";
import { GRAPH_ERROR_CODES } from "./graph-cli";
import { INTENT_ERROR_CODES, INTENT_FINDING_CODES, INTENT_REASON_CODES } from "./intent";
import { CHECK_CODES, CHECK_ERROR_CODES } from "./lineage-check";
import { GROUP_REASON_CODES, MEMBER_REASON_CODES } from "./ls";
import intentSchema from "./intent.schema.json";
import { isPluginCode, isReasonCode, REASON_CODES, REASONS } from "./reason-codes";
import { contract } from "./__fixtures__/contract-repo";
import { READ_ERROR_CODES, RECORD_REASON_CODES, RECORD_WARNING_CODES, REVIEW_REASON_CODES, SEAL_REASON_CODES, SEAL_WARNING_CODES } from "./records";
import { AMEND_ERROR_CODES, NEW_ERROR_CODES, REVIEW_ERROR_CODES } from "./records-write";
import { CLOSE_ERROR_CODES } from "./records-close";
import { RECORDS_SINCE_ERROR_CODES, RECORDS_SINCE_REASON_CODES } from "./records-since";
import { STATUS_ERROR_CODES, STATUS_GATE_REASON_CODES, STATUS_REASON_CODES, STATUS_STEWARD_REASON_CODES } from "./status";
import { WORK_WARNING_CODES } from "./work";
import { BOX_FINDING_CODES } from "./checks/boxes";
import { WORK_ERROR_CODES, WORK_LEASE_REFUSALS } from "./work-cli";
import { WORK_EVIDENCE_ERROR_CODES } from "./work-evidence";
import { RECORD_FINDING_CODES } from "./checks/records";
import { ANSWER_WARNING_CODES } from "./points";
import { POINTS_ERROR_CODES, POINTS_SOURCE_REASON_CODES } from "./points-cli";
import { POINTS_WRITE_ERROR_CODES } from "./decide";

const HERE = import.meta.dirname;

const PER_COMMAND: Record<string, readonly string[]> = {
  WORKSPACE_ERROR_CODES,
  MEMBER_REASON_CODES,
  GROUP_REASON_CODES,
  MEMBER_RUN_REASON_CODES,
  GRAPH_ERROR_CODES,
  CHECK_CODES,
  CHECK_ERROR_CODES,
  BOX_FINDING_CODES,
  STATUS_REASON_CODES,
  STATUS_ERROR_CODES,
  STATUS_GATE_REASON_CODES,
  STATUS_STEWARD_REASON_CODES,
  RECORD_REASON_CODES,
  RECORD_WARNING_CODES,
  REVIEW_REASON_CODES,
  SEAL_REASON_CODES,
  SEAL_WARNING_CODES,
  WORK_WARNING_CODES,
  READ_ERROR_CODES,
  NEW_ERROR_CODES,
  AMEND_ERROR_CODES,
  REVIEW_ERROR_CODES,
  CLOSE_ERROR_CODES,
  RECORDS_SINCE_ERROR_CODES,
  RECORDS_SINCE_REASON_CODES,
  INTENT_ERROR_CODES,
  INTENT_FINDING_CODES,
  INTENT_REASON_CODES,
  CHANGES_FINDING_CODES,
  CHANGES_ERROR_CODES,
  COMPOSITES_ERROR_CODES,
  COMPOSITES_REASON_CODES,
  COMPOSITES_RUNTIME_REASON_CODES,
  COMPOSITES_ENVIRONMENT_REASON_CODES,
  WORK_ERROR_CODES,
  WORK_LEASE_REFUSALS,
  WORK_EVIDENCE_ERROR_CODES,
  RECORD_FINDING_CODES,
  ANSWER_WARNING_CODES,
  POINTS_ERROR_CODES,
  POINTS_SOURCE_REASON_CODES,
  POINTS_WRITE_ERROR_CODES,
};

/** Every string in an `enum` under a property named `code`, anywhere in a schema. */
function schemaCodes(node: unknown, underCode = false, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) schemaCodes(n, underCode, out);
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "enum" && underCode) for (const e of v as unknown[]) out.add(String(e));
      schemaCodes(v, k === "code" || (underCode && k !== "properties"), out);
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== "__fixtures__") out.push(...sourceFiles(join(dir, d.name)));
    else if (d.isFile() && d.name.endsWith(".ts") && !d.name.endsWith(".test.ts")) out.push(join(dir, d.name));
  }
  return out;
}

/** Codes that are someone else's: zod's issue codes. */
const NOT_OURS = new Set(["custom"]);

describe("the closed list of reason codes", () => {
  test("has no duplicates, and every code says what it means", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    for (const c of REASON_CODES) {
      expect(c).toMatch(/^[a-z]+(-[a-z0-9]+)*$/);
      expect(REASONS[c].length).toBeGreaterThan(10);
    }
    expect(isReasonCode("dir-missing")).toBe(true);
    expect(isReasonCode("toString")).toBe(false);
  });

  test("each command's list is a subset, and together they are the whole list", () => {
    const union = new Set<string>();
    for (const [name, codes] of Object.entries(PER_COMMAND)) {
      for (const c of codes) {
        expect(isReasonCode(c), `${name} has ${c}, which is not in reason-codes.ts`).toBe(true);
        union.add(c);
      }
    }
    expect([...union].sort()).toEqual([...REASON_CODES].sort());
  });

  test("the output schemas name exactly these codes", () => {
    const named = new Set<string>();
    for (const f of readdirSync(HERE).filter((f) => f.endsWith(".schema.json") && !f.startsWith("declaration") && !f.startsWith("workspace-kinds"))) {
      for (const c of schemaCodes(JSON.parse(readFileSync(join(HERE, f), "utf-8")))) {
        expect(isReasonCode(c), `${f} names ${c}, which is not in reason-codes.ts`).toBe(true);
        named.add(c);
      }
    }
    expect([...named].sort()).toEqual([...REASON_CODES].sort());
  });

  test("no source file emits a code outside the list", () => {
    const emitted = /(?:\bcode:\s*|(?:WorkspaceReadError|RecordReadError|RecordWriteError|StatusError|IntentError)\(\s*)"([a-z0-9-]+)"/g;
    let seen = 0;
    for (const file of sourceFiles(HERE)) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(emitted)) {
        if (NOT_OURS.has(m[1])) continue;
        seen++;
        expect(isReasonCode(m[1]), `${file.slice(HERE.length + 1)} emits ${m[1]}, which is not in reason-codes.ts`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(30);
  });

  test("a plugin's finding codes are in its own namespace, outside the list, and the intent schema accepts them (#2656)", () => {
    expect(isPluginCode("plugin:chud:contract-criteria-changed")).toBe(true);
    expect(isPluginCode("plugin:chud:contract-criteria-changed", "chud")).toBe(true);
    expect(isPluginCode("plugin:chud:contract-criteria-changed", "units")).toBe(false);
    for (const bad of ["plugin:chud", "plugin::x", "plugin:chud:Upper", "plugin:chud:a:b", "intent-commit-bare", 7]) expect(isPluginCode(bad), String(bad)).toBe(false);
    expect(isReasonCode("plugin:chud:contract-criteria-changed")).toBe(false);
    const { validate } = contract(intentSchema);
    const finding = (code: string) => ({ id: `finding:${code}:1`, kind: "finding", code, message: "m", concerns: [] });
    const doc = (code: string) => ({
      $schema: intentSchema.$id,
      contract: 1,
      chant: "0.0.0",
      at: null,
      workspace: { name: "w", root: "." },
      region: "region:.",
      history: { rev: null, follows: "directory", shallow: false },
      kinds: [],
      nodes: [finding(code)],
      edges: [],
      reasons: [],
      summary: { commits: 0, decisions: 0, artifacts: 0, findings: 1 },
    });
    expect(validate(doc("plugin:chud:contract-criteria-changed"))).toBe(true);
    expect(validate(doc("intent-commit-bare"))).toBe(true);
    expect(validate(doc("plugin:chud:Nope"))).toBe(false);
    expect(validate(doc("made-up-code"))).toBe(false);
  });

  test("the read-contract page documents every code", () => {
    const page = readFileSync(join(REPO, "docs", "src", "content", "docs", "reference", "workspace-read-contract.mdx"), "utf-8");
    for (const c of REASON_CODES) expect(page, c).toContain(`| \`${c}\` |`);
  });
});
