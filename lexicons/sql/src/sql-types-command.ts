/**
 * `chant sql types [--output <path>] [--check]` (#3751): build the project the way
 * `chant build` does, folded, and write the declarations
 * {@link renderSqlTypes} renders from its entities, so a tag given its
 * qualified name as the type argument has typed columns.
 *
 * The file goes to `<sourceDir>/sql-types.d.ts` (the project root when
 * `sourceDir` is unset), where any tsconfig that includes the schema includes
 * it too. `--output` puts it elsewhere, as a workspace `generated` entry's
 * generator does. The command refuses to write beside a `sql-types.ts`: tsc
 * resolves the `.ts` first and would drop the declarations. `chant build`
 * never writes the file. `--check` renders the same text and compares it with
 * the file instead of writing it: exit 1, naming the file, when they differ.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CommandGroupContext } from "@intentius/chant/cli/command-group";
import { renderSqlTypes, SQL_TYPES_FILE } from "./sql-types";

export interface ProjectLocation {
  config: Awaited<ReturnType<typeof import("@intentius/chant/config").loadChantConfigUpward>>["config"];
  projectDir: string;
  sourceDir: string;
}

const USAGE = "usage: chant sql types [--output <path>] [--check]";

/** The `--output` value, or an error message. */
function parseArgs(args: readonly string[]): { output?: string; check: boolean } | { error: string } {
  let output: string | undefined;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--output") {
      output = args[++i];
      if (!output) return { error: "--output needs a path" };
    } else if (a === "--check") check = true;
    else if (a.startsWith("--output=")) output = a.slice("--output=".length);
    else return { error: `unknown argument ${a}` };
  }
  return output === undefined ? { check } : { output, check };
}

/** The file tsc would read instead of `path`: `sql-types.ts` beside `sql-types.d.ts`. */
export function shadowingSource(path: string): string | undefined {
  if (!path.endsWith(".d.ts")) return undefined;
  const source = `${path.slice(0, -".d.ts".length)}.ts`;
  return existsSync(source) ? source : undefined;
}

/** The project the working directory belongs to: its config, its root and its source directory. */
export async function loadProject(cwd: string): Promise<ProjectLocation> {
  const { loadChantConfigUpward } = await import("@intentius/chant/config");
  const { config, configPath } = await loadChantConfigUpward(cwd);
  const projectDir = configPath ? dirname(configPath) : cwd;
  return { config, projectDir, sourceDir: resolve(projectDir, config.sourceDir ?? ".") };
}

/**
 * The fold build's entities: what `chant build` declares, `.sql` files and
 * composite members included. Prints the build's errors and returns
 * undefined when it fails.
 */
export async function buildFolded(project: ProjectLocation, command: string, consequence: string) {
  const { config, projectDir, sourceDir } = project;
  const { build } = await import("@intentius/chant/build");
  const { resolveBuildModes, resolveProjectBuildOptions } = await import("@intentius/chant/cli/build-options");
  const { loadPlugins, resolveProjectLexicons } = await import("@intentius/chant/cli/plugins");
  const { sqlSerializer } = await import("./serializer");
  const plugins = await loadPlugins(await resolveProjectLexicons(projectDir, { lexicon: "sql" }));
  const options = resolveProjectBuildOptions({ config, configDir: projectDir, plugins, modes: resolveBuildModes(config, { fold: true }) });
  const result = await build(sourceDir, [sqlSerializer], undefined, options);
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(e instanceof Error ? e.message : String(e));
    console.error(`${command}: the build failed, so ${consequence}`);
    return undefined;
  }
  return result;
}

export async function runTypes(ctx: CommandGroupContext): Promise<number> {
  const args = parseArgs(ctx.rawArgs);
  if ("error" in args) {
    console.error(`${args.error}\n${USAGE}`);
    return 1;
  }
  const cwd = process.cwd();
  const { config, projectDir, sourceDir } = await loadProject(cwd);
  const output = args.output !== undefined ? resolve(cwd, args.output) : join(sourceDir, SQL_TYPES_FILE);
  const shadow = shadowingSource(output);
  if (shadow) {
    console.error(`chant sql types: ${relative(cwd, shadow) || basename(shadow)} sits beside ${relative(cwd, output) || basename(output)}, and tsc reads it instead of the declarations; rename one`);
    return 1;
  }

  const result = await buildFolded({ config, projectDir, sourceDir }, "chant sql types", "nothing was written");
  if (!result) return 1;
  const text = renderSqlTypes(result.entities, { projectDir, config: config as unknown as Record<string, unknown> });
  const shown = relative(cwd, output);
  const named = shown && !shown.startsWith("..") ? shown : output;
  if (args.check) {
    // Compares only; the file is never written.
    const onDisk = existsSync(output) ? readFileSync(output, "utf8") : undefined;
    if (onDisk === text) {
      console.log(`${named} is current`);
      return 0;
    }
    console.error(
      onDisk === undefined
        ? `chant sql types: ${named} does not exist; run \`chant sql types\` to write it`
        : `chant sql types: ${named} differs from what the build declares; run \`chant sql types\` to rewrite it`,
    );
    return 1;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text);
  const count = (text.match(/^ {4}"/gm) ?? []).length;
  console.log(`wrote ${named}: ${count} relation${count === 1 ? "" : "s"}`);
  return 0;
}
