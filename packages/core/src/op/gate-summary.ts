/**
 * The pending-gate block a CI run leaves where people actually look (#2243).
 *
 * A gated run already prints the gate, the approve command and the expiry to
 * stderr (`./local-output.ts`'s `renderHuman`). In CI that lands in a log
 * nobody opens unless the run is red, which is exactly the run this stops
 * being red. GitHub Actions, Forgejo Actions and Gitea all give a step a
 * markdown scratchpad through `GITHUB_STEP_SUMMARY`, rendered at the top of
 * the run page; anything else that sets the variable gets the same block.
 *
 * That is the whole forge coupling: one environment variable, appended to
 * when it is set, and nothing at all when it is not. No API call, no token,
 * no flag to turn it on.
 */

import { appendFileSync } from "node:fs";
import { gateLedgerPath } from "../lifecycle/gate-ledger";
import { approveCommand } from "./gate";

/** What a gated run knows about the gate it stopped on. */
export interface GatedRunSummary {
  /** The Op (or component) the gate belongs to. */
  op: string;
  /** The gate's name — the second argument to `chant approve`. */
  gate: string;
  /** The gate's authored description, when it has one. */
  description?: string;
  /** ISO-8601 instant the pending fact ages out at. */
  expiresAt?: string;
  /** The approval surface the run resolved, when it knew one. */
  url?: string;
}

/**
 * The markdown block itself. Pure, so a test reads what CI would render
 * without touching a file: op, gate, the exact `chant approve` line, and the
 * ledger path the pending fact was appended to.
 */
export function gatedRunSummaryMarkdown(summary: GatedRunSummary): string {
  const lines = [
    `### Waiting on gate \`${summary.gate}\``,
    "",
    `Op \`${summary.op}\` reached a gate nobody has approved, recorded the pending fact, and stopped. Nothing failed.`,
    "",
  ];
  if (summary.description) {
    lines.push(summary.description, "");
  }
  lines.push(
    "Approve it, then re-run this workflow:",
    "",
    "```",
    `${approveCommand(summary.op, summary.gate)} --approver <you>`,
    "```",
    "",
    `Ledger: \`${gateLedgerPath(summary.op)}\` on the \`chant/lifecycle\` branch.`,
  );
  if (summary.expiresAt) lines.push(`Expires: ${summary.expiresAt}`);
  if (summary.url) lines.push(`Approve at: ${summary.url}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Append {@link gatedRunSummaryMarkdown} to the file `GITHUB_STEP_SUMMARY`
 * names, when the variable is set and the file can be written.
 *
 * Returns the path written, or `undefined` when there was nothing to write to.
 * A write that fails is swallowed: a run that already decided its outcome must
 * not turn into a different one because a CI scratchpad was read-only.
 */
export function writeGatedRunSummary(
  summary: GatedRunSummary,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return undefined;
  try {
    appendFileSync(path, gatedRunSummaryMarkdown(summary));
    return path;
  } catch {
    return undefined;
  }
}
