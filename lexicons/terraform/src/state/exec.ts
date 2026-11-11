/**
 * The binary a state is read and written through: `state pull` and
 * `state push`. The exec is injectable, so a test runs none.
 *
 * Lifted from terragucci's `migrate.ts` (c493e0e): `Ran`, `BinaryIo`,
 * `BinaryExec`, `runBinary`, `StateFile`, `StateResource` and `pullState`.
 */
import { spawn } from "node:child_process";
import { FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";

export interface Ran {
  code: number;
  stdout: string;
  /** stdout and stderr together, as they came. */
  out: string;
  /** stderr alone, less the lines `io.stderr` took (chant#5007). {@link runBinary} sets it; an exec of a product's or a test's may leave it out. */
  stderr?: string;
  /** Why the binary did not run, when it could not be started: the spawn error's message (chant#5007). `code` is then 127. */
  error?: string;
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
    let stderr = "";
    let out = "";
    let partial = "";
    const stderrLine = (line: string): void => {
      let taken = false;
      try {
        taken = io!.stderr!(line);
      } catch {
        taken = false;
      }
      if (!taken) {
        out += `${line}\n`;
        stderr += `${line}\n`;
      }
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
        stderr += d;
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
      done({ code: 127, stdout, out: `${out}${e.message}`, stderr, error: e.message });
    });
    child.on("close", (code) => {
      rest();
      done({ code: code ?? 1, stdout, out, stderr });
    });
  });

/**
 * `env` without the forge's tokens, for the engine (chant#4910): the
 * providers, modules and external data sources the binary runs are the
 * change's own code, and none of it needs the forge's API. Left out: chant's
 * {@link FORGE_TOKEN_VARS}, the product's own token variables (`tokens`,
 * such as terragucci's `TG_TOKEN` and `TG_MERGE_TOKEN`), and any other
 * variable holding the same value as one of them (GitLab's `GITLAB_TOKEN`
 * set from the product's, or a variable a product's `token_env` names). A
 * variable whose name starts with `TF_` is passed as set, so a backend
 * password or a `TF_VAR_` given to the binary on purpose still reaches it.
 *
 * Lifted from terragucci's `binaryEnv` (binary-env.ts).
 */
export function engineEnv(env: NodeJS.ProcessEnv, tokens: readonly string[] = []): NodeJS.ProcessEnv {
  const names = new Set<string>([...FORGE_TOKEN_VARS, ...tokens]);
  const secrets = new Set([...names].map((n) => env[n]).filter((v): v is string => typeof v === "string" && v.length > 0));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (names.has(k)) continue;
    if (v !== undefined && secrets.has(v) && !k.startsWith("TF_")) continue;
    out[k] = v;
  }
  return out;
}

/**
 * {@link runBinary} with the forge's tokens left out of the binary's
 * environment ({@link engineEnv}), `tokens` naming the product's own
 * (chant#4910). A product that ran the binary through its own wrapper over
 * `runBinary` passes this one wherever a `BinaryExec` is taken. `runBinary`
 * itself still passes the environment as given, since a project's provider
 * may read a forge token on purpose (the GitHub provider reads `GITHUB_TOKEN`).
 */
export function tokenlessBinaryExec(tokens: readonly string[] = [], exec: BinaryExec = runBinary): BinaryExec {
  return (binary, args, dir, env, io) => exec(binary, args, dir, engineEnv(env, tokens), io);
}

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
