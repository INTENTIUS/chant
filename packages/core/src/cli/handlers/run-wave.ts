/**
 * `chant run wave --spec <file> --wave <k>` (#3679): the command each job of
 * a generated Op waves pipeline runs. See `../../op/op-waves-run.ts`.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { notifyOpWave } from "../../op/op-waves-notify";
import { parseOpWavesSpec, recordOpWaveHeadPlans, runOpWave } from "../../op/op-waves-run";
import type { OpWavesSpec } from "../../op/op-waves";
import { formatError, formatWarning } from "../format";
import { ledgerRecordingOff, NO_RECORD_ENV, noRecordEndNote, noRecordStartNote, resetNoRecordLedger } from "../../lifecycle/no-record";
import type { CommandContext } from "../registry";

/**
 * `chant run wave`, with recording off under `--no-record` or
 * `CHANT_NO_RECORD` (#4551), as `chant run` does (`./run.ts`): the flag sets
 * `CHANT_NO_RECORD` for the length of the job, so the ledger seam and every
 * chant process a hook starts see the same choice, and the job says so
 * before it starts and after it ends. Kept here, not imported from ./run.ts,
 * so the wave-job runtime bundle stays small.
 */
export async function runOpWaveCommand(ctx: CommandContext): Promise<number> {
  const flagged = ctx.args.noRecord === true;
  if (!flagged && !ledgerRecordingOff()) return runOpWaveJobCommand(ctx);
  const source = flagged ? "--no-record" : `${NO_RECORD_ENV}=${process.env[NO_RECORD_ENV]}`;
  const prior = process.env[NO_RECORD_ENV];
  if (flagged) process.env[NO_RECORD_ENV] = "1";
  resetNoRecordLedger();
  console.error(formatWarning({ message: noRecordStartNote(source) }));
  try {
    return await runOpWaveJobCommand(ctx);
  } finally {
    console.error(formatWarning({ message: noRecordEndNote(source) }));
    resetNoRecordLedger();
    if (flagged) {
      if (prior === undefined) delete process.env[NO_RECORD_ENV];
      else process.env[NO_RECORD_ENV] = prior;
    }
  }
}

async function runOpWaveJobCommand(ctx: CommandContext): Promise<number> {
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
      hint: "Run it as a generated Op waves pipeline does: chant run wave --spec <file> --wave <k> [--decide | --share <i> | --group <name> [--share <i>]]",
    }));
    return 1;
  }
  if (args.decide && (args.share !== undefined || args.group !== undefined)) {
    console.error(formatError({ message: `--decide and --${args.share !== undefined ? "share" : "group"} are two different jobs; pass one` }));
    return 1;
  }
  let spec: OpWavesSpec | undefined;
  const job = { ...(args.share !== undefined ? { share: args.share } : {}), ...(args.group !== undefined ? { group: args.group } : {}) };
  if (args.eventsJson && args.json) {
    console.error(formatError({ message: "--events-json and --json both print to stdout", hint: "Pass one. --events-json prints the job's run events; --json prints its result." }));
    return 1;
  }
  try {
    const path = resolve(specFile);
    spec = parseOpWavesSpec(readFileSync(path, "utf-8"), `--spec ${specFile}`);
    // #4555: --events-json streams the job's run events, a phase per wave and a step per run target.
    const stream = args.eventsJson
      ? await (await import("../run-events")).openCliRunEvents(args, { kind: "op", name: spec.name, cwd: process.cwd() })
      : undefined;
    const result = await runOpWave({
      ...(stream ? { events: stream.emit } : {}),
      spec,
      specFile: relative(process.cwd(), path),
      wave: args.wave,
      ...(args.decide ? { decide: true } : {}),
      ...(args.share !== undefined ? { share: args.share } : {}),
      ...(args.group !== undefined ? { group: args.group } : {}),
      ...(args.base ? { base: args.base } : {}),
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    // #3761: tell people, when the spec says where. Delivery never changes the exit code.
    await notifyOpWave(spec, args.wave, { result }, job);
    return result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(formatError({ message }));
    if (spec) await notifyOpWave(spec, args.wave, { error: message }, job);
    return 1;
  }
}
