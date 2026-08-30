/**
 * GHA060: Over-Scoped Generated Token
 *
 * Flags a GitHub App installation token minted with a `permission-<scope>:
 * write`/`admin` input broader than what the job's consuming steps evidence.
 * Targets the well-known GitHub App token actions (`actions/create-github-app-
 * token`, `tibdex/github-app-token`, `getsentry/action-github-app-token`),
 * which take `permission-<resource>: read|write|admin` inputs and hand back
 * the minted token as a step output.
 *
 * Two ways a generated token is over-scoped:
 *  1. Unused — the token's output (`steps.<id>.outputs.token`) is never
 *     referenced by any other step in the job, so every write/admin scope
 *     granted is pure waste.
 *  2. No signal — the token IS consumed, but no other step in the job shows
 *     any evidence (a `gh`/`git` invocation, an API path, a keyword) of
 *     exercising a scope granted `write`/`admin`.
 *
 * "No signal" is a heuristic, not a proof — a step could exercise a scope
 * through machinery this doesn't recognize (a custom script calling `octokit`
 * directly, say). It reports `guidance`, not a `deterministic` fix, for
 * exactly that reason: a human confirms before narrowing the grant.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractStepsByJob, parseActionUses } from "./yaml-helpers";

const APP_TOKEN_SLUGS = new Set([
  "actions/create-github-app-token",
  "tibdex/github-app-token",
  "getsentry/action-github-app-token",
]);

const WRITE_LEVELS = new Set(["write", "admin"]);

/** Textual evidence that a step exercises a given permission scope. Not exhaustive — a fallback covers unlisted scopes. */
const SCOPE_SIGNALS: Record<string, RegExp> = {
  contents: /git\s+push|gh\s+release|\/(?:git\/)?contents\b/i,
  issues: /gh\s+issue|\/issues\b/i,
  "pull-requests": /gh\s+pr\b|\/pulls\b/i,
  packages: /npm\s+publish|docker\s+push|\/packages\b/i,
  administration: /\/admin\b|administration/i,
  actions: /\/actions\/runs|gh\s+run\b/i,
  checks: /check-runs|\bchecks\b/i,
  deployments: /\/deployments\b/i,
  statuses: /\/statuses\b/i,
  workflows: /\.github\/workflows/i,
  environments: /\/environments\b/i,
};

function scopeSignalMatches(scope: string, text: string): boolean {
  const signal = SCOPE_SIGNALS[scope];
  if (signal) return signal.test(text);
  return new RegExp(scope.replace(/-/g, "[-_ ]?"), "i").test(text);
}

function stepText(step: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof step.run === "string") parts.push(step.run);
  if (step.with && typeof step.with === "object") parts.push(JSON.stringify(step.with));
  if (step.env && typeof step.env === "object") parts.push(JSON.stringify(step.env));
  if (typeof step.uses === "string") parts.push(step.uses);
  return parts.join("\n");
}

export interface OverScopedTokenFinding {
  job: string;
  stepId: string;
  scopes: string[];
  reason: "unused" | "no-signal";
}

/** Find every generated GitHub App token whose granted write/admin scopes exceed what the job's other steps evidence. */
export function findOverScopedTokens(yaml: string): OverScopedTokenFinding[] {
  const findings: OverScopedTokenFinding[] = [];

  for (const [job, steps] of extractStepsByJob(yaml)) {
    steps.forEach((step, idx) => {
      const uses = typeof step.uses === "string" ? step.uses : undefined;
      if (!uses) return;
      const parsed = parseActionUses(uses);
      if (!parsed || !APP_TOKEN_SLUGS.has(parsed.slug)) return;

      const withBlock = step.with && typeof step.with === "object" ? (step.with as Record<string, unknown>) : {};
      const stepId = typeof step.id === "string" ? step.id : `#${idx}`;

      const writeScopes: string[] = [];
      for (const [key, value] of Object.entries(withBlock)) {
        const m = /^permission-([a-z-]+)$/i.exec(key);
        if (!m) continue;
        if (WRITE_LEVELS.has(String(value).toLowerCase())) writeScopes.push(m[1]);
      }
      if (writeScopes.length === 0) return;

      // Evidence comes only from OTHER steps — the minting step's own `with:`
      // block names the scopes being granted, so it can't also count as
      // evidence they're used.
      const otherStepsText = steps
        .filter((_, i) => i !== idx)
        .map(stepText)
        .join("\n");

      const outputRef = `steps.${stepId}.outputs.token`;
      if (!otherStepsText.includes(outputRef)) {
        findings.push({ job, stepId, scopes: writeScopes, reason: "unused" });
        return;
      }

      const unsignaled = writeScopes.filter((scope) => !scopeSignalMatches(scope, otherStepsText));
      if (unsignaled.length > 0) {
        findings.push({ job, stepId, scopes: unsignaled, reason: "no-signal" });
      }
    });
  }

  return findings;
}

export const gha060: PostSynthCheck = {
  id: "GHA060",
  description: "Generated GitHub App token granted broader scope than its consuming steps evidence",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const finding of findOverScopedTokens(yaml)) {
        const scopeList = finding.scopes.map((s) => `permission-${s}`).join(", ");
        const message =
          finding.reason === "unused"
            ? `Job "${finding.job}" step "${finding.stepId}" mints a GitHub App token with ${scopeList} but no other step references its output — remove the unused scope(s) or the token step entirely.`
            : `Job "${finding.job}" step "${finding.stepId}" mints a GitHub App token with ${scopeList}, but no consuming step shows evidence of exercising that scope — narrow the token to the scopes actually used.`;
        diagnostics.push({
          checkId: "GHA060",
          severity: "warning",
          message,
          entity: finding.job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
