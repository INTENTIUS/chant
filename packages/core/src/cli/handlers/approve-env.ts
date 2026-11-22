/**
 * `chant approve --env <env> [--plan <digest>]` with no op or gate (#5480):
 * the gate comes from `pendingApprovals`, every standing fact waiting in the
 * environment, matched to `--plan` when it is given. One fact names the op
 * and gate the approval goes to. None, or several, record nothing and list
 * what waits in the environment with each one's approve line.
 */

import { formatError, formatInfo } from "../format";
import type { CommandContext } from "../registry";
import type { PendingApproval } from "../../lifecycle/pending-approvals";

function describe(p: PendingApproval): string {
  const bound = p.digest ? ` on ${p.digest}` : "";
  const release = p.releaseDigest && p.releaseDigest !== p.digest ? ` (release ${p.releaseDigest})` : "";
  return `${p.kind} ${p.op} / ${p.gate}${bound}${release}, since ${p.timestamp}: ${p.approve.join(" ")}`;
}

/** The op and gate an environment's approval goes to, or the exit code when there is not exactly one. */
export async function resolveEnvApproval(ctx: CommandContext): Promise<{ op: string; gate: string } | number> {
  const env = ctx.args.env!;
  const plan = ctx.args.plan;
  try {
    const { requireLifecycleLedger } = await import("../../lifecycle/git");
    await requireLifecycleLedger();
  } catch (err) {
    console.error(formatError({ message: `Cannot read the gate ledgers: ${err instanceof Error ? err.message : String(err)}` }));
    return 1;
  }
  const { pendingApprovals } = await import("../../lifecycle/pending-approvals");
  const ops = ctx.args.op ? [ctx.args.op] : undefined;
  const waiting = await pendingApprovals({ env, ...(ops ? { ops } : {}) });
  const found = plan !== undefined ? await pendingApprovals({ env, plan, ...(ops ? { ops } : {}) }) : waiting;
  if (found.length === 1) {
    const one = found[0]!;
    console.error(formatInfo(`${env} waits at ${one.op} / ${one.gate} (${one.kind})${one.digest ? ` for ${one.digest}` : ""}.`));
    return { op: one.op, gate: one.gate };
  }
  if (found.length === 0) {
    const what = plan !== undefined ? `on ${plan} ` : "";
    console.error(formatError({
      message: `Nothing waits for approval ${what}in ${env}, so nothing was approved.`,
      ...(waiting.length > 0 ? { hint: `Waiting in ${env}:\n${waiting.map(describe).join("\n")}` } : {}),
    }));
    return 1;
  }
  console.error(formatError({
    message: `${found.length} approvals wait in ${env}${plan !== undefined ? ` on ${plan}` : ""}, so nothing was approved.`,
    hint: `Name one with --plan <digest>, or run its approve line:\n${found.map(describe).join("\n")}`,
  }));
  return 1;
}
