/**
 * `chant dev generated-check [<render>...] [--json]` (#4909): render the
 * product's declared generated files (`chantGenerated` in its root
 * package.json) into a directory under the OS temp directory, compare each
 * with the committed file, and exit 1 naming every one that drifted. The
 * directory is left in place and printed. Exit 2 when the product declares
 * no `chantGenerated`.
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
