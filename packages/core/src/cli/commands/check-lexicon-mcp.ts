/**
 * Audit of the names a lexicon's MCP contributions are registered under (#1341).
 *
 * Core namespaces every contribution — `<lexicon>:<verb>` for a tool,
 * `chant://<lexicon>/<path>` for a resource — but core is not the only place
 * that applies a prefix. `createDiffTool`/`createCatalogResource`
 * (../../lexicon-plugin-helpers.ts) emit `<lexicon>:diff` and
 * `<lexicon>:resource-catalog`, eleven lexicons write the prefix into the name
 * by hand, and `lexicon-authoring/lsp-mcp.mdx` taught a third form for URIs.
 * Applying the namespace unconditionally shipped `gitlab:gitlab:diff`,
 * `aws:aws:diff`, and `chant://azure/chant://lexicon/azure/catalog` in every
 * `chant serve mcp` session, while every doc named the single-prefixed form.
 *
 * The rule this checks is the one an agent experiences, not the one a lexicon
 * author typed: whatever the declaration style, the registered name must be a
 * single well-formed namespaced identifier. That keeps the check indifferent to
 * which of the three authored forms a lexicon uses, and still fails the moment a
 * name doubles or carries an embedded scheme.
 */

import { readFileSync } from "fs";
import { basename, join } from "path";
import { namespacedToolName, namespacedResourceUri } from "../mcp/server";

export interface McpNameAudit {
  /** How many tools + resources were examined. */
  checked: number;
  /** One human-readable line per malformed registered name. */
  violations: string[];
  /** False when the lexicon could not be loaded — the audit is then vacuous. */
  loaded: boolean;
}

/** `@intentius/chant-lexicon-aws` → `aws`; falls back to the directory name. */
export function lexiconNameFor(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { name?: string };
    const match = /chant-lexicon-([a-z0-9-]+)$/.exec(pkg.name ?? "");
    if (match) return match[1];
  } catch {
    // fall through to the directory name
  }
  return basename(dir);
}

const toolPattern = (lexicon: string): RegExp =>
  new RegExp(`^${lexicon}:[a-z0-9][a-z0-9-]*$`);

const resourcePattern = (lexicon: string): RegExp =>
  new RegExp(`^chant://${lexicon}/[A-Za-z0-9][A-Za-z0-9._/-]*$`);

/**
 * The malformed registered names among a lexicon's contributions. Pure, so the
 * rule can be tested without loading a lexicon package.
 */
export function mcpNameViolations(
  lexicon: string,
  tools: Array<{ name: string }>,
  resources: Array<{ uri: string }>,
): string[] {
  const violations: string[] = [];
  for (const tool of tools) {
    const registered = namespacedToolName(lexicon, tool.name);
    if (!toolPattern(lexicon).test(registered)) {
      violations.push(`tool ${JSON.stringify(tool.name)} registers as ${JSON.stringify(registered)}`);
    }
  }
  for (const resource of resources) {
    const registered = namespacedResourceUri(lexicon, resource.uri);
    if (!resourcePattern(lexicon).test(registered)) {
      violations.push(`resource ${JSON.stringify(resource.uri)} registers as ${JSON.stringify(registered)}`);
    }
  }
  return violations;
}

/**
 * Register this lexicon's MCP contributions the way the server does and check
 * the resulting names.
 */
export async function auditMcpNames(dir: string): Promise<McpNameAudit> {
  const lexicon = lexiconNameFor(dir);
  let plugin: {
    mcpTools?(): Array<{ name: string }>;
    mcpResources?(): Array<{ uri: string }>;
  };
  try {
    const { loadPlugins } = await import("../plugins");
    const plugins = await loadPlugins([lexicon]);
    if (plugins.length === 0) return { checked: 0, violations: [], loaded: false };
    plugin = plugins[0];
  } catch {
    return { checked: 0, violations: [], loaded: false };
  }

  const tools = plugin.mcpTools?.() ?? [];
  const resources = plugin.mcpResources?.() ?? [];
  return {
    checked: tools.length + resources.length,
    violations: mcpNameViolations(lexicon, tools, resources),
    loaded: true,
  };
}
