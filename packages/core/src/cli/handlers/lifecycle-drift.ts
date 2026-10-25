/**
 * `chant lifecycle drift [--member <name>] [--read <read>] [--resource <addr>]`
 * (behold#995): the project's drift, as each lexicon's own engine reads it,
 * printed as the drift-record NDJSON stream (`../../drift-record.ts`).
 *
 * This is the member half of `chant workspace drift`. A `terraform` or
 * `choudoufu` member has no chant config of its own, so the workspace writes
 * it a reader project (`../../workspace/kind-readers.ts`) and runs this
 * command there, under the member's own toolchain, the way `workspace graph`
 * runs `chant graph`. Every lexicon with a `readDrift` is asked; the lines
 * are printed in the order they came, one JSON object per line. chant core
 * never imports a lexicon to read drift.
 *
 * `--member` names the workspace member the records are for; it defaults to
 * the project directory's name. A lexicon that refuses the read (a read its
 * engine has not got, or one resource on an engine that cannot read one on
 * its own) makes the command print `{"refused": {code, message}}` as its
 * only stdout line and exit 3, so the workspace command can name the
 * refusal. No lexicon with a drift read is the refusal `no-drift-read`.
 */

import { basename, resolve } from "node:path";
import { loadChantConfig } from "../../config";
import { DRIFT_READS, encodeDriftLine, type DriftLine, type DriftRead, type ReadDriftRefusalCode } from "../../drift-record";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/** The exit status of a refused read. */
export const DRIFT_REFUSED_EXIT = 3;

const USAGE = "chant lifecycle drift [--member <name>] [--read <state|plan|refresh|live-read|ownership>] [--resource <addr>]";

function refuse(code: ReadDriftRefusalCode, message: string): number {
  console.log(JSON.stringify({ refused: { code, message } }));
  return DRIFT_REFUSED_EXIT;
}

export async function runLifecycleDrift(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  const read = args.driftRead;
  if (read !== undefined && !(DRIFT_READS as readonly string[]).includes(read)) {
    console.error(formatError({ message: `--read ${read} is not a drift read; the reads are ${DRIFT_READS.join(", ")}`, hint: USAGE }));
    return 1;
  }
  const projectRoot = resolve(".");
  const { config } = await loadChantConfig(projectRoot);
  const member = args.members?.[0] ?? basename(projectRoot);
  const readers = plugins.filter((p) => typeof p.readDrift === "function");
  if (readers.length === 0) {
    return refuse("no-drift-read", `no lexicon this project declares (${plugins.map((p) => p.name).join(", ") || "none"}) has a drift read`);
  }
  const observedAt = new Date().toISOString();
  const lines: DriftLine[] = [];
  for (const plugin of readers) {
    const answer = await plugin.readDrift!({
      member,
      projectRoot,
      config: config as Record<string, unknown>,
      ...(read !== undefined ? { read: read as DriftRead } : {}),
      ...(args.resource !== undefined ? { resource: args.resource } : {}),
      observedAt,
    });
    if ("refused" in answer) return refuse(answer.refused.code, `${plugin.name}: ${answer.refused.message}`);
    lines.push(...answer.lines);
  }
  for (const line of lines) process.stdout.write(encodeDriftLine(line));
  return 0;
}
