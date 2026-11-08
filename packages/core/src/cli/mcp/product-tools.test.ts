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
import { PRODUCT_MCP_PROPOSE_FLOOR, productToolWriteWord, ProductToolRefusedError, type ProductMcpHook } from "./product-tools";
import { PROPOSE_INSTRUCTIONS } from "./server";
import { READ_ONLY_CORE_TOOLS } from "./read-only";
import * as ciProduct from "../../ci-product";
import { reportReader, reportToolKey, safeReportKey } from "./report-tools";
import type { ToolDefinition } from "./types";
import type { McpToolContribution } from "../../mcp/types";
import { NEXT_RELEASE } from "../../release-floors";

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

describe("the --propose tier (#4655)", () => {
  const forge = (name: string, handler: McpToolContribution["handler"] = async () => ({ opened: name })): McpToolContribution => ({ ...tool(name, undefined, handler), forgeWrite: true });
  const hook = (tools: McpToolContribution[], extra: Partial<ProductMcpHook> = {}): ProductMcpHook => ({ product: "terragucci", tools: () => tools, ...extra });

  test("serves the read tools, the readOnly product tools and the forgeWrite ones, and no op, signal, apply or approve tool", async () => {
    const server = new McpServer([], { readOnly: true, propose: true, product: hook([forge("request_from_template"), tool("templates", true), tool("drift_scan")]) });
    expect(server.readOnly).toBe(true);
    expect(server.propose).toBe(true);
    const names = await listed(server);
    expect(names.filter((n) => n.startsWith("terragucci:")).sort()).toEqual(["terragucci:request_from_template", "terragucci:templates"]);
    expect(names.filter((n) => !n.startsWith("terragucci:")).every((n) => READ_ONLY_CORE_TOOLS.has(n))).toBe(true);
    for (const name of ["op-run", "op-signal", "op-approve", "apply", "lifecycle-snapshot"]) expect(names, name).not.toContain(name);
    expect(JSON.parse((await call(server, "terragucci:request_from_template")).text)).toEqual({ opened: "request_from_template" });
    const res = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const instructions = (res.result as { instructions: string }).instructions;
    expect(instructions).toContain(PROPOSE_INSTRUCTIONS);
    expect(instructions).toMatch(/open pull requests and comments only/);
    expect(instructions).toMatch(/belong to a person/);
  });

  test("the read-only server without propose refuses to start, naming the forgeWrite tool", () => {
    const tools = [forge("request_from_template"), tool("templates", true)];
    expect(() => new McpServer([], { readOnly: true, product: hook(tools) })).toThrow(ProductToolRefusedError);
    expect(() => new McpServer([], { readOnly: true, product: hook(tools) })).toThrow(/terragucci:request_from_template|request_from_template/);
    expect(() => new McpServer([], { product: hook(tools) })).toThrow(/request_from_template.*--propose/);
  });

  test("a forgeWrite tool named with a strong word refuses the start, naming the word", () => {
    for (const [name, word] of [["approve_request", "approve"], ["merge_request", "merge"], ["request_override", "override"], ["apply_template", "apply"], ["create_request", "create"]] as const) {
      const start = () => new McpServer([], { readOnly: true, propose: true, product: hook([forge(name)]) });
      expect(start, name).toThrow(ProductToolRefusedError);
      expect(start, name).toThrow(new RegExp(`${name} would ${word}`));
    }
    expect(productToolWriteWord("propose_change", ["request", "propose"])).toBeUndefined();
    expect(productToolWriteWord("request_from_template", ["request", "propose"])).toBeUndefined();
  });

  test("propose on the hook turns the tier on, and an ordinary server refuses it", async () => {
    const tools = [forge("request_from_template"), tool("templates", true)];
    expect(await listed(new McpServer([], { product: hook(tools, { propose: true }) }))).toContain("terragucci:request_from_template");
    expect(() => new McpServer([], { product: hook(tools, { readOnly: false, propose: true }) })).toThrow(/--read-only --propose/);
    // The ordinary server serves a forgeWrite tool as any other.
    expect(await listed(new McpServer([], { product: hook(tools, { readOnly: false }) }))).toContain("terragucci:request_from_template");
  });

  test("the tier's floor is on @intentius/chant/ci-product for a product to feature-detect", () => {
    expect(PRODUCT_MCP_PROPOSE_FLOOR).toBe("0.124.58");
    expect(ciProduct.PRODUCT_MCP_PROPOSE_FLOOR).toBe(PRODUCT_MCP_PROPOSE_FLOOR);
    expect(ciProduct.PRODUCT_TOOL_PROPOSE_WORDS).toEqual(["request", "propose"]);
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

describe("tool annotations in tools/list (#4823)", () => {
  async function annotations(server: McpServer): Promise<Map<string, Record<string, unknown> | undefined>> {
    const res = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    return new Map((res.result as { tools: Array<ToolDefinition & { annotations?: Record<string, unknown> }> }).tools.map((t) => [t.name, t.annotations]));
  }
  const READ = { readOnlyHint: true, destructiveHint: false };

  test("a product's readOnly tool reads as read-only, a forgeWrite tool as an additive write, and its own annotations pass through", async () => {
    const hook: ProductMcpHook = {
      product: "terragucci",
      propose: true,
      tools: () => [
        { ...tool("index", true), annotations: { idempotentHint: true, openWorldHint: false } },
        { ...tool("request_from_template"), forgeWrite: true },
      ],
    };
    const listedAnnotations = await annotations(new McpServer([], { product: hook }));
    expect(listedAnnotations.get("terragucci:index")).toEqual({ ...READ, idempotentHint: true, openWorldHint: false });
    expect(listedAnnotations.get("terragucci:request_from_template")).toEqual({ readOnlyHint: false, destructiveHint: false });
  });

  test("the declaration wins over an annotation that says otherwise", async () => {
    const hook: ProductMcpHook = { product: "plywood", tools: () => [{ ...tool("stacks", true), annotations: { readOnlyHint: false, destructiveHint: true, title: "Stacks" } }] };
    expect((await annotations(new McpServer([], { product: hook }))).get("plywood:stacks")).toEqual({ ...READ, title: "Stacks" });
  });

  test("a plugin's readOnly tool is annotated, and a tool that declares nothing is not", async () => {
    const plugin = { name: "lex", mcpTools: () => [tool("catalog", true), tool("generate")] } as unknown as import("../../lexicon").LexiconPlugin;
    const listedAnnotations = await annotations(new McpServer([plugin]));
    expect(listedAnnotations.get("lex:catalog")).toEqual(READ);
    expect(listedAnnotations.get("lex:generate")).toBeUndefined();
  });

  test("a read-only core tool is annotated, a mutating one is not, and lint is read-only only without fix", async () => {
    const open = await annotations(new McpServer([]));
    expect(open.get("search")).toEqual(READ);
    expect(open.get("op-status")).toEqual(READ);
    expect(open.get("op-run")).toBeUndefined();
    expect(open.get("lint")).toBeUndefined();
    const closed = await annotations(new McpServer([], { readOnly: true }));
    expect(closed.get("lint")).toEqual(READ);
    for (const [name, a] of closed) expect(a, name).toEqual(READ);
  });

  test("the floor names the next release", () => {
    expect(ciProduct.MCP_TOOL_ANNOTATIONS_FLOOR).toBe(NEXT_RELEASE);
  });
});
