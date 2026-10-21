/**
 * The security groups (#4168): which groups a member runs under, and the
 * reference pages printed from the registries.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { WORKSPACE_CHECKS } from "./checks";
import { memberAtCwd, securityFeatureTable, securityGroupsAt, securityGroupsOf } from "./security";

const DOCS = fileURLToPath(new URL("../../../../docs/src/content/docs/", import.meta.url));

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("securityGroupsOf", () => {
  const declaration = {
    security: ["verified-releases" as const],
    members: [
      { name: "api", dir: "api", security: ["supply-chain" as const] },
      { name: "web", dir: "web", security: [] },
    ],
  };

  test("a member runs under the top-level groups and its own", () => {
    expect([...securityGroupsOf(declaration as never, "api")]).toEqual(["verified-releases", "supply-chain"]);
    expect([...securityGroupsOf(declaration as never, "web")]).toEqual(["verified-releases"]);
    expect([...securityGroupsOf(declaration as never)]).toEqual(["verified-releases"]);
  });

  test("no declaration or no security key turns nothing on", () => {
    expect(securityGroupsOf(null).size).toBe(0);
    expect(securityGroupsOf({ security: [], members: [] } as never, "api").size).toBe(0);
  });

  test("securityGroupsAt reads the member holding the directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-security-groups-")));
    scratch.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "api", "src"), { recursive: true });
    writeFileSync(
      join(root, "chant.workspace.json"),
      JSON.stringify({ name: "acme", schema: 1, security: ["review-rules"], members: [{ name: "api", dir: "api", kind: "other", because: "x", security: ["who-ran-it"] }] }),
    );
    expect(memberAtCwd({ declaration: { members: [{ name: "api", dir: "api" }] } as never, rootOnDisk: root }, join(root, "api", "src"))).toBe("api");
    expect([...securityGroupsAt(join(root, "api", "src"))]).toEqual(["review-rules", "who-ran-it"]);
    expect([...securityGroupsAt(root)]).toEqual(["review-rules"]);
  });
});

describe("reference pages", () => {
  test("the security features page carries the table SECURITY_FEATURES prints", () => {
    const page = readFileSync(join(DOCS, "reference", "security-features.mdx"), "utf-8");
    const table = /^\| Feature \| Default \|[^\n]*\n(?:\|[^\n]*\n)*/m.exec(page)?.[0].trimEnd();
    expect(table, "regenerate the table under Features from securityFeatureTable()").toBe(securityFeatureTable());
  });

  test("the workspace check page lists every check with its name, default severity and whether it can be set", () => {
    const page = readFileSync(join(DOCS, "cli", "workspace-check.mdx"), "utf-8");
    for (const c of WORKSPACE_CHECKS) {
      expect(page, c.id).toContain(`| \`${c.id}\` | ${c.name} | ${c.severity} | ${c.configurable ? "yes" : "no"} |`);
    }
  });
});
