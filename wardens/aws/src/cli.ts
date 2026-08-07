#!/usr/bin/env node
/**
 * aws-warden — governance reconcile CLI for an AWS organization.
 *
 * Subcommand:
 *   reconcile   Load config, build a signed client, run selected cycles.
 *
 * Auth is standard AWS credentials from the environment (AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, region from AWS_REGION), run
 * from the organization's management account. AWS_ENDPOINT_URL points the
 * client at an emulator (floci).
 *
 * Exit codes: 0 success · 1 guardrail block (apply) · 2 arg/config error ·
 *             3 runtime error.
 *
 * The shell (flag grammar, config-file loading, outcome rendering, exit
 * policy) is @intentius/warden-core (#788); this file owns only what is
 * AWS-shaped: the flag set, credentials, and cycle registry.
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
  runWhenInvoked,
  selectCycles,
} from "@intentius/warden-core";
import { createClient, credentialsFromEnv } from "./auth/client.js";
import { runReconcile, type Cycle } from "./reconcile/runner.js";
import { CYCLE_REGISTRY } from "./cli/registry.js";
import type { AwsGovernanceConfig } from "./config/types.js";
import pkg from "../package.json" with { type: "json" };

export { CliError };

/** Inlined from package.json at build time — always matches the published version. */
const VERSION: string = pkg.version;

const die: Die = makeDie("aws-warden");

export interface ReconcileArgs {
  config: string;
  mode: "dry-run" | "apply";
  cycles: string[];
  allowGuardrailOverride: boolean;
}

/** Parse reconcile argv. Pure: throws `CliError` (with exit code) on bad input. */
export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const args: ReconcileArgs = {
    config: "",
    mode: "dry-run",
    cycles: [],
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
  let config: AwsGovernanceConfig;
  let cycles: Cycle[];
  try {
    args = parseReconcileArgs(argv);
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    throw err;
  }
  try {
    config = loadConfigFile<AwsGovernanceConfig>(args.config, { rootKey: "ous", parseYaml });
  } catch (err) {
    die(2, `invalid governance config "${args.config}": ${errMsg(err)}`);
  }
  let clientOpts;
  try {
    clientOpts = credentialsFromEnv();
    cycles = selectCycles(CYCLE_REGISTRY, args.cycles);
  } catch (err) {
    die(2, errMsg(err));
  }

  const client = createClient(clientOpts);

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
      "Usage: aws-warden reconcile [flags]",
      "",
      "Flags:",
      "  --config <path>               Governance config (YAML or JSON). Required.",
      "  --mode dry-run|apply          Reconcile mode (default: dry-run).",
      "  --cycles <name[,name...]>     Cycles to run (default: all).",
      "  --allow-guardrail-override    Apply even when guardrails trip.",
      "",
      "Auth: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN),",
      "region from AWS_REGION; AWS_ENDPOINT_URL targets an emulator. Run from",
      "the organization's management account.",
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

runWhenInvoked(import.meta.url, "aws-warden", main);
