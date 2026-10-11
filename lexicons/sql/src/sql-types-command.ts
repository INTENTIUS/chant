/**
 * `chant sql types [--output <path>]` (#3751): build the project the way
 * `chant build` does, folded, and write the declarations
 * {@link renderSqlTypes} renders from its entities, so a tag given its
 * qualified name as the type argument has typed columns.
 *
 * The file goes to `<sourceDir>/sql-types.d.ts` (the project root when
 * `sourceDir` is unset), where any tsconfig that includes the schema includes
 * it too. `--output` puts it elsewhere, as a workspace `generated` entry's
 * generator does. The command refuses to write beside a `sql-types.ts`: tsc
 * resolves the `.ts` first and would drop the declarations. `chant build`
 * never writes the file.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CommandGroupContext } from "@intentius/chant/cli/command-group";
import { renderSqlTypes, SQL_TYPES_FILE } from "./sql-types";

const USAGE = "usage: chant sql types [--output <path>]";

/** The `--output` value, or an error message. */
function parseArgs(args: readonly string[]): { output?: string } | { error: string } {
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--output") {
      output = args[++i];
      if (!output) return { error: "--output needs a path" };
    } else if (a.startsWith("--output=")) output = a.slice("--output=".length);
    else return { error: `unknown argument ${a}` };
  }
  return output === undefined ? {} : { output };
}

/** The file tsc would read instead of `path`: `sql-types.ts` beside `sql-types.d.ts`. */
export function shadowingSource(path: string): string | undefined {
  if (!path.endsWith(".d.ts")) return undefined;
  const source = `${path.slice(0, -".d.ts".length)}.ts`;
  return existsSync(source) ? source : undefined;
}

export async function runTypes(ctx: CommandGroupContext): Promise<number> {
  const args = parseArgs(ctx.rawArgs);
  if ("error" in args) {
    console.error(`${args.error}\n${USAGE}`);
    return 1;
  }
  const cwd = process.cwd();
  const { loadChantConfigUpward } = await import("@intentius/chant/config");
  const { config, configPath } = await loadChantConfigUpward(cwd);
  const projectDir = configPath ? dirname(configPath) : cwd;
  const sourceDir = resolve(projectDir, config.sourceDir ?? ".");
  const output = args.output !== undefined ? resolve(cwd, args.output) : join(sourceDir, SQL_TYPES_FILE);
  const shadow = shadowingSource(output);
  if (shadow) {
    console.error(`chant sql types: ${relative(cwd, shadow) || basename(shadow)} sits beside ${relative(cwd, output) || basename(output)}, and tsc reads it instead of the declarations; rename one`);
    return 1;
  }

  const { build } = await import("@intentius/chant/build");
  const { resolveBuildModes, resolveProjectBuildOptions } = await import("@intentius/chant/cli/build-options");
  const { loadPlugins, resolveProjectLexicons } = await import("@intentius/chant/cli/plugins");
  const { sqlSerializer } = await import("./serializer");
  const plugins = await loadPlugins(await resolveProjectLexicons(projectDir, { lexicon: "sql" }));
  // The fold build's entities: what `chant build` declares, `.sql` files and composite members included.
  const options = resolveProjectBuildOptions({ config, configDir: projectDir, plugins, modes: resolveBuildModes(config, { fold: true }) });
  const result = await build(sourceDir, [sqlSerializer], undefined, options);
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(e instanceof Error ? e.message : String(e));
    console.error("chant sql types: the build failed, so nothing was written");
    return 1;
  }
  const text = renderSqlTypes(result.entities, { projectDir, config: config as unknown as Record<string, unknown> });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text);
  const count = (text.match(/^ {4}"/gm) ?? []).length;
  const shown = relative(cwd, output);
  console.log(`wrote ${shown && !shown.startsWith("..") ? shown : output}: ${count} relation${count === 1 ? "" : "s"}`);
  return 0;
}
