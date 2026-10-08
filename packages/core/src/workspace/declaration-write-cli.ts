/**
 * `chant workspace member add <name> --from <file|->`, `chant workspace
 * member remove <name>` and `chant workspace host set <name> --from
 * <file|->` (#3596): the command lines of `declaration-write.ts`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandContext } from "../cli/registry";
import { readerVersion } from "./declaration";
import {
  DECLARATION_WRITE_CONTRACT_VERSION,
  DECLARATION_WRITE_SCHEMA_ID,
  declarationWrite,
  type DeclarationWriteAction,
  type DeclarationWriteDocument,
} from "./declaration-write";
import { AGENT_ENV } from "./write-scope";

const USAGE: Record<DeclarationWriteAction, string> = {
  "member add": "chant workspace member add <name> --from <file|-> [--by <principal>] [--dry-run] [--json]",
  "member remove": "chant workspace member remove <name> [--by <principal>] [--dry-run] [--json]",
  "host set": "chant workspace host set <name> --from <file|-> [--by <principal>] [--dry-run] [--json]",
};

const print = (doc: DeclarationWriteDocument): number => {
  console.log(JSON.stringify(doc, null, 2));
  return "error" in doc ? 1 : 0;
};

/** `chant workspace member add|remove <name>`. */
export function runWorkspaceMember(ctx: CommandContext): number {
  const [, verb, ...rest] = ctx.args.positionals ?? [];
  const action = verb === "add" ? "member add" : verb === "remove" ? "member remove" : null;
  if (action === null) return usage("member add", rest[0], `chant workspace member takes add <name> or remove <name>${verb === undefined ? "" : `, not ${verb}`}`);
  return run(ctx, action, rest);
}

/** `chant workspace host set <name>`. */
export function runWorkspaceHost(ctx: CommandContext): number {
  const [, verb, ...rest] = ctx.args.positionals ?? [];
  if (verb !== "set") return usage("host set", rest[0], `chant workspace host takes set <name>${verb === undefined ? "" : `, not ${verb}`}`);
  return run(ctx, "host set", rest);
}

function usage(action: DeclarationWriteAction, name: string | undefined, message: string): number {
  return print({
    $schema: DECLARATION_WRITE_SCHEMA_ID,
    contract: DECLARATION_WRITE_CONTRACT_VERSION,
    chant: readerVersion(),
    action,
    name: name ?? null,
    error: { code: "write-usage-invalid", message: `${message}; ${USAGE[action]}` },
  });
}

function run(ctx: CommandContext, action: DeclarationWriteAction, rest: string[]): number {
  const { args } = ctx;
  const cwd = process.cwd();
  const [name, ...extra] = rest;
  if (name === undefined) return usage(action, undefined, `${action} needs a name`);
  if (extra.length > 0) return usage(action, name, `${action} takes one name, and was also given ${extra.join(" ")}`);
  for (const [flag, v] of [["--set", args.set], ["--kind", args.kind], ["--at", args.at], ["--cover", args.cover]] as const) {
    if (v !== undefined) return usage(action, name, `${action} takes no ${flag}`);
  }
  let entry: string | undefined;
  if (args.migrateFrom !== undefined) {
    try {
      entry = readFileSync(args.migrateFrom === "-" ? 0 : resolve(cwd, args.migrateFrom), "utf-8");
    } catch (err) {
      return print({
        $schema: DECLARATION_WRITE_SCHEMA_ID,
        contract: DECLARATION_WRITE_CONTRACT_VERSION,
        chant: readerVersion(),
        action,
        name,
        error: { code: "write-input-invalid", message: `--from ${args.migrateFrom} could not be read: ${err instanceof Error ? err.message : String(err)}` },
      });
    }
  }
  return print(declarationWrite({ cwd, action, name, entry, by: args.by, agent: process.env[AGENT_ENV] || undefined, dryRun: args.dryRun === true }));
}
