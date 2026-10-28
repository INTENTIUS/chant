/**
 * The slim wave-job runtime (#3896): the four commands a generated Op waves
 * pipeline runs, and nothing else.
 *
 *   chant run wave --spec <file> --wave <k> [--decide | --share <i> | --record-plans | --waves-outcome]
 *   chant run resume [--gate <op>/<gate>] [--dry-run]
 *   chant approve <op> <gate> [...]
 *   chant workspace points ask|answer|list|... [...]
 *
 * `scripts/build-runtime.mjs` bundles this file with esbuild into
 * `dist/wave-runtime.mjs`: one self-contained ES module whose only imports are
 * `node:` builtins, with no TypeScript compiler, esbuild, tsx or zod in it. A
 * product copies that one file into its CI image and runs it with plain node,
 * or runs it from an installed `@intentius/chant`
 * (`node node_modules/@intentius/chant/dist/wave-runtime.mjs run wave ...`).
 *
 * The handlers are the full CLI's own (`./cli/main.ts` dispatches to the same
 * functions), parsed by the same `parseArgs`, so flags, output, exit codes and
 * the ledgers each command writes are the same. What the runtime does not do:
 * evaluate `chant.config.ts` (which needs a TypeScript loader). None of the
 * four commands reads the config; the full CLI loads it only to check `--env`
 * against the declared `environments`, a check the runtime skips.
 */

import { parseArgs } from "./cli/parse-args";
import { resolveCommand, type CommandDef, type ParsedArgs } from "./cli/registry";
import { formatError } from "./cli/format";
import { flushAndExit } from "./cli/flush";
import { CHANT_VERSION } from "./cli/version";
import { isEntryPoint } from "./cli/is-entry-point";
import { ENV_VAR } from "./env";
import { initRuntime } from "./runtime-adapter";
import { runOpWaveCommand } from "./cli/handlers/run-wave";
import { runResumeCommand } from "./cli/handlers/gate-resume";
import { runApprove } from "./cli/handlers/approve";
import { runWorkspacePoints } from "./workspace/points-cli";

/** The commands the runtime carries, under the names the full CLI registers them by. */
export const RUNTIME_COMMANDS: CommandDef[] = [
  { name: "run wave", handler: runOpWaveCommand },
  { name: "run resume", handler: runResumeCommand },
  { name: "approve", handler: runApprove },
  { name: "workspace points", handler: runWorkspacePoints },
];

const HELP = `
chant runtime ${CHANT_VERSION} - the wave-job commands of chant, in one file

Usage: node wave-runtime.mjs <command> [options]

Commands:
  run wave --spec <file> --wave <k>   Plan, gate and apply wave k of an Op waves spec
                                      (--decide, --share <i>, --record-plans, --waves-outcome, --base <ref>, --json)
  run resume                          Start the CI jobs that wait at gates whose approval arrived
                                      (--gate <op>/<gate>, --dry-run, --json)
  approve <op> <gate>                 Record a gate's resolution on the lifecycle ledger
                                      (--actor, --plan, --note, --url, --sign, --expire, --resume, ...)
  workspace points <verb>             Ask, answer and list decision points

Flags, output, exit codes and ledger formats are the full chant CLI's;
see "chant --help" in @intentius/chant for every flag. This runtime does
not evaluate chant.config.ts, so --env is not checked against the
declared environments.
`;

/** Parse, dispatch and return the exit code. Exported for tests. */
export async function runRuntime(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
  const match = resolveCommand(args, RUNTIME_COMMANDS);
  if (args.version && (!args.command || match)) {
    console.log(CHANT_VERSION);
    return 0;
  }
  if (args.help || !args.command) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }
  if (!match) {
    const name = args.path && args.path !== "." ? `${args.command} ${args.path}` : args.command;
    console.error(formatError({
      message: `"${name}" is not part of chant's wave-job runtime`,
      hint: "It runs run wave, run resume, approve and workspace points. Every other command needs the full @intentius/chant CLI.",
    }));
    return 1;
  }
  if (args.env) process.env[ENV_VAR] = args.env;
  initRuntime();
  return match.def.handler({ args, plugins: [], serializers: [] });
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  runRuntime(process.argv.slice(2)).then(flushAndExit, async (err) => {
    const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
    if (verbose && err instanceof Error && err.stack) console.error(err.stack);
    else console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    await flushAndExit(1);
  });
}
