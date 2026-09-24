import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MEMBER_LEDGER_FLOOR } from "../../lifecycle/member-ledger";
import { parseDeclaration } from "../declaration";
import {
  checkDistinctStacks,
  checkFlatLedgerEnvironments,
  checkLedgers,
  gatherLedgerFacts,
  memberChantVersion,
  writesFlatLedger,
  type MemberLedgerFacts,
} from "./ledgers";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-ledger-check-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const fact = (name: string, over: Partial<MemberLedgerFacts> = {}): MemberLedgerFacts => ({
  name,
  dir: `services/${name}`,
  stack: name,
  environments: ["prod"],
  chantVersion: MEMBER_LEDGER_FLOOR,
  ...over,
});

describe("WSP071: distinct ownership stacks (#2538, ws-037)", () => {
  test("distinct stacks pass, and a member with no stack is not compared", () => {
    expect(checkDistinctStacks([fact("api"), fact("web"), fact("jobs", { stack: null }), fact("cron", { stack: null })])).toEqual([]);
  });

  test("a shared stack fails once, naming every member that uses it", () => {
    const findings = checkDistinctStacks([fact("api", { stack: "shop" }), fact("web", { stack: "shop" }), fact("jobs", { stack: "shop" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: "WSP071", severity: "error", members: ["api", "web", "jobs"] });
    expect(findings[0].message).toContain('"shop"');
  });
});

describe("WSP072: flat-layout writers never share an environment (#2538, ws-036)", () => {
  test("members at or above the floor write under _members/ and never clash", () => {
    expect(checkFlatLedgerEnvironments([fact("api"), fact("web")])).toEqual([]);
  });

  test("one member below the floor alone is fine", () => {
    expect(checkFlatLedgerEnvironments([fact("api", { chantVersion: "0.79.0" }), fact("web")])).toEqual([]);
  });

  test("two members below the floor that share an environment fail", () => {
    const findings = checkFlatLedgerEnvironments([
      fact("api", { chantVersion: "0.79.0", environments: ["prod", "staging"] }),
      fact("web", { chantVersion: "0.80.0", environments: ["prod"] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: "WSP072", members: ["api", "web"] });
    expect(findings[0].message).toContain('"prod"');
    expect(findings[0].message).toContain("chant 0.79.0");
  });

  test("two members below the floor with different environments pass", () => {
    expect(
      checkFlatLedgerEnvironments([
        fact("api", { chantVersion: "0.79.0", environments: ["api-prod"] }),
        fact("web", { chantVersion: "0.79.0", environments: ["web-prod"] }),
      ]),
    ).toEqual([]);
  });

  test("the root member writes flat too, so it clashes with an old member on the same environment", () => {
    expect(writesFlatLedger(fact("root", { dir: "." }))).toBe(true);
    const findings = checkFlatLedgerEnvironments([fact("root", { dir: "." }), fact("api", { chantVersion: "0.60.0" })]);
    expect(findings.map((f) => f.members)).toEqual([["root", "api"]]);
  });

  test("an unknown or unreadable chant version is not treated as old", () => {
    expect(writesFlatLedger(fact("api", { chantVersion: null }))).toBe(false);
    expect(writesFlatLedger(fact("api", { chantVersion: "latest" }))).toBe(false);
  });

  test("checkLedgers reports both kinds, stacks first", () => {
    const findings = checkLedgers([
      fact("api", { stack: "shop", chantVersion: "0.79.0" }),
      fact("web", { stack: "shop", chantVersion: "0.79.0" }),
    ]);
    expect(findings.map((f) => f.id)).toEqual(["WSP071", "WSP072"]);
  });
});

describe("facts from a checkout", () => {
  test("memberChantVersion finds the nearest installed chant walking up", () => {
    const root = tree({
      "node_modules/@intentius/chant/package.json": JSON.stringify({ name: "@intentius/chant", version: "0.79.3" }),
      "services/web/node_modules/@intentius/chant/package.json": JSON.stringify({ name: "@intentius/chant", version: "0.81.0" }),
      "services/api/chant.config.json": "{}",
    });
    expect(memberChantVersion(join(root, "services/api"))).toBe("0.79.3");
    expect(memberChantVersion(join(root, "services/web"))).toBe("0.81.0");
  });

  test("gatherLedgerFacts reads chant members' stacks and environments and skips the rest", async () => {
    const root = tree({
      "services/api/chant.config.json": JSON.stringify({ ownership: { stack: "shop", env: "prod" }, environments: ["staging"] }),
      "services/web/chant.config.json": JSON.stringify({ ownership: { stack: "shop" }, environments: ["prod"] }),
      "docs/package.json": "{}",
    });
    const declaration = parseDeclaration(
      JSON.stringify({
        name: "acme",
        schema: 1,
        members: [
          { name: "api", dir: "services/api", kind: "chant" },
          { name: "web", dir: "services/web", kind: "chant" },
          { name: "docs", dir: "docs", kind: "other", because: "a docs site" },
        ],
      }),
      "chant.workspace.json",
    );
    const facts = await gatherLedgerFacts(root, declaration);
    expect(facts.map((f) => [f.name, f.stack, f.environments])).toEqual([
      ["api", "shop", ["staging", "prod"]],
      ["web", "shop", ["prod"]],
    ]);
    expect(checkLedgers(facts).map((f) => f.id)).toEqual(["WSP071"]);
  });
});
