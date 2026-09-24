/**
 * `chant workspace member-run` (#2537): the one process a toolchain runs for
 * `chant workspace build|lint|audit|graph`.
 *
 * `member-commands.ts` groups the members by the chant each one resolves
 * (#2524 D3, "one process per toolchain identity") and spawns that chant's
 * `workspace member-run` once per group. The request arrives as JSON on
 * stdin: the level-0 command line for each member, and the member's
 * directory. This process runs them one after another, in-process, from
 * inside each directory, so every member gets what `chant <verb> .` would
 * print there. It answers on stdout with one {@link PROTOCOL_PREFIX} line per
 * member, after a header line naming the protocol and this chant's version.
 *
 * A chant older than this command has no header to print. The caller sees
 * that and falls back to one level-0 process per member.
 *
 * Internal: not listed in `chant --help`, and the protocol may change with
 * the caller, which is always a chant of the same or a newer release.
 */

import { ENV_VAR } from "../env";
import type { CommandContext } from "../cli/registry";
import { readerVersion } from "./declaration";

/** Marks the lines of this protocol on stdout; anything else there is stray output. */
export const PROTOCOL_PREFIX = "@@chant-member-run@@ ";
export const MEMBER_RUN_PROTOCOL = 1;

export interface MemberRunRequest {
  protocol: number;
  units: MemberRunUnit[];
}

export interface MemberRunUnit {
  /** Echoed back on the answer line. */
  id: string;
  /** The member's directory, absolute. The command runs from inside it. */
  dir: string;
  /** The level-0 command line, such as `["lint", ".", "--format", "sarif"]`. */
  argv: string[];
  /**
   * Directories (relative to `dir`) to leave out of discovery. Set for member
   * `.`, whose project is the root minus every other member. Kept in the
   * protocol for a member-run from before #2527, which applied it itself;
   * from #2527 on, discovery reads the same set from the declaration.
   */
  exclude?: string[];
}

export type MemberRunLine =
  | { type: "header"; protocol: number; chant: string }
  | { type: "result"; id: string; exitCode: number; stdout: string; stderr: string };

/** A `process.exit` inside a command, turned into a value. */
class ExitRequest extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

type Write = typeof process.stdout.write;

/**
 * Run `fn` with stdout, stderr and `process.exit` captured. Commands print
 * through `console`, which writes through the stream's `write` at call time,
 * so replacing `write` catches everything they print.
 */
export async function captureRun(fn: () => Promise<number>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const sink =
    (into: string[]): Write =>
    ((chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) => {
      into.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      const done = typeof encoding === "function" ? encoding : cb;
      if (typeof done === "function") (done as () => void)();
      return true;
    }) as Write;
  const saved = { out: process.stdout.write, err: process.stderr.write, exit: process.exit };
  process.stdout.write = sink(out);
  process.stderr.write = sink(err);
  process.exit = ((code?: number) => {
    throw new ExitRequest(typeof code === "number" ? code : 0);
  }) as typeof process.exit;
  let exitCode: number;
  try {
    exitCode = await fn();
  } catch (e) {
    if (e instanceof ExitRequest) {
      exitCode = e.code;
    } else {
      err.push(`${e instanceof Error ? e.message : String(e)}\n`);
      exitCode = 1;
    }
  } finally {
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
    process.exit = saved.exit;
  }
  return { exitCode, stdout: out.join(""), stderr: err.join("") };
}

function emit(line: MemberRunLine): void {
  process.stdout.write(`${PROTOCOL_PREFIX}${JSON.stringify(line)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Run each unit of `request` in turn, answering on stdout. */
export async function runMemberUnits(request: MemberRunRequest, run: (argv: string[]) => Promise<number>): Promise<number> {
  emit({ type: "header", protocol: MEMBER_RUN_PROTOCOL, chant: readerVersion() });
  const startDir = process.cwd();
  const startEnv = process.env[ENV_VAR];
  for (const unit of request.units) {
    const result = await captureRun(async () => {
      process.chdir(unit.dir);
      // `unit.exclude` needs no action here: discovery reads the declaration
      // itself and leaves member `.`'s exclusions out of every walk (#2527).
      return run(unit.argv);
    });
    if (startEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = startEnv;
    process.chdir(startDir);
    emit({ type: "result", id: unit.id, ...result });
  }
  return 0;
}

export async function runWorkspaceMemberRun(_ctx: CommandContext, run: (argv: string[]) => Promise<number>): Promise<number> {
  let request: MemberRunRequest;
  try {
    request = JSON.parse(await readStdin()) as MemberRunRequest;
  } catch (err) {
    console.error(`chant workspace member-run: the request on stdin is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (request.protocol !== MEMBER_RUN_PROTOCOL || !Array.isArray(request.units)) {
    console.error(`chant workspace member-run: this chant speaks protocol ${MEMBER_RUN_PROTOCOL}, and the request asks for ${String(request.protocol)}`);
    return 1;
  }
  return runMemberUnits(request, run);
}
