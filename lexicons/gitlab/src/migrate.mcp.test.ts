/**
 * Smoke test for the gitlab MCP `migrate` tool. Exercises the tool's
 * handler directly (no JSON-RPC harness needed — the tool contract is
 * a plain async function from inputSchema params to a result object).
 */

import { describe, test, expect } from "vitest";
import { gitlabPlugin } from "./plugin";

describe("gitlab MCP migrate tool", () => {
  test("registered alongside the diff tool", () => {
    const tools = gitlabPlugin.mcpTools?.() ?? [];
    const names = tools.map((t) => t.name);
    // The MCP server applies ${plugin.name}: namespacing at registration
    // time. Diff is pre-prefixed by createDiffTool; migrate is plain.
    expect(names).toContain("gitlab:diff");
    expect(names).toContain("migrate");
  });

  test("handler translates a trivial workflow", async () => {
    const tools = gitlabPlugin.mcpTools?.() ?? [];
    const migrate = tools.find((t) => t.name === "migrate");
    expect(migrate).toBeDefined();
    const result = await migrate!.handler({
      content: `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`,
    }) as { output: string; diagnostics: unknown[]; provenance: unknown[]; stages: string[] };

    expect(result.output).toContain("stages:");
    expect(result.output).toContain("build:");
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(Array.isArray(result.provenance)).toBe(true);
    expect(result.stages).toContain("build");
  });

  test("respects useComposites toggle", async () => {
    const tools = gitlabPlugin.mcpTools?.() ?? [];
    const migrate = tools.find((t) => t.name === "migrate")!;
    const nodePipelineWorkflow = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build
  test:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm test
`;
    const without = await migrate.handler({ content: nodePipelineWorkflow, emit: "ts" }) as { output: string };
    const withC = await migrate.handler({ content: nodePipelineWorkflow, emit: "ts", useComposites: true }) as { output: string };
    expect(without.output).not.toContain("NodePipeline(");
    expect(withC.output).toContain("NodePipeline(");
  });
});
