/**
 * Shared helpers for lexicon plugin implementations.
 *
 * Eliminates boilerplate across the 8 lexicon plugins by providing
 * factory functions for common plugin methods: skills loading,
 * MCP diff tool, and MCP catalog resource.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { SkillDefinition } from "./lexicon";
import type { McpToolContribution, McpResourceContribution } from "./mcp/types";
import type { Serializer } from "./serializer";

// ── Skills Loader ─────────────────────────────────────────────────

/**
 * Metadata for a skill file on disk. Spread into the resulting SkillDefinition
 * after the file content is read.
 */
export type SkillFileSpec = Omit<SkillDefinition, "content"> & {
  /** Filename relative to the skills directory (e.g. "chant-aws.md") */
  file: string;
};

/**
 * Create a skills loader that reads .md files from a lexicon's skills directory.
 *
 * Usage in a plugin:
 * ```ts
 * import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
 *
 * const loadSkills = createSkillsLoader(import.meta.url, [
 *   { file: "chant-aws.md", name: "chant-aws", description: "..." },
 * ]);
 *
 * // In plugin:
 * skills() { return loadSkills(); }
 * ```
 */
export function createSkillsLoader(
  importMetaUrl: string,
  specs: SkillFileSpec[],
): () => SkillDefinition[] {
  return () => {
    const skillsDir = join(dirname(fileURLToPath(importMetaUrl)), "skills");
    return specs.map(({ file, ...meta }) => {
      try {
        const content = readFileSync(join(skillsDir, file), "utf-8");
        return { ...meta, content };
      } catch {
        return { ...meta, content: "" };
      }
    });
  };
}

// ── MCP Diff Tool ─────────────────────────────────────────────────

/**
 * Create an MCP diff tool contribution for a lexicon.
 *
 * All lexicons (except Azure) expose an identical "diff" tool that compares
 * current build output against previous output using the lexicon's serializer.
 */
export function createDiffTool(
  serializer: Serializer,
  description: string,
): McpToolContribution {
  return {
    name: "diff",
    description,
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the infrastructure project directory",
        },
      },
    },
    async handler(params: Record<string, unknown>): Promise<unknown> {
      const { diffCommand } = await import("./cli/commands/diff");
      const result = await diffCommand({
        path: (params.path as string) ?? ".",
        serializers: [serializer],
      });
      return result;
    },
  };
}

// ── MCP Catalog Resource ──────────────────────────────────────────

/**
 * Create an MCP resource that serves the lexicon's meta.json as a catalog.
 *
 * Most lexicons expose a "resource-catalog" resource with identical structure.
 *
 * @param importMetaUrl — The plugin's import.meta.url (used to locate generated JSON)
 * @param name — Display name (e.g. "AWS Resource Catalog")
 * @param description — Resource description
 * @param lexiconJsonFile — Filename of the generated lexicon JSON (e.g. "lexicon-aws.json")
 */
export function createCatalogResource(
  importMetaUrl: string,
  name: string,
  description: string,
  lexiconJsonFile: string,
): McpResourceContribution {
  return {
    uri: "resource-catalog",
    name,
    description,
    mimeType: "application/json",
    async handler(): Promise<string> {
      const dir = dirname(fileURLToPath(importMetaUrl));
      const lexicon = JSON.parse(
        readFileSync(join(dir, "generated", lexiconJsonFile), "utf-8"),
      ) as Record<string, { resourceType: string; kind: string }>;
      const entries = Object.entries(lexicon).map(([className, entry]) => ({
        className,
        resourceType: entry.resourceType,
        kind: entry.kind,
      }));
      return JSON.stringify(entries);
    },
  };
}
