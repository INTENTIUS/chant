/**
 * Cloud identities on scheduled Op jobs (#4631), as op waves have them
 * (#4332, #4549): what the github, forgejo and gitlab Op generators share.
 *
 * A scheduled Op with `cloud` trades its job's OIDC token for those
 * identities before the checkout, and every later step drops the variables
 * a token is requested with. A drift Op with `update` gets a second job
 * after its own, started only when the run exits with chant's drift code,
 * which trades for the update's identity and runs the update. The drift
 * check never holds the update's identity.
 */

import { OIDC_REQUEST_VARS } from "./ci-identity";
import type { ScheduledOpSpec } from "./lexicon";
import { resolveOpTrigger } from "./lexicon";
import { assertOpWaveCloud } from "./op/op-waves";

/** The update job's name beside the Op's job `jobName`. */
export function scheduledOpUpdateJobName(jobName: string): string {
  return `${jobName}-update`;
}

/** The shell line that drops the token request variables, which a step after the trade starts with. */
export function dropTokenRequestLine(): string {
  return `unset ${OIDC_REQUEST_VARS.join(" ")}`;
}

/** `line` with the token request variables dropped first. */
export function withoutTokenRequestLine(line: string): string {
  return `${dropTokenRequestLine()}\n${line}`;
}

/**
 * Refuse a `cloud` or `update` a generator could not render: a malformed
 * trade spec, an update with no command, an update on a push trigger or a
 * review split, or one beside a comment agent.
 */
export function assertScheduledOpCloud(spec: ScheduledOpSpec): void {
  const where = `Scheduled Op "${spec.name}"`;
  if (spec.cloud !== undefined) {
    assertOpWaveCloud(where, "cloud", spec.cloud);
    if (spec.reviewAgent === true) throw new Error(`${where}: a reviewAgent Op's review job runs the change's code beside a model, so it takes no cloud identity.`);
    if (spec.agent?.on === "comment") throw new Error(`${where}: a comment agent's jobs take no cloud identity.`);
  }
  const update = spec.update;
  if (update === undefined) return;
  if (update === null || typeof update !== "object" || typeof update.command !== "string" || update.command.trim() === "") {
    throw new Error(`${where}: update must give the command its job runs: { "command": "<line>", "cloud"?: {...} }.`);
  }
  if (update.cloud !== undefined) assertOpWaveCloud(where, "update.cloud", update.cloud);
  if (spec.reviewAgent === true) throw new Error(`${where}: update follows a drift check's run, and a reviewAgent Op runs a review; give it to a drift Op.`);
  if (spec.agent?.on === "comment") throw new Error(`${where}: update follows a drift check's run, and a comment agent's workflow has none.`);
  const trigger = resolveOpTrigger(spec);
  if (trigger.kind === "push") throw new Error(`${where}: update follows a drift check's run; give it a cron or pull_request trigger.`);
  for (const scope of Object.keys(update.permissions ?? {})) {
    if (scope === "contents") throw new Error(`${where}: update.permissions names contents, which the update job holds as read already; it adds scopes, never restates one.`);
  }
}
