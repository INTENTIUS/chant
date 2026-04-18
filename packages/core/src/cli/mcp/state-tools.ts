import { resolve } from "node:path";
import type { LexiconPlugin } from "../../lexicon";
import type { ToolDefinition, ToolHandler } from "./types";
import { readSnapshot } from "../../state/git";
import { build } from "../../build";
import { computeBuildDigest, diffDigests } from "../../state/digest";
import { takeSnapshot } from "../../state/snapshot";
import type { StateSnapshot } from "../../state/types";
export interface ToolRegistration {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * Create state-snapshot tool definition and handler
 */
export function createSnapshotTool(plugins: LexiconPlugin[]): ToolRegistration {
  return {
    definition: {
      name: "state-snapshot",
      description: "Capture deployed state for an environment",
      inputSchema: {
        type: "object",
        properties: {
          environment: { type: "string", description: "Target environment" },
          lexicon: { type: "string", description: "Optional — snapshot all lexicons if omitted" },
        },
        required: ["environment"],
      },
    },
    handler: async (params) => {
      const env = params.environment as string;
      const lexiconFilter = params.lexicon as string | undefined;
      const targetPlugins = lexiconFilter
        ? plugins.filter((p) => p.name === lexiconFilter)
        : plugins;
      const pluginsWithDescribe = targetPlugins.filter((p) => p.describeResources);
      if (pluginsWithDescribe.length === 0) return "No plugins implement describeResources";
      const serializers = plugins.map((p) => p.serializer);
      const buildResult = await build(resolve("."), serializers);
      if (buildResult.errors.length > 0) return "Build failed";
      const result = await takeSnapshot(env, pluginsWithDescribe, buildResult);
      return { snapshots: result.snapshots.length, warnings: result.warnings, errors: result.errors };
    },
  };
}

/**
 * Create state-diff tool definition and handler
 */
export function createDiffTool(plugins: LexiconPlugin[]): ToolRegistration {
  return {
    definition: {
      name: "state-diff",
      description: "Compare current build declarations against last snapshot's digest",
      inputSchema: {
        type: "object",
        properties: {
          environment: { type: "string", description: "Target environment" },
          lexicon: { type: "string", description: "Optional — diff all lexicons if omitted" },
        },
        required: ["environment"],
      },
    },
    handler: async (params) => {
      const env = params.environment as string;
      const lexiconFilter = params.lexicon as string | undefined;
      const serializers = plugins.map((p) => p.serializer);
      const buildResult = await build(resolve("."), serializers);
      if (buildResult.errors.length > 0) return "Build failed";
      const currentDigest = computeBuildDigest(buildResult);
      const lexicons = lexiconFilter ? [lexiconFilter] : buildResult.manifest.lexicons;
      const results: Record<string, unknown> = {};
      for (const lex of lexicons) {
        const content = await readSnapshot(env, lex);
        let previousDigest = undefined;
        if (content) {
          const snapshot: StateSnapshot = JSON.parse(content);
          previousDigest = snapshot.digest;
        }
        results[lex] = diffDigests(currentDigest, previousDigest);
      }
      return results;
    },
  };
}

