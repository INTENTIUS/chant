/**
 * `chant workspace verify [--base <rev>] [--head <rev>] [--require attested] [--json]`
 * (#2547): check a change against the trust policy at its base. See ./verify.ts.
 *
 * Exit 0 when the change passes, 1 when it does not or cannot be checked.
 */

import { formatError, formatSuccess } from "../../cli/format";
import type { CommandContext } from "../../cli/registry";
import { gitRoot } from "../record-source";
import { activeAttestors } from "./attestor";
import { verifyChange, type ChangeReport } from "./verify";

const USAGE = "chant workspace verify [--base <rev>] [--head <rev>] [--require attested] [--json]";

export async function runWorkspaceVerify(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.require !== undefined && args.require !== "attested") {
    console.error(formatError({ message: `--require takes one level, attested, not ${JSON.stringify(args.require)}`, hint: USAGE }));
    return 1;
  }
  const repo = gitRoot(process.cwd());
  if (!repo) {
    console.error(formatError({ message: "chant workspace verify checks git commits, and this directory is not in a git repository", hint: USAGE }));
    return 1;
  }
  const report = verifyChange({
    repo,
    base: args.base,
    head: args.head,
    require: args.require === "attested" ? "attested" : undefined,
    attestors: await activeAttestors(),
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return report.ok ? 0 : 1;
}

function printReport(r: ChangeReport): void {
  const lines: string[] = [];
  if (r.base) lines.push(`base ${r.base.slice(0, 8)} (${r.baseFrom})${r.head ? `, head ${r.head.slice(0, 8)}` : ""}`);
  if (r.policy.active) {
    lines.push(`policy at base: ${r.policy.principals.length} signers in ${r.policy.signersPath}; policy writers: ${r.policy.writers.join(", ") || "none"}`);
    for (const e of r.policy.excluded) lines.push(`  ${r.policy.signersPath}:${e.line} not used: ${e.reason}`);
  }
  for (const c of r.commits) {
    const who = c.principal ? ` by ${c.principal}` : "";
    const note = c.skipped ? ` (${c.skipped})` : c.level === "attested" ? "" : ` (${c.reason})`;
    lines.push(`  ${c.commit.slice(0, 8)}  ${c.level}${who}  ${c.subject}${note}`);
  }
  for (const w of r.protectedWrites) lines.push(`  protected write ${w.commit.slice(0, 8)} ${w.paths.join(", ")}: ${w.allowed ? "allowed" : "refused"}, ${w.reason}`);
  for (const n of r.notes) lines.push(n);
  console.log(lines.join("\n"));
  if (r.ok) console.log(formatSuccess(`verified ${r.commits.length} commits against the policy at base`));
  else console.error(formatError({ message: `verification failed:\n${r.failures.map((f) => `  ${f}`).join("\n")}`, hint: USAGE }));
}
