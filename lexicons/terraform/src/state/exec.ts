/**
 * The binary a state is read and written through: `state pull` and
 * `state push`. The exec is injectable, so a test runs none.
 *
 * Lifted from terragucci's `migrate.ts` (c493e0e): `Ran`, `BinaryIo`,
 * `BinaryExec`, `runBinary`, `StateFile`, `StateResource` and `pullState`.
 */
import { spawn } from "node:child_process";

export interface Ran {
  code: number;
  stdout: string;
  /** stdout and stderr together, as they came. */
  out: string;
}

/** What a run of the binary hands back while it runs: `stderr` sees each line of stderr as it arrives, and a line it takes (true) is left out of `out`. */
export interface BinaryIo {
  stderr?: (line: string) => boolean;
}

/** How the binary runs: in `dir`, with `env`. Injectable for tests. */
export type BinaryExec = (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv, io?: BinaryIo) => Promise<Ran>;

/** The binary run with `-chdir=<dir>` and `TF_IN_AUTOMATION=1`. */
export const runBinary: BinaryExec = (binary, args, dir, env, io) =>
  new Promise((done) => {
    const child = spawn(binary, [`-chdir=${dir}`, ...args], { env: { ...env, TF_IN_AUTOMATION: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let out = "";
    let partial = "";
    const stderrLine = (line: string): void => {
      let taken = false;
      try {
        taken = io!.stderr!(line);
      } catch {
        taken = false;
      }
      if (!taken) out += `${line}\n`;
    };
    child.stdout.on("data", (d) => {
      stdout += d;
      out += d;
    });
    // A line split across two chunks, a character too, is put back together before it is read.
    if (io?.stderr) child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      if (!io?.stderr) {
        out += d;
        return;
      }
      partial += d;
      const lines = partial.split("\n");
      partial = lines.pop()!;
      for (const l of lines) stderrLine(l);
    });
    const rest = (): void => {
      if (io?.stderr && partial) stderrLine(partial);
      partial = "";
    };
    child.on("error", (e) => {
      rest();
      done({ code: 127, stdout, out: `${out}${e.message}` });
    });
    child.on("close", (code) => {
      rest();
      done({ code: code ?? 1, stdout, out });
    });
  });

/** A state file as `state pull` prints it (format version 4); only what a run touches is named. */
export interface StateFile {
  version: number;
  terraform_version?: string;
  serial: number;
  lineage: string;
  outputs?: Record<string, unknown>;
  resources: StateResource[];
  check_results?: unknown;
  [k: string]: unknown;
}

export interface StateResource {
  module?: string;
  mode: string;
  type: string;
  name: string;
  provider?: string;
  instances?: unknown[];
  [k: string]: unknown;
}

/** The last lines of the binary's output, on one line, for an error. */
export const lastLines = (s: string, n = 4): string => s.trim().split("\n").slice(-n).join(" ").slice(0, 400);

/** A root's state as `state pull` gives it, or null when it has none. */
export async function pullState(exec: BinaryExec, binary: string, root: string, dir: string, env: NodeJS.ProcessEnv): Promise<StateFile | null> {
  const pulled = await exec(binary, ["state", "pull"], dir, env);
  if (pulled.code !== 0) throw new Error(`state pull in ${root} failed: ${lastLines(pulled.out)}`);
  if (!pulled.stdout.trim()) return null;
  let s: StateFile;
  try {
    s = JSON.parse(pulled.stdout) as StateFile;
  } catch {
    throw new Error(`state pull in ${root} printed something that is not a state`);
  }
  if (!Array.isArray(s.resources)) s.resources = [];
  // A backend with no state object yet prints an empty state with no lineage: that is no state.
  if (!s.lineage && !s.serial && s.resources.length === 0) return null;
  return s;
}
