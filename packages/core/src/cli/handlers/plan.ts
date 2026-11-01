/**
 * `chant plan stale <digest> [--member <name>] [--json]` (#4648): whether
 * anything applied to a plan's targets after the plan was recorded, and
 * which applies. The rule is `../../lifecycle/plan-stale.ts`; the ledgers
 * are read as `chant ledger` reads them (`./query.ts` {@link queryLedgers}),
 * from the local `chant/lifecycle` branch. It never fetches and never writes,
 * so a platform can call it before it asks a person to approve. Exit 0 when
 * the plan is current, 2 when it is stale, 1 when no pending gate fact
 * records the digest or the ledger can't be read.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { formatError } from "../format";
import type { CommandContext } from "../registry";
import type { PlanStaleDocument } from "../../lifecycle/plan-stale";
import { queryLedgers } from "./query";

const USAGE = "chant plan stale <digest> [--member <name>] [--json]";

/** The `plan-stale` document for `digest`, read from the ledgers at `cwd`: every member's, or the ones `members` names. */
export async function planStaleDocument(req: { cwd: string; digest: string; members?: readonly string[] }): Promise<PlanStaleDocument> {
  const { planStaleness, planStaleHead } = await import("../../lifecycle/plan-stale");
  const { readerVersion } = await import("../../workspace/declaration");
  const head = planStaleHead(readerVersion());
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: req.cwd, stdio: "ignore" });
  } catch {
    return { ...head, error: { code: "not-a-git-repository", message: "plans are read from the chant/lifecycle branch, and this directory is not in a git repository" } };
  }
  const { loadQueryData } = await import("../../lifecycle/query");
  try {
    // No snapshot is read: an empty snapshot port stands in, so the snapshot files on the branch are skipped too.
    const none = { read: async () => null, list: async () => [], trees: async () => [] };
    const ledgers = (await queryLedgers(req.cwd, req.members)).map((l) => ({ ...l, snapshots: none }));
    return planStaleness((await loadQueryData(ledgers)).data, req.digest, readerVersion());
  } catch (err) {
    return { ...head, error: { code: "ledger-unreadable", message: `reading the ledger failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

export async function runPlanStale(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const digest = args.extraPositional;
  if (!digest || digest.startsWith("-")) {
    console.error(formatError({ message: "plan stale needs the plan digest a gate's pending fact records", hint: USAGE }));
    return 1;
  }
  const doc = await planStaleDocument({ cwd: resolve("."), digest, members: args.members });
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc || doc.plan === null ? 1 : doc.stale ? 2 : 0;
  }
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
    return 1;
  }
  if (doc.plan === null) {
    console.error(formatError({ message: `no pending gate fact records the plan ${digest}`, hint: "Fetch chant/lifecycle first if the run that made the plan ran elsewhere: git fetch origin chant/lifecycle:chant/lifecycle" }));
    return 1;
  }
  const where = doc.plan.targets.map((t) => `${t.member ? `${t.member}/` : ""}${t.op} at ${t.gate}${t.environment ? ` in ${t.environment}` : ""}`).join(", ");
  console.log(`Plan ${digest}, recorded ${doc.plan.recordedAt} for ${where}.`);
  if (!doc.stale) {
    console.log("Nothing has applied to its targets since.");
    return 0;
  }
  console.log(`Stale: ${doc.applies.length} ${doc.applies.length === 1 ? "apply" : "applies"} since.`);
  for (const a of doc.applies) {
    const what = a.source === "deploys" ? `deploy of ${a.component} to ${a.environment}` : `apply under ${a.op}/${a.gate} of ${a.planDigest}`;
    const who = [a.actor ? `by ${a.actor}` : null, a.approvedBy ? `approved by ${a.approvedBy}` : null, a.runId ? `run ${a.runId}` : null].filter(Boolean).join(", ");
    console.log(`  ${a.at}  ${what}${who ? ` (${who})` : ""}${a.result ? `: ${a.result}` : ""}`);
  }
  return 2;
}
