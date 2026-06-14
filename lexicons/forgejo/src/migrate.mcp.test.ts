/**
 * Smoke test for the forgejo MCP `forgejo:compare` tool. Exercises the
 * handler directly (the tool contract is a plain async function from
 * inputSchema params to a result object).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { forgejoPlugin } from "./plugin";

const GHA_WORKFLOW = `name: CI
on:
  push:
    branches:
      - main
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: some-org/custom-action@v1
      - run: npm test
`;

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fj-compare-"));
  file = join(dir, "ci.yml");
  writeFileSync(file, GHA_WORKFLOW);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("forgejo MCP compare tool", () => {
  test("registered in mcpTools", () => {
    const tools = forgejoPlugin.mcpTools?.() ?? [];
    expect(tools.map((t) => t.name)).toContain("forgejo:compare");
  });

  test("reports per-property fates and summary counts", async () => {
    const tools = forgejoPlugin.mcpTools?.() ?? [];
    const compare = tools.find((t) => t.name === "forgejo:compare");
    expect(compare).toBeDefined();

    const result = (await compare!.handler({ file })) as {
      found: boolean;
      properties: Array<{ property: string; fate: string }>;
      summary: Record<string, number>;
    };

    expect(result.found).toBe(true);
    const fates = result.properties.map((p) => p.fate);
    expect(fates).toContain("lost"); // permissions
    expect(fates).toContain("needs-review"); // unmapped action ref
    expect(result.summary.lost).toBeGreaterThanOrEqual(1);
    expect(result.summary["needs-review"]).toBeGreaterThanOrEqual(1);
  });

  test("returns found:false for a non-workflow file", async () => {
    const tools = forgejoPlugin.mcpTools?.() ?? [];
    const compare = tools.find((t) => t.name === "forgejo:compare");
    const other = join(dir, "not-a-workflow.yml");
    writeFileSync(other, "foo: bar\n");
    const result = (await compare!.handler({ file: other })) as { found: boolean };
    expect(result.found).toBe(false);
  });
});
