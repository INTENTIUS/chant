#!/usr/bin/env node
/**
 * gitlab-warden — governance reconcile CLI.
 *
 * Subcommand:
 *   reconcile   Load config, build an authed client, run selected cycles.
 *
 * Auth is a GitLab API token; the instance host defaults to gitlab.com and is
 * overridable for self-managed:
 *   --base-url <url> | --base-url-env <VAR>     GitLab instance URL (default https://gitlab.com)
 *   --token-env <VAR>                           env var holding the API token
 *
 * Exit codes: 0 success · 1 guardrail block (apply) · 2 arg/config error ·
 *             3 runtime error.
 *
 * The shell (flag grammar, config-file loading, outcome rendering, exit
 * policy) is @intentius/warden-core (#788); this file owns only what is
 * GitLab-shaped: the flag set, defaults, client, and cycle registry.
 */

import { parse as parseYaml } from "yaml";
import {
  CliError,
  type Die,
  errMsg,
  loadConfigFile,
  makeDie,
  parseFlags,
  reportReconcileOutcome,
  requireEnv,
  runWhenInvoked,
  selectCycles,
} from "@intentius/warden-core";
import { createClient } from "./auth/client.js";
import { runReconcile, type Cycle } from "./reconcile/runner.js";
import { CYCLE_REGISTRY } from "./cli/registry.js";
import type { GovernanceConfig } from "./config/types.js";
import pkg from "../package.json" with { type: "json" };

export { CliError };

/** Inlined from package.json at build time — always matches the published version. */
const VERSION: string = pkg.version;

const die: Die = makeDie("gitlab-warden");

export interface ReconcileArgs {
  config: string;
  mode: "dry-run" | "apply";
  cycles: string[];
  baseUrl: string | undefined;
  baseUrlEnv: string | undefined;
  tokenEnv: string;
  allowGuardrailOverride: boolean;
}

/** Parse reconcile argv. Pure: throws `CliError` (with exit code) on bad input. */
export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const args: ReconcileArgs = {
    config: "",
    mode: "dry-run",
    cycles: [],
    baseUrl: undefined,
    baseUrlEnv: undefined,
    tokenEnv: "GITLAB_TOKEN",
    allowGuardrailOverride: false,
  };

  parseFlags(argv, {
    "--config": { kind: "value", set: (v) => (args.config = v) },
    "--mode": {
      kind: "value",
      set: (v, flag) => {
        if (v !== "dry-run" && v !== "apply") throw new CliError(2, `${flag} must be "dry-run" or "apply", got: ${v}`);
        args.mode = v;
      },
    },
    "--cycles": { kind: "value", set: (v) => (args.cycles = v.split(",").map((s) => s.trim()).filter(Boolean)) },
    "--base-url": { kind: "value", set: (v) => (args.baseUrl = v) },
    "--base-url-env": { kind: "value", set: (v) => (args.baseUrlEnv = v) },
    "--token-env": { kind: "value", set: (v) => (args.tokenEnv = v) },
    "--allow-guardrail-override": { kind: "boolean", set: () => (args.allowGuardrailOverride = true) },
  });

  if (!args.config) throw new CliError(2, "--config is required");
  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runReconcileCommand(argv: string[]): Promise<void> {
  let args: ReconcileArgs;
  let config: GovernanceConfig;
  let cycles: Cycle[];
  let baseUrl: string | undefined;
  let token: string;
  try {
    args = parseReconcileArgs(argv);
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    throw err;
  }
  try {
    config = loadConfigFile<GovernanceConfig>(args.config, { rootKey: "nodes", parseYaml });
  } catch (err) {
    die(2, `invalid governance config "${args.config}": ${errMsg(err)}`);
  }
  try {
    baseUrl = args.baseUrl ?? (args.baseUrlEnv ? requireEnv(args.baseUrlEnv) : undefined);
    token = requireEnv(args.tokenEnv);
    cycles = selectCycles(CYCLE_REGISTRY, args.cycles);
  } catch (err) {
    die(err instanceof CliError ? err.code : 2, errMsg(err));
  }

  const client = createClient({ baseUrl, token });

  let result;
  try {
    result = await runReconcile({ config, client, cycles, mode: args.mode, allowGuardrailOverride: args.allowGuardrailOverride });
  } catch (err) {
    die(3, `reconcile failed: ${errMsg(err)}`);
  }

  process.exit(reportReconcileOutcome(result, args.mode));
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: gitlab-warden reconcile [flags]",
      "",
      "Flags:",
      "  --config <path>               Governance config (YAML or JSON). Required.",
      "  --mode dry-run|apply          Reconcile mode (default: dry-run).",
      "  --cycles <name[,name...]>     Cycles to run (default: all).",
      "  --base-url <url>              GitLab instance URL (default https://gitlab.com; or --base-url-env <VAR>).",
      "  --token-env <VAR>             Env var holding the API token (default GITLAB_TOKEN).",
      "  --allow-guardrail-override    Apply even when guardrails trip.",
      "",
      "Exit codes: 0 success · 1 guardrail block · 2 arg/config error · 3 runtime error.",
      "",
    ].join("\n"),
  );
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    process.exit(0);
  }
  if (sub === "--version" || sub === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (sub === "reconcile") {
    await runReconcileCommand(argv.slice(1));
    return;
  }
  die(2, `unknown subcommand: ${sub}. Did you mean "reconcile"?`);
}

export async function run(argv: string[]): Promise<void> {
  await main(argv);
}

runWhenInvoked(import.meta.url, "gitlab-warden", main);
