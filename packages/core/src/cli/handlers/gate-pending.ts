/**
 * `chant run pending --plan <digest> [--op <op>] [--json]` (#4607): the
 * standing pending gates waiting on a plan digest, with the pull request a
 * pull request gate belongs to. A product's approve verb runs it (or calls
 * `pendingGatesByPlan` from `@intentius/chant/ci-product`) to find the op and
 * gate a digest waits at, so a person types the digest the note showed and
 * nothing else.
 */

import type { CommandContext } from "../registry";
import { formatError, formatInfo } from "../format";
import { requireLifecycleLedger } from "../../lifecycle/git";
import { pendingGatesByPlan, type PendingGateByPlan } from "../../lifecycle/gate-pending-by-plan";

function describe(g: PendingGateByPlan): string {
  const where = g.pr !== undefined ? ` (pull request ${g.pr}${g.member ? `, member ${g.member}` : ""})` : "";
  const env = g.environment ? ` in ${g.environment}` : "";
  const by = g.matched === "changeSet" ? " by its change set" : "";
  return `${g.op} / ${g.gate}${env}${where} waits on this plan${by}, since ${g.timestamp}, until ${g.expiresAt}`;
}

export async function runPendingCommand(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const digest = args.plan;
  if (!digest) {
    console.error(formatError({ message: "chant run pending needs the digest a plan printed: --plan <digest>" }));
    return 1;
  }
  try {
    await requireLifecycleLedger();
  } catch (err) {
    console.error(formatError({ message: `Cannot read the gate ledgers: ${err instanceof Error ? err.message : String(err)}` }));
    return 1;
  }
  const gates = await pendingGatesByPlan(digest, args.op ? { op: args.op } : {});
  if (args.json) {
    console.log(JSON.stringify({ plan: digest, gates }, null, 2));
    return 0;
  }
  if (gates.length === 0) {
    console.error(formatInfo(`No gate is waiting on ${digest}: it was approved, it expired, or no run reached a gate with it.`));
    return 0;
  }
  for (const g of gates) console.error(formatInfo(describe(g)));
  return 0;
}
