/**
 * State-lock waits for a plan or an apply (#4545): how long `plan` and
 * `apply` wait for another run's state lock before failing. Taken from
 * terragucci's waves, where two jobs of one pipeline can reach the same
 * backend a moment apart and a failed lock fails the wave for nothing.
 *
 * A job that already sets `-lock-timeout` through `TF_CLI_ARGS` or
 * `TF_CLI_ARGS_<command>` keeps its own: the flag is added only when neither
 * names one. Terragrunt waves pass the same flag after `--`
 * (`./terragrunt/wave.ts`, `extra`).
 */

/** How long a plan or an apply waits for a state lock unless the job set a `-lock-timeout` of its own. */
export const DEFAULT_LOCK_TIMEOUT = "5m";

/** A duration terraform's `-lock-timeout` takes: `0s`, `30s`, `5m`, `1h30m`. */
const DURATION = /^(\d+(ms|s|m|h))+$/;

/** Whether `value` is a `-lock-timeout` duration. */
export function isLockTimeout(value: unknown): value is string {
  return typeof value === "string" && DURATION.test(value);
}

/**
 * The `-lock-timeout` flag a `command` takes: `-lock-timeout=<timeout>`, or
 * nothing when `TF_CLI_ARGS` or `TF_CLI_ARGS_<command>` in `env` already
 * names one, or `timeout` is `false`. Throws on a duration terraform refuses.
 */
export function lockTimeoutArgs(command: "plan" | "apply", timeout: string | false = DEFAULT_LOCK_TIMEOUT, env: Record<string, string | undefined> = process.env): string[] {
  if (timeout === false) return [];
  if (!isLockTimeout(timeout)) throw new Error(`lockTimeout "${timeout}" is not a duration terraform takes, such as "5m" or "30s"`);
  const set = `${env.TF_CLI_ARGS ?? ""} ${env[`TF_CLI_ARGS_${command}`] ?? ""}`;
  return /(^|\s)-{1,2}lock-timeout[=\s]/.test(set) ? [] : [`-lock-timeout=${timeout}`];
}
