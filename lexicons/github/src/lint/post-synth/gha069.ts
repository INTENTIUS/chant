/**
 * GHA069: Job-Level Permissions Block Drops the Workflow's `id-token: write`
 *
 * A job-level `permissions:` block replaces the workflow-level one; GitHub
 * does not merge the two. A workflow that grants `id-token: write` at the top
 * and then gives a job its own block without that scope leaves the job with
 * no OIDC token, and the job's cloud-credential action fails with an error
 * that names neither the scope nor the job block (#2273).
 *
 * Fires when all three hold:
 * - the workflow-level block grants `id-token: write` (directly, or through
 *   `write-all`);
 * - a job declares its own block that does not (a map without
 *   `id-token: write`, `{}`, `read-all`, or any other preset but `write-all`);
 * - that job has a step using a known OIDC credential action, matched on the
 *   action path whatever the ref (tag, major or full SHA), with no static
 *   credential input that would make the step skip OIDC.
 *
 * Only `id-token` is checked. The reasoning for not generalising to every
 * scope a job block narrows is recorded on #2273.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import {
  getPrimaryOutput,
  extractWorkflowPermissions,
  extractJobPermissions,
  extractStepsByJob,
  parseActionUses,
  type PermissionsValue,
} from "./yaml-helpers";

/**
 * Actions that exchange the job's OIDC token for cloud credentials, keyed by
 * lowercased `owner/repo`, each with the inputs that select a static
 * credential instead (when one is set, the step does not need `id-token`).
 */
export const OIDC_CREDENTIAL_ACTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["aws-actions/configure-aws-credentials", ["aws-access-key-id", "web-identity-token-file"]],
  ["azure/login", ["creds"]],
  ["google-github-actions/auth", ["credentials_json"]],
]);

/** True when the permissions value grants `id-token: write`. */
export function grantsIdTokenWrite(perms: PermissionsValue): boolean {
  if (typeof perms === "string") return perms.trim() === "write-all";
  return perms["id-token"] === "write";
}

/** The OIDC credential action a step uses, as written, or undefined. */
function oidcActionOf(step: Record<string, unknown>): string | undefined {
  if (typeof step.uses !== "string") return undefined;
  const parsed = parseActionUses(step.uses);
  if (!parsed) return undefined;
  const staticInputs = OIDC_CREDENTIAL_ACTIONS.get(parsed.slug.toLowerCase());
  if (!staticInputs) return undefined;
  const withInputs = step.with;
  if (withInputs && typeof withInputs === "object" && !Array.isArray(withInputs)) {
    const inputs = withInputs as Record<string, unknown>;
    if (staticInputs.some((k) => inputs[k] !== undefined && inputs[k] !== null && inputs[k] !== "")) return undefined;
  }
  return parsed.slug;
}

function describeJobBlock(perms: PermissionsValue): string {
  if (typeof perms === "string") return `\`permissions: ${perms}\``;
  if (Object.keys(perms).length === 0) return "`permissions: {}`";
  return "its own `permissions:` block";
}

export const gha069: PostSynthCheck = {
  id: "GHA069",
  description: "Job-level permissions block drops the workflow's id-token: write that an OIDC credential step needs",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      const wf = extractWorkflowPermissions(yaml);
      if (!wf || !grantsIdTokenWrite(wf)) continue;

      const jobPermissions = extractJobPermissions(yaml);
      if (jobPermissions.size === 0) continue;

      const stepsByJob = extractStepsByJob(yaml);
      for (const [job, perms] of jobPermissions) {
        if (grantsIdTokenWrite(perms)) continue;

        const actions = [
          ...new Set((stepsByJob.get(job) ?? []).map(oidcActionOf).filter((a): a is string => a !== undefined)),
        ];
        if (actions.length === 0) continue;

        diagnostics.push({
          checkId: "GHA069",
          severity: "warning",
          message:
            `Job "${job}" declares ${describeJobBlock(perms)}, which replaces the workflow-level block instead of merging with it, ` +
            `so the workflow's \`id-token: write\` does not reach the job and ${actions.join(", ")} cannot request an OIDC token. ` +
            `Add \`id-token: write\` to job "${job}"'s permissions block; keep the job block rather than removing it.`,
          entity: job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
