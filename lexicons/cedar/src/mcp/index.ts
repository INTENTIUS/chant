/**
 * The cedar lexicon's MCP contributions.
 *
 * Two of the three are the conventional pair every lexicon ships, built from
 * core's shared helpers: `cedar:diff` and `chant://cedar/resource-catalog`.
 * The third is the one only this lexicon can answer — see
 * ./policy-coverage.ts.
 *
 * Names are written as bare verbs and single-segment URIs. Core namespaces both
 * (`cedar:<verb>`, `chant://cedar/<path>`), and applying the prefix is
 * idempotent, so the helpers' pre-namespaced output and the bare `coverage`
 * below both register as exactly one well-formed identifier (chant #1341).
 */

import { createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { cedarSerializer } from "../serializer";
import { computePolicyCoverage, formatPolicyCoverage } from "./policy-coverage";

/**
 * `cedar:coverage` — which schema declarations the built policy set reaches.
 *
 * Builds the project the same way `chant build` does rather than reading a
 * committed `.cedar` file, so the answer is about the policies in source, not
 * about whatever was last written to disk.
 */
export const cedarCoverageTool: McpToolContribution = {
  name: "coverage",
  description:
    "Report which Cedar schema entity types and actions the project's policy set can apply to, " +
    "which are reachable only from a forbid, and which no policy covers at all.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Path to the infrastructure project directory (defaults to the current directory)",
      },
      format: {
        type: "string",
        enum: ["json", "text"],
        description: "Return the full report as JSON (default) or a human-readable summary",
      },
    },
  },
  async handler(params: Record<string, unknown>): Promise<unknown> {
    const { join } = await import("path");
    const { existsSync } = await import("fs");
    const { build } = await import("@intentius/chant/build");
    const { loadCedarConfig } = await import("../config");

    const projectRoot = (params.path as string) ?? ".";
    const srcDir = existsSync(join(projectRoot, "src")) ? join(projectRoot, "src") : projectRoot;

    const result = await build(srcDir, [cedarSerializer]);
    if (result.errors.length > 0) {
      return { error: "build failed", details: result.errors.map((e) => String(e)) };
    }

    const output = result.outputs.get("cedar");
    const policySetText = typeof output === "string" ? output : (output?.primary ?? "");

    const report = computePolicyCoverage({
      policySetText,
      projectRoot,
      config: await loadCedarConfig(projectRoot),
    });

    return params.format === "text" ? formatPolicyCoverage(report) : report;
  },
};

/** Every MCP tool this lexicon contributes. */
export function cedarMcpTools(): McpToolContribution[] {
  return [
    createDiffTool(
      cedarSerializer,
      "Compare the current Cedar policy set against the previous build's output",
      "cedar",
    ),
    cedarCoverageTool,
  ];
}

/**
 * Every MCP resource this lexicon contributes.
 *
 * `createCatalogResource` locates the registry relative to the module URL it is
 * given, resolving `<dir>/generated/lexicon-cedar.json`. That has to be
 * `src/`, not `src/mcp/`, so the caller in plugin.ts passes its own
 * `import.meta.url` rather than this file deriving one by walking up.
 */
export function cedarMcpResources(pluginUrl: string): McpResourceContribution[] {
  return [
    createCatalogResource(
      pluginUrl,
      "Cedar Resource Catalog",
      "Every declaration generated from the project's Cedar schema — entity types, actions, and the Policy class",
      "lexicon-cedar.json",
      "cedar",
    ),
  ];
}
