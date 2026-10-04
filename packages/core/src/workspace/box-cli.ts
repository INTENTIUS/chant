/**
 * `chant workspace box`: a member's box block. Two verbs:
 *
 * - `box listing set <member>` (#3308) changes the box's listing
 *   (`box-listing.ts`). A box's other configuration is changed by editing the
 *   declaration in a reviewed change.
 * - `box publish <member> <item> | --records` (#3165, ws-088) runs the
 *   publisher the box block names and checks what it did (`box-publish.ts`).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { BOX_LISTING_CONTRACT_VERSION, BOX_LISTING_WRITE_SCHEMA_ID, boxListingSet, type BoxListingWriteDocument } from "./box-listing";
import { BOX_PUBLISH_CONTRACT_VERSION, BOX_PUBLISH_SCHEMA_ID, boxPublish, type BoxPublishDocument } from "./box-publish";
import { readerVersion } from "./declaration";
import { AGENT_ENV } from "./write-scope";

const USAGE = "chant workspace box listing set <member> [--from <file|->] [--cover <image> [--cover-path <path>]] [--by <principal>] [--dry-run] [--json]";
const PUBLISH_USAGE = "chant workspace box publish <member> (<item> | --records) [--by <principal>] [--head <owner/name>] [--dry-run] [--json]";

export async function runWorkspaceBox(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = process.cwd();
  // workspace box <noun> <verb> <member>, or workspace box publish <member> [<item>]
  const [, noun, verb, member, ...extra] = args.positionals ?? [];
  // For publish, the third positional is the member and the fourth the item.
  if (noun === "publish") return runPublish(ctx, verb, member === undefined ? [] : [member, ...extra]);
  if (noun !== "listing" || verb !== "set") {
    console.error(
      formatError({
        message: noun === undefined ? "chant workspace box takes listing set <member> or publish <member>" : `chant workspace box takes listing set <member> or publish <member>, not ${[noun, verb].filter(Boolean).join(" ")}`,
        hint: `${USAGE}\n${PUBLISH_USAGE}`,
      }),
    );
    return 1;
  }
  const print = (doc: BoxListingWriteDocument): number => {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  };
  const usage = (message: string) =>
    print({ $schema: BOX_LISTING_WRITE_SCHEMA_ID, contract: BOX_LISTING_CONTRACT_VERSION, chant: readerVersion(), member: member ?? null, error: { code: "write-usage-invalid", message } });
  if (member === undefined) return usage("box listing set needs the member whose box it lists: box listing set <member>");
  if (extra.length > 0) return usage(`box listing set takes one member, and was also given ${extra.join(" ")}`);
  for (const [flag, v] of [["--set", args.set], ["--kind", args.kind], ["--at", args.at]] as const) {
    if (v !== undefined) return usage(`box listing set takes its fields with --from, not ${flag}`);
  }
  let fields: string | undefined;
  if (args.migrateFrom !== undefined) {
    try {
      fields = readFileSync(args.migrateFrom === "-" ? 0 : resolve(cwd, args.migrateFrom), "utf-8");
    } catch (err) {
      return print({
        $schema: BOX_LISTING_WRITE_SCHEMA_ID,
        contract: BOX_LISTING_CONTRACT_VERSION,
        chant: readerVersion(),
        member,
        error: { code: "write-input-invalid", message: `--from ${args.migrateFrom} could not be read: ${err instanceof Error ? err.message : String(err)}` },
      });
    }
  }
  return print(
    boxListingSet({
      cwd,
      member,
      fields,
      cover: args.cover,
      coverPath: args.coverPath,
      by: args.by,
      agent: process.env[AGENT_ENV] || undefined,
      dryRun: args.dryRun === true,
    }),
  );
}

/** `box publish <member> <item>` or `box publish <member> --records`. */
function runPublish(ctx: CommandContext, member: string | undefined, rest: string[]): number {
  const { args } = ctx;
  const [item, ...extra] = rest;
  const print = (doc: BoxPublishDocument): number => {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  };
  const usage = (message: string) =>
    print({
      $schema: BOX_PUBLISH_SCHEMA_ID,
      contract: BOX_PUBLISH_CONTRACT_VERSION,
      chant: readerVersion(),
      member: member ?? null,
      action: args.records ? "records" : "item",
      item: item ?? null,
      error: { code: "write-usage-invalid", message: `${message}; ${PUBLISH_USAGE}` },
    });
  if (member === undefined) return usage("box publish needs the member whose box publishes");
  if (extra.length > 0) return usage(`box publish takes one work item, and was also given ${extra.join(" ")}`);
  for (const [flag, v] of [["--from", args.migrateFrom], ["--set", args.set], ["--kind", args.kind], ["--at", args.at], ["--cover", args.cover]] as const) {
    if (v !== undefined) return usage(`box publish takes no ${flag}`);
  }
  return print(
    boxPublish({
      cwd: process.cwd(),
      member,
      item,
      records: args.records === true,
      by: args.by,
      head: args.head,
      dryRun: args.dryRun === true,
      agent: process.env[AGENT_ENV] || undefined,
    }),
  );
}
