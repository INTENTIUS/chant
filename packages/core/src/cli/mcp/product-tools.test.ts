/**
 * chant#4555: a CI product's tools on `chant serve mcp` through the product
 * tool hook, read-only by default, and the `report` tool's read of the
 * report store.
 */

import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { McpServer } from "./server";
import { productToolWriteWord, ProductToolRefusedError, type ProductMcpHook } from "./product-tools";
import { reportReader, reportToolKey, safeReportKey } from "./report-tools";
import type { ToolDefinition } from "./types";
import type { McpToolContribution } from "../../mcp/types";

const tool = (name: string, readOnly?: boolean, handler: McpToolContribution["handler"] = async () => ({ name })): McpToolContribution => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  handler,
  ...(readOnly !== undefined ? { readOnly } : {}),
});

async function listed(server: McpServer): Promise<string[]> {
  const res = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  return (res.result as { tools: ToolDefinition[] }).tools.map((t) => t.name);
}

async function call(server: McpServer, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError?: boolean }> {
  const res = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const r = res.result as { content: Array<{ text: string }>; isError?: boolean };
  return { text: r.content[0]!.text, ...(r.isError ? { isError: true } : {}) };
}

describe("the product tool hook (#4555)", () => {
  test("a server started through the hook is read-only, and serves only the product tools that say they read", async () => {
    const hook: ProductMcpHook = { product: "terragucci", tools: () => [tool("waiting", true), tool("estate", true), tool("drift_scan")] };
    const server = new McpServer([], { product: hook });
    expect(server.readOnly).toBe(true);
    const names = await listed(server);
    expect(names).toContain("terragucci:waiting");
    expect(names).toContain("terragucci:estate");
    expect(names).not.toContain("terragucci:drift_scan");
    // chant's mutating core tools stay out too.
    expect(names).not.toContain("op-run");
    expect(names).not.toContain("op-approve");
    expect(names).toContain("report");
    expect(JSON.parse((await call(server, "terragucci:waiting")).text)).toEqual({ name: "waiting" });
  });

  test("a read-only server will not start with a product tool named as a write (assertReadOnly)", () => {
    for (const name of ["apply_wave", "wave_approve", "unlock", "push_branch", "terragucci:merge_pr"]) {
      expect(() => new McpServer([], { product: { product: "terragucci", tools: () => [tool(name, true)] } }), name).toThrow(ProductToolRefusedError);
    }
    expect(productToolWriteWord("last_apply")).toBeUndefined();
    expect(productToolWriteWord("audit")).toBeUndefined();
    expect(productToolWriteWord("apply_wave")).toBe("apply");
    expect(productToolWriteWord("wave_approve")).toBe("approve");
  });

  test("readOnly: false on the hook starts an ordinary server with every product tool; --read-only wins over it", async () => {
    const tools = () => [tool("propose"), tool("waiting", true)];
    const open = new McpServer([], { product: { product: "plywood", tools, readOnly: false } });
    expect(open.readOnly).toBe(false);
    expect(await listed(open)).toEqual(expect.arrayContaining(["plywood:propose", "plywood:waiting", "op-run"]));
    const closed = new McpServer([], { readOnly: true, product: { product: "plywood", tools, readOnly: false } });
    expect(await listed(closed)).not.toContain("plywood:propose");
  });

  test("a product name that is not a word is refused, and the hook's instructions reach initialize", async () => {
    expect(() => new McpServer([], { product: { product: "Ply Wood", tools: () => [] } })).toThrow(/not a product name/);
    const server = new McpServer([], { product: { product: "plywood", tools: () => [], instructions: "plywood reads stacks." } });
    const res = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect((res.result as { instructions: string }).instructions).toMatch(/^plywood reads stacks\.\n\n.*read-only/s);
  });

  test("a product tool reads the report store through its context, and cannot write it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "product-tools-"));
    mkdirSync(join(dir, "7", "c".repeat(40)), { recursive: true });
    writeFileSync(join(dir, "7", "c".repeat(40), "pr-plan.json"), JSON.stringify({ status: "planned" }));
    let read: string | null | undefined;
    const hook: ProductMcpHook = {
      product: "plywood",
      reportUrl: pathToFileURL(dir).href,
      tools: (ctx) => [
        tool("plan_report", true, async () => {
          const reports = await ctx.reports();
          read = await reports!.read(`7/${"c".repeat(40)}/pr-plan.json`);
          return { read };
        }),
      ],
    };
    const server = new McpServer([], { product: hook });
    await call(server, "plywood:plan_report");
    expect(read).toBe(JSON.stringify({ status: "planned" }));
    expect("put" in reportReader(pathToFileURL(dir).href)).toBe(false);

    // The core `report` tool reads the same store by pull request, commit and file.
    const got = await call(server, "report", { pr: "7", commit: "c".repeat(40), file: "pr-plan.json" });
    expect(JSON.parse(got.text)).toMatchObject({ key: `7/${"c".repeat(40)}/pr-plan.json`, document: { status: "planned" } });
    expect((await call(server, "report", { pr: "7", commit: "c".repeat(40), file: "pr-apply.json" })).isError).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the report tool's keys (#4555)", () => {
  test("take a pull request, a commit, an optional member and one of the stage files", () => {
    expect(reportToolKey({ pr: "12", commit: "a".repeat(40), file: "change-set.json" })).toBe(`12/${"a".repeat(40)}/change-set.json`);
    expect(reportToolKey({ pr: 12, commit: "a".repeat(40), member: "web", file: "pr-apply.events.jsonl" })).toBe(`12/${"a".repeat(40)}/web/pr-apply.events.jsonl`);
    expect(reportToolKey({ pr: "unknown", commit: "a".repeat(40), file: "pr-apply.json" })).toBe(`unknown/${"a".repeat(40)}/pr-apply.json`);
  });

  test("refuse anything that would leave the report URL, and any argument they do not list", () => {
    expect(() => reportToolKey({ pr: "../x", commit: "a".repeat(40), file: "pr-plan.json" })).toThrow(/pull request number/);
    expect(() => reportToolKey({ pr: "1", commit: "a".repeat(40), member: "..", file: "pr-plan.json" })).toThrow(/member/);
    expect(() => reportToolKey({ pr: "1", commit: "a".repeat(40), file: "../../secret" })).toThrow(/file must be one of/);
    expect(() => reportToolKey({ pr: "1", commit: "a".repeat(40), file: "pr-plan.json", token: "x" })).toThrow(/takes no argument token/);
    expect(() => safeReportKey("a/../b")).toThrow(/not a path below/);
    expect(safeReportKey("/a/b/")).toBe("a/b");
  });
});
