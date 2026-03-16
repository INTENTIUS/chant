import { resolve } from "node:path";
import type { LexiconPlugin } from "../../lexicon";
import type { ToolDefinition, ToolHandler } from "./types";
import { readSnapshot } from "../../state/git";
import { build } from "../../build";
import { computeBuildDigest, diffDigests } from "../../state/digest";
import { takeSnapshot } from "../../state/snapshot";
import type { StateSnapshot } from "../../state/types";
import { discoverSpells } from "../../spell/discovery";

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

/**
 * Create spell-done tool definition and handler
 */
export function createSpellDoneTool(): ToolRegistration {
  return {
    definition: {
      name: "spell-done",
      description: "Mark a spell task as done",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Spell name" },
          taskNumber: { type: "number", description: "Task number (1-based)" },
        },
        required: ["name", "taskNumber"],
      },
    },
    handler: async (params) => {
      const { readFileSync, writeFileSync } = await import("node:fs");
      const { spells } = await discoverSpells();
      const name = params.name as string;
      const taskNumber = params.taskNumber as number;
      const spell = spells.get(name);
      if (!spell) return `Spell "${name}" not found`;
      if (taskNumber < 1 || taskNumber > spell.definition.tasks.length) {
        return `Invalid task number ${taskNumber}`;
      }
      const task = spell.definition.tasks[taskNumber - 1];
      if (task.done) return `Task ${taskNumber} is already done`;

      const content = readFileSync(spell.filePath, "utf-8");
      let count = 0;
      const rewritten = content.replace(
        /task\(("[^"]*"|'[^']*'|`[^`]*`)((?:\s*,\s*\{[^}]*\})?)\)/g,
        (match, desc, opts) => {
          count++;
          if (count !== taskNumber) return match;
          if (opts && opts.includes("done:")) {
            return match.replace(/done:\s*false/, "done: true");
          }
          return `task(${desc}, { done: true })`;
        },
      );
      if (rewritten === content) return `Could not rewrite task ${taskNumber}`;
      writeFileSync(spell.filePath, rewritten);
      return `Task ${taskNumber} marked done: "${task.description}"`;
    },
  };
}
