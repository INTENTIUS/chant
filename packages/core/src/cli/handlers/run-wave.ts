/**
 * `chant run wave --spec <file> --wave <k>` (#3679): the command each job of
 * a generated Op waves pipeline runs. See `../../op/op-waves-run.ts`.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseOpWavesSpec, recordOpWaveHeadPlans, runOpWave } from "../../op/op-waves-run";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

export async function runOpWaveCommand(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const specFile = args.opsSpec;
  if (specFile && args.recordPlans) {
    try {
      const spec = parseOpWavesSpec(readFileSync(resolve(specFile), "utf-8"), `--spec ${specFile}`);
      const plans = await recordOpWaveHeadPlans({ spec });
      if (args.json) console.log(JSON.stringify(plans, null, 2));
      else for (const w of plans.waves) console.error(`wave ${w.wave} (${w.name}) at ${plans.head.slice(0, 12)}: ${w.digest}`);
      return 0;
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
  }
  if (!specFile || args.wave === undefined) {
    console.error(formatError({
      message: "`chant run wave` needs --spec <file> and --wave <k>",
      hint: "Run it as a generated Op waves pipeline does: chant run wave --spec <file> --wave <k> [--decide | --share <i>]",
    }));
    return 1;
  }
  if (args.decide && args.share !== undefined) {
    console.error(formatError({ message: "--decide and --share are two different jobs; pass one" }));
    return 1;
  }
  try {
    const path = resolve(specFile);
    const spec = parseOpWavesSpec(readFileSync(path, "utf-8"), `--spec ${specFile}`);
    const result = await runOpWave({
      spec,
      specFile: relative(process.cwd(), path),
      wave: args.wave,
      ...(args.decide ? { decide: true } : {}),
      ...(args.share !== undefined ? { share: args.share } : {}),
      ...(args.base ? { base: args.base } : {}),
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    return result.exitCode;
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}
