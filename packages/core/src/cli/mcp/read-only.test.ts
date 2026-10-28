/**
 * chant#4543 — `chant serve mcp --read-only` registers no tool that runs an
 * Op, resolves a gate, writes a file or a record, or captures a snapshot.
 *
 * The guard: every tool a read-only server lists is a read-only core tool or
 * a plugin tool that declared `readOnly: true`, and none is a mutating one.
 * A plugin tool without the flag is not registered, and a core tool on
 * neither list of ./read-only.ts is refused rather than served.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { LexiconPlugin } from "../../lexicon";
import type { Serializer } from "../../serializer";
import { McpServer, READ_ONLY_INSTRUCTIONS } from "./server";
import { MUTATING_CORE_TOOLS, READ_ONLY_CORE_TOOLS, ReadOnlyRegistrationError, servesContributedTool } from "./read-only";
import { ledgerArgv } from "./ledger-tools";
import { workspaceReadTools, workspaceWriteTools } from "./workspace-tools";
import { generateMcpConfig } from "../mcp-config";

/** This repository declares a workspace, so a server started here serves the workspace tools too. */
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function plugin(): LexiconPlugin {
  const tool = (name: string, readOnly?: boolean) => ({
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    handler: async () => ({ ok: true }),
    ...(readOnly === undefined ? {} : { readOnly }),
  });
  return {
    name: "fake",
    serializer: { name: "fake", serialize: () => "" } as unknown as Serializer,
    generate: async () => {},
    validate: async () => {},
    coverage: async () => {},
    package: async () => {},
    mcpTools: () => [tool("reader", true), tool("writer"), tool("explicit-writer", false)],
  };
}

async function listed(server: McpServer): Promise<string[]> {
  const res = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  return (res.result as { tools: { name: string }[] }).tools.map((t) => t.name);
}

async function call(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const res = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  return res.result as { isError?: boolean; content: { text: string }[] };
}

describe("chant serve mcp --read-only (chant#4543)", () => {
  test("no mutating tool is registered in read-only mode, inside a workspace and with plugin tools", async () => {
    const server = new McpServer([plugin()], { workspace: { cwd: repoRoot }, readOnly: true });
    const names = await listed(server);
    expect(names.length).toBeGreaterThan(0);

    const mutating = names.filter((n) => MUTATING_CORE_TOOLS.has(n));
    expect(mutating, `a read-only server registered mutating tools: ${mutating.join(", ")}`).toEqual([]);

    // Everything served is a read-only core tool or the one plugin tool that declared readOnly.
    const unexpected = names.filter((n) => !READ_ONLY_CORE_TOOLS.has(n) && n !== "fake:reader");
    expect(unexpected, `a read-only server registered tools that are not on the read side: ${unexpected.join(", ")}`).toEqual([]);

    for (const name of ["op-run", "op-approve", "import", "scaffold", "lifecycle-snapshot", ...workspaceWriteTools.map((t) => t.name)]) {
      expect(names).not.toContain(name);
    }
  });

  test("a plugin tool is served read-only only when it declares readOnly: true", async () => {
    const names = await listed(new McpServer([plugin()], { readOnly: true }));
    expect(names).toContain("fake:reader");
    expect(names).not.toContain("fake:writer");
    expect(names).not.toContain("fake:explicit-writer");

    // The ordinary server serves all three, as before.
    const all = await listed(new McpServer([plugin()]));
    expect(all).toEqual(expect.arrayContaining(["fake:reader", "fake:writer", "fake:explicit-writer"]));

    expect(servesContributedTool({}, true)).toBe(false);
    expect(servesContributedTool({ readOnly: true }, true)).toBe(true);
    expect(servesContributedTool({}, false)).toBe(true);
  });

  test("it serves the ledger, query and workspace reads", async () => {
    const names = await listed(new McpServer([], { workspace: { cwd: repoRoot }, readOnly: true }));
    expect(names).toEqual(expect.arrayContaining(["ledger", "query", "op-list", "op-status", "op-report", ...workspaceReadTools.map((t) => t.name)]));
  });

  test("the two lists do not overlap, and every tool the ordinary server registers is on one of them", async () => {
    for (const name of READ_ONLY_CORE_TOOLS) expect(MUTATING_CORE_TOOLS.has(name), name).toBe(false);
    const all = await listed(new McpServer([], { workspace: { cwd: repoRoot } }));
    const unsorted = all.filter((n) => !READ_ONLY_CORE_TOOLS.has(n) && !MUTATING_CORE_TOOLS.has(n));
    expect(unsorted, `core tools on neither list of read-only.ts: ${unsorted.join(", ")}`).toEqual([]);
  });

  test("lint has no fix on a read-only server, and refuses one", async () => {
    const server = new McpServer([], { readOnly: true });
    const res = await server.handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const lint = (res.result as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools.find((t) => t.name === "lint");
    expect(lint).toBeDefined();
    expect(Object.keys(lint!.inputSchema.properties)).not.toContain("fix");
    const refused = await call(server, "lint", { path: ".", fix: true });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("read-only");
  });

  test("a read-only server says so in initialize's instructions", async () => {
    const res = await new McpServer([], { readOnly: true }).handleRequest({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} });
    expect((res.result as { instructions?: string }).instructions).toContain(READ_ONLY_INSTRUCTIONS);
    const plain = await new McpServer([]).handleRequest({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} });
    expect((plain.result as { instructions?: string }).instructions).toBeUndefined();
  });

  test("the refusal names the file a new core tool is sorted in", () => {
    expect(new ReadOnlyRegistrationError("new-tool").message).toContain("read-only.ts");
  });

  test("ledger and query run the CLI's reads", () => {
    expect(ledgerArgv("ledger", { table: "gates", member: ["app"], where: ["state=pending"], since: "2026-10-01" })).toEqual([
      "ledger", "gates", "--member", "app", "--where", "state=pending", "--since", "2026-10-01", "--json",
    ]);
    expect(() => ledgerArgv("ledger", { table: "secrets" })).toThrow(/table must be one of/);
    expect(() => ledgerArgv("ledger", { table: "runs", at: "--force" })).toThrow(/may not start with -/);
    expect(ledgerArgv("query", { sql: "select * from runs" })).toEqual(["query", "--json", "--", "select * from runs"]);
  });

  test("chant init --mcp-read-only registers the read-only server", () => {
    const config = JSON.parse(generateMcpConfig("npm", { readOnly: true }));
    expect(config.mcpServers.chant.args).toEqual(["chant", "serve", "mcp", "--read-only"]);
    expect(JSON.parse(generateMcpConfig("npm")).mcpServers.chant.args).toEqual(["chant", "serve", "mcp"]);
  });
});
