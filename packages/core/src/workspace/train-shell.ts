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

/** How many trailing lines of a failed command's stdout and stderr a refusal prints. */
export const FAILED_OUTPUT_LINES = 60;

/** The last `n` lines of `text`, with a note of how many came before them. Empty when `text` has no content. */
export function tailLines(text: string, n = FAILED_OUTPUT_LINES): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return "";
  if (lines.length <= n) return lines.join("\n");
  return [`... (${lines.length - n} earlier lines left out)`, ...lines.slice(-n)].join("\n");
}

/** What a failed command printed, labeled with the command, for a refusal to show before its message. */
export function failedOutputBlock(label: string, line: string, out: { stdout: string; stderr: string }): string {
  const parts = [`${label}: ${line} printed:`];
  const so = tailLines(out.stdout);
  const se = tailLines(out.stderr);
  if (so) parts.push(`--- stdout ---`, so);
  if (se) parts.push(`--- stderr ---`, se);
  if (!so && !se) parts.push("(no output)");
  return parts.join("\n");
}

/** Like {@link runToStderr}, and also keeps what the line printed, so a failure can show it. */
export function runToStderrCaptured(line: string, o: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", line], { cwd: o.cwd, env: o.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      err.push(chunk);
    });
    const finish = (code: number) => done({ code, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") });
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
}
