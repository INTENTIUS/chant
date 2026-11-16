/**
 * The shell lines a train command runs for its user: `release.train.check`
 * in `train cut`, and the builds of `train prepare`. Their stdout goes to
 * this process's stderr, as `release.verify`'s does, so stdout carries only
 * what the command prints itself, and under `--json` that is one JSON
 * document a step can parse.
 */
import { spawn } from "node:child_process";

/** Runs `line` with `sh -c` and returns its exit code; its stdout and stderr both reach this process's stderr. */
export function runToStderr(line: string, o: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", line], { cwd: o.cwd, env: o.env ?? process.env, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", () => done(1));
    child.on("close", (code) => done(code ?? 1));
  });
}
