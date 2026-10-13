/**
 * `chant workspace wip` (#3172, ws-085): work in progress under
 * `refs/chant/wip/<branch>`, and its replication.
 *
 *   wip [--branch <branch>] [--json]              every branch's snapshots, and where replication stands
 *   wip save [--label <text>] [--by <principal>]  snapshot the working tree, then push if the policy says so
 *   wip restore [<snapshot>] [--by <principal>]   put the working tree back as a snapshot holds it
 *   wip push                                      push what the policy names, for the host's schedule
 *   wip fetch                                     on a replacement box, bring back what was replicated
 *
 * The read prints `wip.schema.json` with `--json`; every write prints
 * `wip-write.schema.json`, with or without `--json`.
 */

import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { readerVersion } from "./declaration";
import { wipFetch, wipPush, wipRestore, wipSave, workspaceWip, WIP_CONTRACT_VERSION, WIP_WRITE_SCHEMA_ID, type WipAction, type WipDocument, type WipWriteDocument } from "./wip";
import { AGENT_ENV } from "./write-scope";

const USAGE = "chant workspace wip [--branch <branch>] [--json] | wip save [--label <text>] [--by <principal>] | wip restore [<snapshot>] [--by <principal>] | wip push | wip fetch";

const VERBS: readonly WipAction[] = ["save", "restore", "push", "fetch"];

export async function runWorkspaceWip(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = process.cwd();
  // workspace wip [<verb> [<snapshot>]]
  const [, verb, ...rest] = args.positionals ?? [];

  if (verb === undefined) {
    if (rest.length > 0 || args.label !== undefined) {
      console.error(formatError({ message: "chant workspace wip lists work in progress; save, restore, push and fetch write it", hint: USAGE }));
      return 1;
    }
    const doc = workspaceWip({ cwd, branch: args.branch });
    if (args.json || "error" in doc) {
      console.log(JSON.stringify(doc, null, 2));
      return "error" in doc ? 1 : 0;
    }
    console.log(formatWip(doc));
    return 0;
  }

  const print = (doc: WipWriteDocument): number => {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  };
  const usage = (action: WipAction | null, message: string) =>
    print({ $schema: WIP_WRITE_SCHEMA_ID, contract: WIP_CONTRACT_VERSION, chant: readerVersion(), action, error: { code: "write-usage-invalid", message } });

  if (!(VERBS as readonly string[]).includes(verb)) return usage(null, `chant workspace wip takes save, restore, push or fetch, not ${verb}: ${USAGE}`);
  const action = verb as WipAction;
  const agent = process.env[AGENT_ENV] || undefined;
  if (args.branch !== undefined) return usage(action, `wip ${action} works on the branch checked out; --branch is for listing`);
  switch (action) {
    case "save":
      if (rest.length > 0) return usage(action, `wip save takes no positional argument, and was given ${rest.join(" ")}; name the snapshot with --label`);
      return print(wipSave({ cwd, label: args.label, by: args.by, agent }));
    case "restore":
      if (rest.length > 1) return usage(action, `wip restore takes at most one snapshot, and was given ${rest.join(" ")}`);
      if (args.label !== undefined) return usage(action, "wip restore takes the snapshot's commit, not --label");
      return print(wipRestore({ cwd, snapshot: rest[0], by: args.by, agent }));
    case "push":
    case "fetch":
      if (rest.length > 0 || args.label !== undefined || args.by !== undefined) return usage(action, `wip ${action} takes no arguments: it does what the box's replicate policy says`);
      return print(action === "push" ? wipPush({ cwd }) : wipFetch({ cwd }));
  }
}

/** The text `chant workspace wip` prints without `--json`. */
export function formatWip(doc: Extract<WipDocument, { branches: unknown }>): string {
  const lines: string[] = [];
  if (doc.branches.length === 0) lines.push("No work in progress is kept under refs/chant/wip/.");
  for (const b of doc.branches) {
    const here = b.branch === doc.checkout.branch ? " (checked out)" : "";
    lines.push(`${b.branch}${here}: ${b.snapshots.length} snapshot${b.snapshots.length === 1 ? "" : "s"}`);
    for (const s of b.snapshots.slice(0, 10)) {
      const what = [s.kind === "pre-restore" ? "before a restore" : null, s.label, s.by ? `by ${s.by}` : null].filter(Boolean).join(", ");
      lines.push(`  ${s.commit.slice(0, 12)}  ${s.at}  on ${s.head.slice(0, 12)}${what ? `  ${what}` : ""}`);
    }
    if (b.snapshots.length > 10) lines.push(`  ... and ${b.snapshots.length - 10} older`);
  }
  const r = doc.replication;
  if (r === null) {
    lines.push("", "No box declares replicate, so work in progress stays on this disk.");
  } else {
    const behind = r.refs.filter((x) => !x.replicated);
    lines.push(
      "",
      `Replicated to ${r.policy.remote} (${r.policy.box}'s box: ${r.policy.refs.join(", ")}; pushes on ${r.policy.on.join(" and ") || "wip push only"}${r.policy.every ? `, and every ${r.policy.every} by the host` : ""})${r.remoteConfigured ? "" : `; this checkout has no remote named ${r.policy.remote}`}`,
    );
    if (behind.length === 0) lines.push(`  all ${r.refs.length} refs are on the remote`);
    for (const x of behind) lines.push(`  ${x.ref}: not on the remote${x.ahead > 0 ? `, ${x.ahead} commit${x.ahead === 1 ? "" : "s"} ahead` : ""}`);
  }
  return lines.join("\n");
}
