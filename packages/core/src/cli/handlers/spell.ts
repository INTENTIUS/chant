import { resolve, join } from "node:path";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { mkdirSync, existsSync } from "node:fs";
import { getRuntime } from "../../runtime-adapter";
import { discoverSpells } from "../../spell/discovery";
import { generatePrompt } from "../../spell/prompt";
import { formatError, formatWarning, formatSuccess, formatBold } from "../format";
import { loadPlugin } from "../plugins";
import type { CommandContext } from "../registry";

/**
 * Find the git root directory.
 */
async function findGitRoot(): Promise<string> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) throw new Error("Not in a git repository");
  return result.stdout.trim();
}

/**
 * chant spell add <name>
 */
export async function runSpellAdd(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    console.error(formatError({ message: "Name is required: chant spell add <name>" }));
    return 1;
  }

  // Validate name format
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    console.error(formatError({ message: `Invalid spell name: "${name}" (must be kebab-case, max 64 chars)` }));
    return 1;
  }

  const gitRoot = await findGitRoot();
  const spellsDir = join(gitRoot, "spells");
  const filePath = join(spellsDir, `${name}.spell.ts`);

  if (existsSync(filePath)) {
    console.error(formatError({ message: `Spell "${name}" already exists at ${filePath}` }));
    return 1;
  }

  mkdirSync(spellsDir, { recursive: true });

  const template = `import { spell, task } from "@intentius/chant";

export default spell({
  name: "${name}",
  overview: "",
  tasks: [
    task(""),
  ],
});
`;

  writeFileSync(filePath, template);
  console.error(formatSuccess(`Created ${filePath}`));
  return 0;
}

/**
 * chant spell rm <name>
 */
export async function runSpellRm(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    console.error(formatError({ message: "Name is required: chant spell rm <name>" }));
    return 1;
  }

  const gitRoot = await findGitRoot();
  const filePath = join(gitRoot, "spells", `${name}.spell.ts`);

  if (!existsSync(filePath)) {
    console.error(formatError({ message: `Spell "${name}" not found at ${filePath}` }));
    return 1;
  }

  // Check for dependents (unless --force)
  if (!ctx.args.force) {
    const { spells } = await discoverSpells();
    const dependents = [];
    for (const [depName, spell] of spells) {
      if (spell.definition.depends?.includes(name)) {
        dependents.push(depName);
      }
    }
    if (dependents.length > 0) {
      console.error(formatWarning({
        message: `Spell "${name}" is depended on by: ${dependents.join(", ")}`,
        hint: "Use --force to delete anyway",
      }));
      return 1;
    }
  }

  unlinkSync(filePath);
  console.error(formatSuccess(`Removed ${filePath}`));
  return 0;
}

/**
 * chant spell list
 */
export async function runSpellList(ctx: CommandContext): Promise<number> {
  const { spells, errors } = await discoverSpells();

  for (const err of errors) {
    console.error(formatError({ message: err }));
  }

  if (spells.size === 0) {
    console.error(formatWarning({ message: "No spells found" }));
    return 0;
  }

  // Filter by --ready flag if present (using extraPositional as a hack)
  const readyOnly = ctx.args.format === "ready";

  console.log(
    "NAME".padEnd(20) +
    "STATUS".padEnd(10) +
    "TASKS".padEnd(10) +
    "LEXICON".padEnd(12) +
    "OVERVIEW"
  );

  for (const [name, spell] of spells) {
    if (readyOnly && spell.status !== "ready") continue;

    const def = spell.definition;
    const doneCount = def.tasks.filter((t) => t.done).length;
    const tasksStr = `[${doneCount}/${def.tasks.length}]`;
    const lexicon = def.lexicon ?? "";
    const overview = def.overview.length > 40
      ? def.overview.slice(0, 37) + "..."
      : def.overview;

    console.log(
      name.padEnd(20) +
      spell.status.padEnd(10) +
      tasksStr.padEnd(10) +
      lexicon.padEnd(12) +
      overview
    );
  }

  return 0;
}

/**
 * chant spell show <name>
 */
export async function runSpellShow(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    console.error(formatError({ message: "Name is required: chant spell show <name>" }));
    return 1;
  }

  const { spells, errors } = await discoverSpells();
  const spell = spells.get(name);

  if (!spell) {
    // Try to reconstruct from git history
    const rt = getRuntime();
    const result = await rt.spawn([
      "git", "log", "--all", "--format=%H", "--diff-filter=D",
      "--", `spells/${name}.spell.ts`,
    ]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      const commit = result.stdout.trim().split("\n")[0];
      const showResult = await rt.spawn([
        "git", "show", `${commit}^:spells/${name}.spell.ts`,
      ]);
      if (showResult.exitCode === 0) {
        console.log(`(Reconstructed from git history, commit ${commit.slice(0, 7)})\n`);
        console.log(showResult.stdout);
        return 0;
      }
    }

    console.error(formatError({ message: `Spell "${name}" not found` }));
    return 1;
  }

  const def = spell.definition;
  const doneCount = def.tasks.filter((t) => t.done).length;

  console.log(formatBold(def.name));
  console.log(`Status: ${spell.status} [${doneCount}/${def.tasks.length}]`);
  if (def.lexicon) console.log(`Lexicon: ${def.lexicon}`);
  console.log(`\n${def.overview}\n`);

  console.log("Tasks:");
  def.tasks.forEach((t, i) => {
    const check = t.done ? "[x]" : "[ ]";
    console.log(`  ${i + 1}. ${check} ${t.description}`);
  });

  if (def.depends && def.depends.length > 0) {
    console.log(`\nDepends: ${def.depends.join(", ")}`);
  }

  if (def.afterAll && def.afterAll.length > 0) {
    console.log(`\nAfter all: ${def.afterAll.join(", ")}`);
  }

  return 0;
}

/**
 * chant spell cast <name> — generate bootstrap prompt
 */
export async function runSpellCast(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    console.error(formatError({ message: "Name is required: chant spell cast <name>" }));
    return 1;
  }

  const { spells, errors } = await discoverSpells();

  for (const err of errors) {
    console.error(formatError({ message: err }));
  }

  const spell = spells.get(name);
  if (!spell) {
    console.error(formatError({ message: `Spell "${name}" not found` }));
    return 1;
  }

  // Warn if blocked or done (unless --force)
  if (spell.status === "blocked" && !ctx.args.force) {
    console.error(formatWarning({
      message: `Spell "${name}" is blocked by incomplete dependencies`,
      hint: "Use --force to proceed anyway",
    }));
    return 1;
  }
  if (spell.status === "done" && !ctx.args.force) {
    console.error(formatWarning({
      message: `Spell "${name}" is already done`,
      hint: "Use --force to proceed anyway",
    }));
    return 1;
  }

  const gitRoot = await findGitRoot();

  // Load the spell's lexicon plugin directly (not all project lexicons)
  const plugins: import("../../lexicon").LexiconPlugin[] = [];
  if (spell.definition.lexicon) {
    try {
      const plugin = await loadPlugin(spell.definition.lexicon);
      if (plugin.init) await plugin.init();
      plugins.push(plugin);
    } catch {
      console.error(formatWarning({
        message: `Lexicon "${spell.definition.lexicon}" could not be loaded — skills will not be inlined`,
        hint: `Install @intentius/chant-lexicon-${spell.definition.lexicon}`,
      }));
    }
  }

  const prompt = await generatePrompt(spell.definition, {
    gitRoot,
    plugins: plugins.length > 0 ? plugins : undefined,
  });

  console.log(prompt);
  return 0;
}

/**
 * chant spell done <name> <task-number>
 *
 * Rewrites task() call in the source file to mark it as done.
 */
export async function runSpellDone(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  const taskNumStr = ctx.args.extraPositional2;

  if (!name || !taskNumStr) {
    console.error(formatError({ message: "Usage: chant spell done <name> <task-number>" }));
    return 1;
  }

  const taskNum = parseInt(taskNumStr, 10);
  if (isNaN(taskNum) || taskNum < 1) {
    console.error(formatError({ message: `Invalid task number: ${taskNumStr}` }));
    return 1;
  }

  const { spells } = await discoverSpells();
  const spell = spells.get(name);
  if (!spell) {
    console.error(formatError({ message: `Spell "${name}" not found` }));
    return 1;
  }

  if (taskNum > spell.definition.tasks.length) {
    console.error(formatError({
      message: `Task ${taskNum} does not exist (spell has ${spell.definition.tasks.length} tasks)`,
    }));
    return 1;
  }

  const task = spell.definition.tasks[taskNum - 1];
  if (task.done) {
    console.error(formatWarning({ message: `Task ${taskNum} is already done` }));
    return 0;
  }

  // Rewrite the source file
  const content = readFileSync(spell.filePath, "utf-8");
  const rewritten = markTaskDone(content, taskNum);

  if (rewritten === content) {
    console.error(formatError({ message: `Could not find task ${taskNum} in source file` }));
    return 1;
  }

  writeFileSync(spell.filePath, rewritten);
  console.error(formatSuccess(`Task ${taskNum} marked done: "${task.description}"`));
  return 0;
}

/**
 * Regex-based rewrite: find the Nth task() call and add { done: true }.
 */
function markTaskDone(source: string, taskNum: number): string {
  let count = 0;
  // Match task("...") or task("...", { done: false })
  return source.replace(
    /task\(("[^"]*"|'[^']*'|`[^`]*`)((?:\s*,\s*\{[^}]*\})?)\)/g,
    (match, desc, opts) => {
      count++;
      if (count !== taskNum) return match;

      // Already has opts — replace done: false with done: true or add done: true
      if (opts && opts.includes("done:")) {
        return match.replace(/done:\s*false/, "done: true");
      }
      return `task(${desc}, { done: true })`;
    },
  );
}

/**
 * chant graph — show dependency graph
 */
export async function runGraph(ctx: CommandContext): Promise<number> {
  const { spells, errors } = await discoverSpells();

  for (const err of errors) {
    console.error(formatError({ message: err }));
  }

  if (spells.size === 0) {
    console.error(formatWarning({ message: "No spells found" }));
    return 0;
  }

  let hasEdges = false;
  for (const [name, spell] of spells) {
    const deps = spell.definition.depends;
    if (deps && deps.length > 0) {
      for (const dep of deps) {
        console.log(`${dep} → ${name}`);
        hasEdges = true;
      }
    }
  }

  if (!hasEdges) {
    console.log("No dependencies");
  }

  return 0;
}

/**
 * Fallback for unknown spell subcommands.
 */
export async function runSpellUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown spell subcommand: ${ctx.args.extraPositional ?? ctx.args.path}`,
    hint: "Available: chant spell add, chant spell rm, chant spell list, chant spell show, chant spell cast, chant spell done",
  }));
  return 1;
}
