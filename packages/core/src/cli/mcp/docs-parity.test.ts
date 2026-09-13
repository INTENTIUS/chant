import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "./server";
import type { ToolDefinition, ResourceDefinition } from "./types";

/**
 * The MCP docs say what this server offers; this test says they are right.
 *
 * `docs/src/content/docs/cli/mcp.mdx` is a hand-written list of tools,
 * resources, methods and protocol revisions, and the server is the thing that
 * actually registers them. Nothing connected the two, so the page fell two
 * revisions behind twice over (#2385): it advertised six tools while the
 * constructor registered thirteen, left `lifecycle-snapshot` and
 * `lifecycle-diff` undocumented anywhere, omitted `server/discover` (#1194)
 * and `chant://knowledge` (#1867), and claimed protocol version 2024-11-05
 * long after #1194 made 2026-07-28 the preferred one.
 *
 * Each claim here is read back against the running server rather than against
 * source text: the tool and resource lists come from a real `McpServer`
 * answering `tools/list` and `resources/list`, which is what a client sees.
 * The dispatch methods are the exception and are read out of `server.ts` by
 * regex, because a switch statement has no listing API; that regex fails
 * loudly if the switch is ever restructured.
 *
 * Same shape as `scripts/fold-depth-bound-claims.test.ts` (#2367) and
 * `scripts/lexicon-count-claims.test.ts` (#2316): a doc claim pinned to
 * ground truth, with a message that says what to edit.
 */

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const MCP_DOC = join("docs", "src", "content", "docs", "cli", "mcp.mdx");
const GUIDE_DOC = join("docs", "src", "content", "docs", "guide", "agent-integration.mdx");
const SERVER_SRC = join("packages", "core", "src", "cli", "mcp", "server.ts");

const mcpDoc = readFileSync(join(repoRoot, MCP_DOC), "utf8");
const guideDoc = readFileSync(join(repoRoot, GUIDE_DOC), "utf8");
const serverSrc = readFileSync(join(repoRoot, SERVER_SRC), "utf8");

/** What a client is told when it asks, built from a server with no plugins loaded. */
async function servedListing(method: "tools/list" | "resources/list"): Promise<string[]> {
  const response = await new McpServer().handleRequest({ jsonrpc: "2.0", id: 1, method });
  const result = response.result as { tools?: ToolDefinition[]; resources?: ResourceDefinition[] };
  const names = result.tools?.map((t) => t.name) ?? result.resources?.map((r) => r.uri);
  if (!names || names.length === 0) {
    throw new Error(`mcp docs parity: ${method} returned nothing to compare the docs against`);
  }
  return names;
}

/** The lines of one `##`/`###` section, up to the next heading at any level. */
function section(doc: string, heading: string, label: string): string {
  const start = doc.indexOf(heading);
  if (start < 0) throw new Error(`mcp docs parity: no "${heading}" heading in ${label} — was it renamed? Update this test to match.`);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/\n#{1,4} /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Every `` | `thing` | `` first column of a markdown table in `text`. */
function firstColumnCells(text: string): string[] {
  return [...text.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("the MCP docs describe the server that ships (#2385)", () => {
  test("cli/mcp.mdx documents exactly the tools the server registers", async () => {
    const registered = await servedListing("tools/list");
    // Every core tool gets its own `### \`name\`` heading. The `#### ` heading
    // under op-approve and the un-backticked "### Plugin Tools" are not tools.
    const documented = [...mcpDoc.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]);
    expect(documented.length, `${MCP_DOC}: found no "### \`tool-name\`" headings — was the Tools section reformatted?`).toBeGreaterThan(0);
    expect(
      sorted(documented),
      `${MCP_DOC} and the McpServer constructor disagree about the core tools. ` +
        `Registered: ${sorted(registered).join(", ")}. Documented: ${sorted(documented).join(", ")}. ` +
        `Give every registered tool a "### \`name\`" section on that page, and delete the sections for tools that no longer exist.`,
    ).toEqual(sorted(registered));
  });

  test("guide/agent-integration.mdx lists exactly the tools the server registers", async () => {
    const registered = await servedListing("tools/list");
    const listed = firstColumnCells(section(guideDoc, "### Available Tools", GUIDE_DOC));
    expect(
      sorted(listed),
      `${GUIDE_DOC}'s "Available Tools" table and the McpServer constructor disagree. ` +
        `Registered: ${sorted(registered).join(", ")}. Listed: ${sorted(listed).join(", ")}. ` +
        `Add or remove rows so the table matches; the parameter detail lives on the cli/mcp reference page.`,
    ).toEqual(sorted(registered));
  });

  test("cli/mcp.mdx documents exactly the resources the server serves", async () => {
    const served = await servedListing("resources/list");
    // Rows of the Resources table: `| `chant://...` | `mime` | description |`.
    const documented = [...mcpDoc.matchAll(/^\| `(chant:\/\/[^`]+)` \| `[^`]+` \|/gm)].map((m) => m[1]);
    expect(
      sorted(documented),
      `${MCP_DOC}'s Resources table and the server's resources/list disagree. ` +
        `Served: ${sorted(served).join(", ")}. Documented: ${sorted(documented).join(", ")}. ` +
        `A URI the server reads but never lists (chant://examples/{name}) belongs in prose under the table, not in it.`,
    ).toEqual(sorted(served));
  });

  test("cli/mcp.mdx states the protocol revisions the server negotiates, preferred first", () => {
    const documented = [...mcpDoc.matchAll(/^\| `(\d{4}-\d{2}-\d{2})` \|/gm)].map((m) => m[1]);
    expect(
      documented,
      `${MCP_DOC} claims protocol revisions ${documented.join(", ") || "(none found)"}, but server.ts ` +
        `negotiates ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}. The first row is the preferred revision, ` +
        `the one a client that names no version gets back.`,
    ).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
  });

  test("cli/mcp.mdx lists exactly the JSON-RPC methods dispatch answers", () => {
    const dispatched = [...serverSrc.matchAll(/^      case "([^"]+)":$/gm)].map((m) => m[1]);
    if (dispatched.length === 0) {
      throw new Error(
        `mcp docs parity: no \`case "method":\` labels found in ${SERVER_SRC} — the dispatch switch was ` +
          `restructured, so this test can no longer read the method list out of it. Update the test to match.`,
      );
    }
    const documented = firstColumnCells(section(mcpDoc, "### Supported Methods", MCP_DOC));
    expect(
      sorted(documented),
      `${MCP_DOC}'s "Supported Methods" table and the dispatch switch in ${SERVER_SRC} disagree. ` +
        `Dispatched: ${sorted(dispatched).join(", ")}. Documented: ${sorted(documented).join(", ")}.`,
    ).toEqual(sorted(dispatched));
  });
});
