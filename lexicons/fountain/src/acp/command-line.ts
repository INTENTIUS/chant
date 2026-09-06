/**
 * A prompt is a chant command line (#2125).
 *
 * That is the whole convention, and the reason a fountain thread reads as an
 * environment's shell history: each turn is `chant run prod-apply --env prod`
 * or `chant lifecycle diff --live`, so scrolling the thread is scrolling what
 * was done to the environment.
 *
 * It is a *command line*, not a shell line. This module splits on whitespace
 * with quote awareness and stops there: no expansion, no substitution, no
 * pipes, no `&&`, no globbing, no `$VAR`. A prompt that does not parse to a
 * chant verb is refused before anything runs, which is what keeps an agent
 * that can be prompted by anyone from being an agent that can run anything.
 * The verb list is core's own registry, so the set of things this accepts is
 * exactly the set `chant --help` prints.
 */

import type { ParsedArgs, CommandDef } from "@intentius/chant/cli/registry";

/**
 * Split a command line into argv the way a shell would *quote* it, and in no
 * other way.
 *
 * Single and double quotes group, a backslash escapes the next character
 * inside double quotes and outside them, and nothing else is special. An
 * unterminated quote is an error rather than a silent join, because the
 * silent reading changes which arguments a verb receives.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let has = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === "\\" && quote !== "'" && i + 1 < text.length) {
      current += text[++i];
      has = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) tokens.push(current);
      current = "";
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }

  if (quote) throw new Error(`unterminated ${quote === '"' ? "double" : "single"} quote`);
  if (has) tokens.push(current);
  return tokens;
}

/** A prompt that resolved to something chant can run. */
export type ChantCommand =
  | {
      /** `chant run <op>` — the path that goes through the op runtime provider. */
      kind: "op-run";
      op: string;
      args: ParsedArgs;
      argv: string[];
    }
  | {
      /** Any other chant verb — run through its own registry handler. */
      kind: "verb";
      name: string;
      def: CommandDef;
      compound: boolean;
      args: ParsedArgs;
      argv: string[];
    };

/** Either a command, or the reason the prompt is not one. */
export type CommandLineParse =
  | { ok: true; command: ChantCommand }
  | { ok: false; message: string; hint: string };

/**
 * Parse one prompt into a runnable chant command, or refuse it.
 *
 * Core's registry and argv parser are imported here rather than at module
 * load: nothing about declaring the fountain lexicon should pull in every CLI
 * handler, and only a live `chant acp` turn ever reaches this.
 */
export async function parseChantCommandLine(text: string): Promise<CommandLineParse> {
  let tokens: string[];
  try {
    tokens = tokenize(text);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      hint: "A prompt is a chant command line — quote arguments that contain spaces.",
    };
  }

  if (tokens.length === 0) {
    return { ok: false, message: "the prompt was empty", hint: usageHint() };
  }

  // `chant` may lead, and usually does — it is what a person types. Stripping
  // it here means the same string works whether it was copied from a terminal
  // or typed as a bare verb.
  const argv = tokens[0] === "chant" ? tokens.slice(1) : tokens;
  if (argv.length === 0) {
    return { ok: false, message: "the prompt named no chant command", hint: usageHint() };
  }

  const { parseArgs, commandRegistry } = await import("@intentius/chant/cli/main");
  const { resolveCommand } = await import("@intentius/chant/cli/registry");

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      hint: usageHint(),
    };
  }

  const match = resolveCommand(args, commandRegistry);
  if (!match) {
    return {
      ok: false,
      message: `"${argv[0]}" is not a chant command`,
      hint: usageHint(),
    };
  }

  // `chant run <op>` is the one form that takes the provider path with a
  // progress sink. Every other `run` word — `run list`, `run status <op>` —
  // is a registered compound verb, so `resolveCommand` has already told us
  // which this is and no second list of subcommands has to be kept in step
  // with core's.
  if (args.command === "run" && !match.compound && args.path && args.path !== ".") {
    return { ok: true, command: { kind: "op-run", op: args.path, args, argv } };
  }

  return {
    ok: true,
    command: { kind: "verb", name: match.def.name, def: match.def, compound: match.compound, args, argv },
  };
}

function usageHint(): string {
  return (
    "A prompt is a chant command line, not a shell line — for example " +
    '"chant run prod-apply --env prod" or "chant lifecycle diff --live". ' +
    'Run "chant --help" for the verb list.'
  );
}
