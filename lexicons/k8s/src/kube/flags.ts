/**
 * Flag parsing shared by every `chant kube <verb>` (chant #1079).
 *
 * `CommandGroupContext.rawArgs` is unparsed argv — core has no vocabulary for
 * a lexicon's own verbs (chant #1078) — so every verb here does its own
 * parsing, reusing `splitJoinedFlags`/`unknownFlagError` for the same
 * `--flag=value` splitting and rejection discipline core's own parser
 * applies (chant #1127). This module adds the flag vocabulary every verb
 * shares (namespace, selector, output, cluster targeting) so each verb file
 * only has to declare what is actually its own (`--tail`, `--for`, ...).
 */

import { splitJoinedFlags, unknownFlagError } from "@intentius/chant/cli/command-group";
import type { ConnectOptions } from "../api/connect";

/** A verb's own flag vocabulary, merged with the common set below. */
export interface FlagSpec {
  /** Value flags this verb accepts, alias → canonical key (e.g. `{ "--tail": "tail" }`). */
  value?: Record<string, string>;
  /** Boolean flags this verb accepts, alias → canonical key. */
  boolean?: Record<string, string>;
}

/** Every `chant kube` verb accepts these — kubectl's own names. */
const COMMON_VALUE: Record<string, string> = {
  "-n": "namespace",
  "--namespace": "namespace",
  "-l": "selector",
  "--selector": "selector",
  "-o": "output",
  "--output": "output",
  "--context": "context",
  "--env": "env",
  "--kubeconfig": "kubeconfig",
};

const COMMON_BOOLEAN: Record<string, string> = {
  "-A": "allNamespaces",
  "--all-namespaces": "allNamespaces",
};

export interface ParsedFlags {
  /** Non-flag tokens, in order — the verb's own positional arguments (kind, name, ...). */
  positional: string[];
  /** Resolved value-flag key → the value given. */
  values: Record<string, string>;
  /** Resolved boolean-flag key → true (absent keys are false). */
  flags: Record<string, boolean>;
}

/**
 * Parse `rawArgs` against the common flag set plus `spec`. Throws
 * {@link unknownFlagError}'s shape on anything starting with `-` that
 * neither set recognizes, and on a value flag given with nothing after it.
 */
export function parseKubeFlags(rawArgs: string[], spec: FlagSpec = {}): ParsedFlags {
  const valueFlags: Record<string, string> = { ...COMMON_VALUE, ...(spec.value ?? {}) };
  const booleanFlags: Record<string, string> = { ...COMMON_BOOLEAN, ...(spec.boolean ?? {}) };
  const args = splitJoinedFlags(rawArgs, new Set(Object.keys(booleanFlags)));

  const positional: string[] = [];
  const values: Record<string, string> = {};
  const flags: Record<string, boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg in booleanFlags) {
      flags[booleanFlags[arg]] = true;
      continue;
    }
    if (arg in valueFlags) {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      values[valueFlags[arg]] = value;
      continue;
    }
    throw unknownFlagError(arg);
  }

  return { positional, values, flags };
}

/** Build the typed client's `ConnectOptions` from a parsed common flag set. */
export function connectOptionsFrom(values: Record<string, string>): ConnectOptions {
  const options: ConnectOptions = {};
  if (values.env !== undefined) options.environment = values.env;
  if (values.context !== undefined) options.context = values.context;
  if (values.kubeconfig !== undefined) options.client = { kubeconfigPath: values.kubeconfig };
  return options;
}

/** kubectl duration shorthand: "3600" (bare seconds), "1h", "90m", "45s". Shared by `logs --since` and `wait --timeout`. */
export function parseDurationSeconds(value: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(value.trim());
  if (!match) throw new Error(`expected a duration like "1h", "90m", "45s", or a bare second count, got "${value}"`);
  const n = Number(match[1]);
  switch (match[2]) {
    case "h":
      return n * 3600;
    case "m":
      return n * 60;
    default:
      return n;
  }
}

/** {@link parseDurationSeconds} in milliseconds. */
export function parseDurationMs(value: string): number {
  return parseDurationSeconds(value) * 1000;
}
