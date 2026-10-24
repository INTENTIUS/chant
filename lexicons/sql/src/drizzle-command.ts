/**
 * `chant sql drizzle [--output <path>] [--check] [--bigint number|bigint]`
 * (#4401): build the project the way `chant build` does, folded, and write the
 * Drizzle schema module {@link renderDrizzle} renders from its entities.
 *
 * The file goes to `<project>/drizzle-schema.ts` by default, outside the
 * source directory the build reads, and starts with chant's generated-file
 * marker either way. `-o` and `--output` put it elsewhere, which is also the
 * flag a workspace `generated` entry's generator passes. `--check` renders the
 * same text and compares it with the file instead of writing it: exit 1,
 * naming the file, when they differ.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { CommandGroupContext } from "@intentius/chant/cli/command-group";
import { DrizzleDialectError, renderDrizzle } from "./drizzle";
import { buildFolded, loadProject } from "./sql-types-command";

/** The file `chant sql drizzle` writes by default, in the project directory. */
export const DRIZZLE_SCHEMA_FILE = "drizzle-schema.ts";

const USAGE = "usage: chant sql drizzle [--output <path>] [--check] [--bigint number|bigint]";

interface Args {
  output?: string;
  check: boolean;
  bigint?: "number" | "bigint";
}

function parseArgs(args: readonly string[]): Args | { error: string } {
  const out: Args = { check: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--output" || a === "-o") {
      const v = args[++i];
      if (!v) return { error: `${a} needs a path` };
      out.output = v;
    } else if (a.startsWith("--output=")) out.output = a.slice("--output=".length);
    else if (a === "--check") out.check = true;
    else if (a === "--bigint" || a.startsWith("--bigint=")) {
      const v = a === "--bigint" ? args[++i] : a.slice("--bigint=".length);
      if (v !== "number" && v !== "bigint") return { error: "--bigint takes number or bigint" };
      out.bigint = v;
    } else return { error: `unknown argument ${a}` };
  }
  return out;
}

export async function runDrizzle(ctx: CommandGroupContext): Promise<number> {
  const args = parseArgs(ctx.rawArgs);
  if ("error" in args) {
    console.error(`${args.error}\n${USAGE}`);
    return 1;
  }
  const cwd = process.cwd();
  const project = await loadProject(cwd);
  const output = args.output !== undefined ? resolve(cwd, args.output) : join(project.projectDir, DRIZZLE_SCHEMA_FILE);
  const result = await buildFolded(project, "chant sql drizzle", "nothing was written");
  if (!result) return 1;

  let rendered;
  try {
    rendered = renderDrizzle(result.entities, { config: project.config as unknown as Record<string, unknown>, ...(args.bigint ? { bigintMode: args.bigint } : {}) });
  } catch (err) {
    if (!(err instanceof DrizzleDialectError)) throw err;
    console.error(`chant sql drizzle: ${err.message}`);
    return 1;
  }
  const shown = relative(cwd, output);
  const named = shown && !shown.startsWith("..") ? shown : output;
  if (args.check) {
    // Compares only; the file is never written.
    const onDisk = existsSync(output) ? readFileSync(output, "utf8") : undefined;
    if (onDisk === rendered.text) {
      console.log(`${named} is current`);
      return 0;
    }
    console.error(
      onDisk === undefined
        ? `chant sql drizzle: ${named} does not exist; run \`chant sql drizzle\` to write it`
        : `chant sql drizzle: ${named} differs from what the build declares; run \`chant sql drizzle\` to rewrite it`,
    );
    return 1;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rendered.text);
  const { tables, views, enums, sequences } = rendered.counts;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  console.log(`wrote ${named}: ${[plural(tables, "table"), plural(views, "view"), plural(enums, "enum"), plural(sequences, "sequence")].join(", ")}`);
  for (const s of rendered.skipped) console.log(`not written: ${s.kind} ${s.names.join(", ")} (${s.reason})`);
  for (const n of rendered.approximated) console.log(`partly written: ${n}`);
  return 0;
}
