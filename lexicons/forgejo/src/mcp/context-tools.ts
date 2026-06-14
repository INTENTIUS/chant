/**
 * Read-only MCP tools for the forgejo lexicon.
 *
 * `forgejo:compare` is the lead value of the lexicon: given a GitHub Actions
 * workflow, it reports which properties survive a move to Forgejo and which
 * weaken or drop (the migration safety view). It builds/analyzes only — it
 * never touches a live forge or writes anything.
 */

import type { McpToolContribution } from "@intentius/chant/mcp/types";
import { resolve } from "path";
import { readFile } from "fs/promises";
import { transform, detectGitHubWorkflow } from "../migrate/from-github";

const compareTool: McpToolContribution = {
  name: "forgejo:compare",
  description:
    "Given a GitHub Actions workflow file, migrate it to Forgejo and report which properties survive the move and which weaken or are lost (the migration safety view). Returns a per-property fate (translated/approximated/needs-review/lost) plus summary counts. Read-only — analyzes, never writes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file: { type: "string", description: "Path to a .github/workflows/*.yml workflow file to migrate and compare" },
    },
    required: ["file"],
  },
  async handler(params: Record<string, unknown>): Promise<unknown> {
    const file = resolve((params.file as string) ?? "");
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      return { file: params.file ?? null, found: false, note: "could not read the workflow file" };
    }
    if (!detectGitHubWorkflow(content)) {
      return { file: params.file ?? null, found: false, note: "file does not look like a GitHub Actions workflow" };
    }

    const migration = await transform(content, { security: true, sourceFile: file });
    const properties = migration.provenance.map((r) => ({
      property: r.security.property,
      fate: r.security.fate,
      severity: r.security.severity,
      sourceKey: r.sourceKey,
      reestablish: r.security.reestablish ?? null,
      note: r.note ?? null,
    }));
    const summary: Record<string, number> = { translated: 0, approximated: 0, "needs-review": 0, lost: 0 };
    for (const p of properties) summary[p.fate] = (summary[p.fate] ?? 0) + 1;
    return { found: true, properties, summary };
  },
};

export function forgejoContextTools(): McpToolContribution[] {
  return [compareTool];
}
