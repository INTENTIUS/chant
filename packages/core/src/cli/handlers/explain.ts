import { resolve, join, dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { discover } from "../../discovery/index";
import { buildOkfBundle, OKF_VERSION, type OkfFile } from "../../okf";
import { handleExplain } from "../mcp/tools/explain";
import { formatError, formatSuccess } from "../format";
import type { CommandContext } from "../registry";

const EXPLAIN_FORMATS = ["markdown", "json", "okf"] as const;
type ExplainFormat = (typeof EXPLAIN_FORMATS)[number];

/**
 * `chant explain [path] [--format markdown|json|okf] [-o <dir>]` — the CLI
 * path of the MCP `explain` tool (#1058): a structured summary of every
 * discovered entity. `--format okf` emits an OKF v0.2 knowledge bundle
 * instead — one markdown concept per entity plus an `index.md` — written as a
 * directory tree under `-o <dir>`, or printed as JSON (path → content) when
 * no output directory is given.
 */
export async function runExplain(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const format = (args.format || "markdown") as ExplainFormat;
  if (!EXPLAIN_FORMATS.includes(format)) {
    console.error(formatError({
      message: `Invalid --format: ${format}. Expected one of ${EXPLAIN_FORMATS.join(", ")}.`,
    }));
    return 1;
  }

  const projectPath = resolve(args.path === "." ? "." : args.path);

  if (format === "okf") {
    const result = await discover(projectPath);
    for (const err of result.errors) console.error(formatError({ message: err.message }));
    const bundle = buildOkfBundle(result, projectPath);
    if (args.output) {
      await writeBundle(bundle, resolve(args.output));
      console.log(formatSuccess(`Wrote OKF v${OKF_VERSION} bundle: ${bundle.length} file(s) under ${args.output}`));
    } else {
      console.log(JSON.stringify({
        okf_version: OKF_VERSION,
        files: Object.fromEntries(bundle.map((f) => [f.path, f.content])),
      }, null, 2));
    }
    return result.errors.length > 0 ? 1 : 0;
  }

  const summary = await handleExplain({ path: projectPath, format });
  console.log(typeof summary === "string" ? summary : JSON.stringify(summary, null, 2));
  return 0;
}

/** Write the bundle's files under `outDir`, creating subdirectories as needed. */
async function writeBundle(bundle: OkfFile[], outDir: string): Promise<void> {
  for (const file of bundle) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf-8");
  }
}
