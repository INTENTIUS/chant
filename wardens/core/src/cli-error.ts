/**
 * CLI error with an exit code, thrown by pure parsing/validation helpers so
 * the shell can turn it into a `die()` at the edge.
 *
 * Exit-code convention shared by every warden:
 *   0 success · 1 guardrail block (apply) · 2 arg/config error · 3 runtime error.
 */
export class CliError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}
