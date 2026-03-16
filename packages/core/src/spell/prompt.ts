/**
 * Bootstrap prompt generation for spells.
 *
 * Resolves context items (static strings, files, commands), assembles the
 * full prompt with overview, context, task list, and afterAll instructions.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getRuntime } from "../runtime-adapter";
import type { SpellDefinition, ContextItem, Task } from "./types";
import type { LexiconPlugin } from "../lexicon";

/**
 * Resolve a single context item to a string.
 */
async function resolveContextItem(
  item: string | ContextItem,
  gitRoot: string,
): Promise<string> {
  if (typeof item === "string") return item;

  if (item.type === "file") {
    const filePath = join(gitRoot, item.value);
    try {
      const content = await readFile(filePath, "utf-8");
      return `--- ${item.value} ---\n${content}`;
    } catch {
      return `[Context error: ${item.value} not found]`;
    }
  }

  if (item.type === "cmd") {
    const rt = getRuntime();
    try {
      const result = await rt.spawn(["sh", "-c", item.value], { cwd: gitRoot });
      if (result.exitCode !== 0) {
        return `[Context error: command "${item.value}" failed with exit code ${result.exitCode}]\n${result.stderr}`;
      }
      return `--- $ ${item.value} ---\n${result.stdout}`;
    } catch (err) {
      return `[Context error: command "${item.value}" failed: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }

  return String(item);
}

/**
 * Format the task list for the prompt.
 */
function formatTasks(tasks: Task[]): string {
  return tasks
    .map((t, i) => {
      const check = t.done ? "[x]" : "[ ]";
      return `${i + 1}. ${check} ${t.description}`;
    })
    .join("\n");
}

/**
 * Find relevant skill content from a lexicon plugin.
 */
function getLexiconSkillContent(
  lexiconName: string,
  plugins: LexiconPlugin[],
): string | null {
  const plugin = plugins.find((p) => p.name === lexiconName);
  if (!plugin?.skills) return null;
  const skills = plugin.skills();
  if (skills.length === 0) return null;

  return skills
    .map((s) => `### ${s.name}\n\n${s.content}`)
    .join("\n\n");
}

export interface PromptOptions {
  gitRoot: string;
  plugins?: LexiconPlugin[];
}

/**
 * Generate the bootstrap prompt for a spell.
 */
export async function generatePrompt(
  spell: SpellDefinition,
  opts: PromptOptions,
): Promise<string> {
  const sections: string[] = [];

  // Header
  sections.push(`# Spell: ${spell.name}\n`);

  // Overview
  sections.push(`## Overview\n\n${spell.overview}\n`);

  // Resolved context
  if (spell.context && spell.context.length > 0) {
    const resolved = await Promise.all(
      spell.context.map((item) => resolveContextItem(item, opts.gitRoot)),
    );
    sections.push(`## Context\n\n${resolved.join("\n\n")}\n`);
  }

  // Lexicon skill guidance
  if (spell.lexicon && opts.plugins) {
    const skillContent = getLexiconSkillContent(spell.lexicon, opts.plugins);
    if (skillContent) {
      sections.push(`## ${spell.lexicon} Guidance\n\n${skillContent}\n`);
    }
  }

  // Task list
  sections.push(`## Tasks\n\n${formatTasks(spell.tasks)}\n`);

  // After all
  if (spell.afterAll && spell.afterAll.length > 0) {
    sections.push(
      `## After Completion\n\nAfter all tasks are done, run:\n${spell.afterAll.map((c) => `- \`${c}\``).join("\n")}\n`,
    );
  }

  // Instructions
  sections.push(
    `## Instructions\n\n` +
    `- Mark tasks done with: \`chant spell done ${spell.name} <task-number>\`\n` +
    `- Task numbers are 1-based\n` +
    `- Commit with trailer: \`Spell: ${spell.name}\`\n` +
    `- Work through tasks in order\n`,
  );

  return sections.join("\n");
}
