/**
 * The one string an op run is posted as.
 *
 * `chant acp` (#2125) parses a prompt as a chant command line, so a hosted run
 * of an Op is the line a person would have typed. Two places build it — the
 * `opRuntime` provider when it posts a run (#2126) and the `Steward`
 * composite when it declares a schedule (#2127) — and a schedule whose prompt
 * differed from what the runtime posts would be a second, silently divergent
 * spelling of the same command. Hence one module, imported by both, with no
 * dependencies of its own so neither drags the other in.
 */

/**
 * The bare line one run of `op` is: what a steward's Schedule posts, and the
 * prefix a turn is matched by. The runtime posts {@link hostedRunPrompt}.
 */
export function runPrompt(op: string): string {
  return `chant run ${op}`;
}

/**
 * An `--env` value the posted command line can carry as one bare word: the
 * ACP parser splits on whitespace and reads quotes, so anything else would
 * reach the sandbox as a different argument, or as none.
 */
const PLAIN_ENV = /^[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/;

/**
 * A word the ACP tokenizer (`../acp/command-line.ts`) reads back as itself
 * with no quotes around it. Anything else is quoted by {@link quoteArg}.
 */
const PLAIN_WORD = /^[A-Za-z0-9._:@+=/,-]+$/;

/**
 * One argument as the posted command line spells it (#3539): bare when it is
 * a plain word, otherwise in double quotes with `\` and `"` escaped, which
 * is the quoting `tokenize` undoes. An approver named "Alex Smith" reaches the
 * sandbox as one `--approver` value rather than as `Alex` and a stray `Smith`.
 */
export function quoteArg(value: string): string {
  if (PLAIN_WORD.test(value)) return value;
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** What {@link hostedRunPrompt} puts on the line after `chant run <op>`. */
export interface HostedRunPromptOptions {
  /** `--env`: refused by name unless it is one plain word. */
  env?: string;
  /** `--param name=value`, one flag per entry, in order (#3539). */
  params?: Record<string, unknown>;
  /** Flags after `--on local`, as `[flag, value]`; each value is quoted as needed. */
  flags?: Array<[string, string]>;
  /** Words appended as they are, already spelled for the command line. */
  extra?: string[];
}

/**
 * The prompt a hosted run is posted as: {@link runPrompt}, then `--env <env>`
 * when the caller named one (#3232), then each `--param` (#3539), then
 * `--on local` (#3225), then any further flags.
 *
 * `--env` carries the environment the caller asked for into the sandbox,
 * where `chant acp` hands it to the run as `currentOpRun().env`. `--param`
 * rides along so the sandbox runs the line the caller typed. `--on local`
 * keeps a project's `run.on: "fountain"` from sending the posted command
 * back to fountain: the sandbox runs the Op itself. `chant acp` already runs
 * every `chant run <op>` on the local runtime; the flag makes the same true
 * for any other agent that runs the line at a shell.
 *
 * A turn still matches {@link runPrompt} by prefix (`turnRunsOp`), and a
 * steward's Schedule keeps the bare line. An `--env` value that is not one
 * plain word is refused by name rather than posted; a `--param` or flag value
 * is quoted ({@link quoteArg}).
 */
export function hostedRunPrompt(op: string, opts: HostedRunPromptOptions = {}): string {
  const parts = [runPrompt(op)];
  if (opts.env !== undefined && opts.env !== "") {
    if (!PLAIN_ENV.test(opts.env)) {
      throw new Error(
        `fountain runtime: --env "${opts.env}" cannot be posted to the steward: the prompt is a chant command line, ` +
          `so an environment name has to be one word of letters, digits and . _ : @ + = / -`,
      );
    }
    parts.push(`--env ${opts.env}`);
  }
  for (const [name, value] of Object.entries(opts.params ?? {})) {
    parts.push(`--param ${quoteArg(`${name}=${paramText(value)}`)}`);
  }
  parts.push("--on local");
  for (const [flag, value] of opts.flags ?? []) parts.push(`${flag} ${quoteArg(value)}`);
  for (const part of opts.extra ?? []) parts.push(part);
  return parts.join(" ");
}

/** A `--param` value as the command line carries it: strings as they are, anything else as JSON. */
function paramText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** The `--env` a posted prompt carries, or undefined. */
export function envOfPrompt(prompt: string | undefined): string | undefined {
  const words = (prompt ?? "").trim().split(/\s+/);
  const at = words.indexOf("--env");
  const env = at >= 0 ? words[at + 1] : undefined;
  return env && !env.startsWith("-") ? env : undefined;
}
