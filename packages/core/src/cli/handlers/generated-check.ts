/**
 * `chant dev generated-check [<render>...] [--json]` (#4909): render the
 * product's declared generated files (`chantGenerated` in its root
 * package.json) into a directory under the OS temp directory, compare each
 * with the committed file, and exit 1 naming every one that drifted. The
 * directory is left in place and printed. Exit 2 when the product declares
 * no `chantGenerated`. Also `chant dev render` (#4950), which writes a
 * module's file-text export in place.
 */
import { checkGenerated, readGeneratedCheckConfig } from "../../generated-check";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant dev generated-check [<render>...] [--json]";

export async function runDevGeneratedCheck(ctx: CommandContext): Promise<number> {
  const productDir = process.cwd();
  let config;
  try {
    config = readGeneratedCheckConfig(productDir);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return 2;
  }
  if (!config) {
    console.error(formatError({ message: "package.json here declares no chantGenerated", hint: USAGE }));
    return 2;
  }
  const only = (ctx.args.positionals ?? []).slice(1);
  const result = await checkGenerated(productDir, config, { only });
  if (ctx.args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const f of result.matched) console.error(`  generated-check: ${f} matches its render`);
    for (const p of result.problems) console.error(`generated-check: ${p}`);
    console.error(`generated-check: the renders are in ${result.out}`);
    if (result.ok) console.error(`generated-check: ${result.matched.length} files match ${result.renders.length} renders`);
  }
  return result.ok ? 0 : 1;
}

const RENDER_USAGE = "chant dev render <module> <export> [--output <root>]";

/**
 * `chant dev render <module> <export> [--output <root>]` (#4950): import the
 * module, call its export (a `{ path: text }` object, or a function that
 * returns one) and write each file at its path below the root, the working
 * directory unless `--output` names one. Under `chant dev generated-check`
 * a path inside the product goes to the render tree instead.
 */
export async function runDevRender(ctx: CommandContext): Promise<number> {
  const [, modulePath, exportName] = ctx.args.positionals ?? [];
  if (!modulePath || !exportName) {
    console.error(formatError({ message: "name the module and its export that returns the files", hint: RENDER_USAGE }));
    return 2;
  }
  const { resolve } = await import("node:path");
  const { renderPathOf } = await import("../../generated-check");
  const { renderModuleFiles, writeRenderedFiles } = await import("../../render-module");
  try {
    const files = await renderModuleFiles(modulePath, exportName);
    const root = resolve(ctx.args.output ?? ".");
    for (const path of writeRenderedFiles(root, files, renderPathOf)) console.error(`  wrote ${path}`);
    return 0;
  } catch (err) {
    console.error(formatError({ message: `chant dev render: ${err instanceof Error ? err.message : String(err)}`, hint: RENDER_USAGE }));
    return 1;
  }
}
