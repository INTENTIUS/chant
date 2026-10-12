/**
 * `chant approve policy-override <subject> --rule <id>... --reason <text>`
 * (#3760): record a person's override of the denial a run recorded for
 * `subject`. The override is an approval of the denial's override digest
 * (`../../override-gate.ts`), with the reason as its note, written by the
 * same `recordGateApproval` every `chant approve` uses, so `--sign`,
 * `--actor`, `--relayed-by` and `--url` work as they do there.
 *
 * It names the rules it overrides, which must be exactly the rules the denial
 * recorded: the approver says what they are letting through. Whether the
 * override counts is decided by the run, against the overriders and signers
 * at base; this command only warns when the checkout's own overriders file
 * would not count it. A product that keeps its overriders in its own config
 * sets `CHANT_OVERRIDERS_FROM` (to where it reads them, e.g. `policy.override
 * in terragucci.config.ts`), and the checkout check is skipped (#3824).
 */

import { currentGateOrigin, isModelAuthored } from "../../lifecycle/gate-origin";
import { requireLifecycleLedger } from "../../lifecycle/git";
import { readOverrideLedger } from "../../lifecycle/override-ledger";
import { samePlanDigest } from "../../lifecycle/plan-digest";
import { OVERRIDE_OP, OVERRIDERS_PATH, overrideCommand, overridersAt, recordedDenials, sortedRules } from "../../override-gate";
import { formatError, formatInfo, formatWarning } from "../format";
import type { CommandContext } from "../registry";
import { recordGateApproval } from "./approve";

const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

export async function runOverrideApprove(ctx: CommandContext): Promise<number> {
  const subject = ctx.args.extraPositional!;
  const usage = overrideCommand(subject, ctx.args.rules?.length ? ctx.args.rules : ["<id>"]);
  if (ctx.args.reason !== undefined && ctx.args.note !== undefined && ctx.args.reason.trim() !== ctx.args.note.trim()) {
    console.error(formatError({ message: "Give the override's reason once: --reason <text> (--note is the same field)", hint: usage }));
    return 1;
  }
  const reason = (ctx.args.reason ?? ctx.args.note)?.trim();
  const rules = sortedRules(ctx.args.rules ?? []);
  if (rules.length === 0) {
    console.error(formatError({ message: `An override names each rule it overrides with --rule <id>`, hint: usage }));
    return 1;
  }
  if (!reason) {
    console.error(formatError({ message: `An override needs --reason <text>: why this plan goes out although the policy denies it`, hint: usage }));
    return 1;
  }
  if (ctx.args.agent || isModelAuthored(currentGateOrigin())) {
    console.error(formatError({ message: `An override is a person's: it is never recorded by an agent or over MCP or ACP`, hint: `${usage}, at a shell.` }));
    return 1;
  }

  try {
    await requireLifecycleLedger();
  } catch (err) {
    console.error(formatError({ message: `Cannot record the override: ${err instanceof Error ? err.message : String(err)}` }));
    return 1;
  }
  const ledger = await readOverrideLedger();
  const denials = recordedDenials(ledger.pending);
  const denial = denials.find((d) => d.gate === subject);
  if (!denial) {
    console.error(formatError({
      message: `No denial of ${subject} is recorded on ${OVERRIDE_OP}` + (denials.length ? `; denied: ${denials.map((d) => d.gate).join(", ")}` : ""),
      hint: "A run records one when its policy denies the plan. An override answers that denial, for that plan.",
    }));
    return 1;
  }
  if (denial.rules.join("\n") !== rules.join("\n")) {
    console.error(formatError({
      message: `${subject} was denied by ${denial.rules.join(", ") || "no rule it named"}; an override names exactly those rules, and --rule gave ${rules.join(", ")}`,
      hint: overrideCommand(subject, denial.rules),
    }));
    return 1;
  }
  if (ctx.args.plan !== undefined && !samePlanDigest(ctx.args.plan, denial.plan) && !samePlanDigest(ctx.args.plan, denial.planDigest)) {
    console.error(formatError({
      message: `--plan ${ctx.args.plan} is not the plan denied for ${subject}: the newest denial is of ${denial.plan || denial.planDigest}`,
      hint: "Run the plan again, or override the denial that stands.",
    }));
    return 1;
  }

  const outcome = await recordGateApproval(OVERRIDE_OP, subject, {
    actor: ctx.args.approver ?? ctx.args.actor,
    note: reason,
    url: ctx.args.url,
    plan: denial.planDigest!,
    allowSameOrigin: ctx.args.allowSameOrigin,
    ...(ctx.args.roles ? { roles: ctx.args.roles } : {}),
    ...(ctx.args.sign !== undefined ? { sign: ctx.args.sign } : {}),
    ...(ctx.args.relayedBy !== undefined ? { relayedBy: ctx.args.relayedBy } : {}),
  });
  if (!outcome.ok) return 1;

  console.error(formatInfo(
    `This overrides the denial of ${subject} by ${rules.join(", ")} for the plan ${denial.plan || denial.planDigest}. ` +
      `The next run that plans it applies it once; a plan that moves, or rules that change, need their own override.`,
  ));
  const from = process.env.CHANT_OVERRIDERS_FROM?.trim();
  if (from) return 0;
  const here = overridersAt(process.cwd(), "HEAD");
  if (!here.active) {
    console.error(formatWarning({ message: `This checkout has no ${OVERRIDERS_PATH}: unless the run reads its overriders from elsewhere at base, no override counts (a tool that does sets CHANT_OVERRIDERS_FROM to say so)` }));
  } else if (!here.principals.map(norm).includes(norm(outcome.record.resolvedBy))) {
    console.error(formatWarning({ message: `${outcome.record.resolvedBy} is not in ${OVERRIDERS_PATH} here (${here.principals.join(", ") || "nobody"}), so a run that reads it at base does not count this override` }));
  }
  return 0;
}
