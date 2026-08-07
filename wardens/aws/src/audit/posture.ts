/**
 * Posture audit over the reconcile diff (#793, epic #787 C3) — drift as a
 * finding. The reconcile plan says what apply would do; this reads the same
 * diff as posture: a declared guardrail missing live, a live SCP the config
 * no longer declares, a drifted document, a scoped-down or undeclared audit
 * trail, a break-glass grant that is gone. Tier/category reuse the audit
 * catalog's model (`@intentius/chant/audit/catalog`); the build-time
 * counterparts are the aws lexicon's WAW056–058 post-synth checks.
 *
 * DETECT-AND-REPORT only. No mutations.
 */

import type { Category, Tier } from "@intentius/chant/audit/catalog";
import type { GovernanceVerb } from "@intentius/chant/governance";
import type { ChangeSetEntry } from "@intentius/chant/reconcile";
import type { AwsGovernanceConfig } from "../config/types.js";
import type { LiveOrgState } from "../reconcile/live.js";
import { diff, desiredAssignments } from "../reconcile/diff.js";

/** One posture regression, tiered like an audit-catalog rule. */
export interface PostureFinding {
  /** Stable finding id, e.g. "scp-missing-live". */
  id: string;
  tier: Tier;
  category: Category;
  verb: GovernanceVerb;
  /** The change-set key the finding is about (SCP name, trail name, grant key). */
  key: string;
  message: string;
}

const mergeWorthy = (
  id: string,
  verb: GovernanceVerb,
  key: string,
  message: string,
  category: Category = "security",
): PostureFinding => ({ id, tier: "merge-worthy", category, verb, key, message });

function scpFindings(entry: ChangeSetEntry): PostureFinding[] {
  if (entry.kind === "create") {
    return [
      mergeWorthy("scp-missing-live", "policy-guardrail", entry.key,
        `declared SCP "${entry.key}" does not exist live — the guardrail is not enforced in the organization`),
    ];
  }
  if (entry.kind === "delete") {
    return [
      mergeWorthy("scp-undeclared", "policy-guardrail", entry.key,
        `live SCP "${entry.key}" is no longer declared — merging this config removes the guardrail`),
    ];
  }
  const findings: PostureFinding[] = [];
  for (const f of entry.fields ?? []) {
    if (f.field === "document") {
      findings.push(
        mergeWorthy("scp-document-drift", "policy-guardrail", entry.key,
          `SCP "${entry.key}" document drifted from the declared guardrail`),
      );
    }
    if (f.field === "targets") {
      findings.push(
        mergeWorthy("scp-targets-drift", "policy-guardrail", entry.key,
          `SCP "${entry.key}" attachments drifted from the declared targets`),
      );
    }
  }
  return findings;
}

function trailFindings(entry: ChangeSetEntry): PostureFinding[] {
  if (entry.kind === "create") {
    return [
      mergeWorthy("trail-missing-live", "audit-sink", entry.key,
        `declared organization trail does not exist live — no audit evidence is being collected`),
    ];
  }
  const findings: PostureFinding[] = [];
  for (const f of entry.fields ?? []) {
    if (f.field === "multiRegion" && f.after === true) {
      findings.push(
        mergeWorthy("trail-single-region", "audit-sink", entry.key,
          `organization trail "${entry.key}" is single-region live — audit evidence is scoped down`),
      );
    }
    if (f.field === "bucket") {
      findings.push(
        mergeWorthy("trail-bucket-drift", "audit-sink", entry.key,
          `organization trail "${entry.key}" delivers to "${String(f.before)}", not the declared "${String(f.after)}"`),
      );
    }
  }
  return findings;
}

/**
 * Map the reconcile diff between the authored config and the fetched live
 * state onto posture findings. Pure; selective like the diff itself — only
 * the live parts present in `live` produce findings.
 */
export function auditPosture(config: AwsGovernanceConfig, live: LiveOrgState): PostureFinding[] {
  const findings: PostureFinding[] = [];

  const breakGlass = config.identity?.breakGlass;
  const breakGlassKeys = new Set(
    breakGlass
      ? breakGlass.accounts.map(
          (account) => `${breakGlass.permissionSet}/${account}/${breakGlass.principalType}:${breakGlass.principal}`,
        )
      : [],
  );

  for (const entry of diff("posture-audit", config, live).entries) {
    if (entry.resourceType === "scp") findings.push(...scpFindings(entry));
    if (entry.resourceType === "trail") findings.push(...trailFindings(entry));
    if (entry.resourceType === "assignment" && entry.kind === "create" && breakGlassKeys.has(entry.key)) {
      findings.push(
        mergeWorthy("break-glass-missing", "identity-assignment", entry.key,
          `break-glass admin grant "${entry.key}" does not exist live — emergency access is gone`),
      );
    }
  }

  // The trail diff never emits deletes (reconcile refuses to remove trails);
  // an undeclared live organization trail is exactly the drift this tier owns.
  if (live.trails && !config.auditSinks?.cloudtrail) {
    for (const trail of live.trails) {
      if (!trail.isOrganizationTrail) continue;
      findings.push({
        id: "trail-undeclared",
        tier: "report-only",
        category: "best-practice",
        verb: "audit-sink",
        key: trail.name,
        message: `live organization trail "${trail.name}" is not declared in the governance config — declare it so posture is tracked`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rendering + exit policy (mirrors github-warden's audit summary)
// ---------------------------------------------------------------------------

export type FailOn = "merge-worthy" | "any" | "none";

/** Render the findings to a string, grouped by governance verb. */
export function renderPostureFindings(findings: PostureFinding[]): string {
  const lines: string[] = [];
  lines.push("=== posture audit ===");
  lines.push("");

  if (findings.length === 0) {
    lines.push("  no posture regressions — live state matches the declared governance posture");
  }
  for (const f of findings) {
    lines.push(`  [${f.tier}] ${f.verb} ${f.id}: ${f.message}`);
  }

  const mergeWorthyCount = findings.filter((f) => f.tier === "merge-worthy").length;
  lines.push("");
  lines.push("--- totals ---");
  lines.push(`  total=${findings.length}`);
  lines.push(`  merge-worthy=${mergeWorthyCount}  (a dropped or weakened guardrail)`);
  lines.push(`  report-only=${findings.length - mergeWorthyCount}  (informational)`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Whether the findings should cause a non-zero exit (mirrors github-warden
 * audit's --fail-on and chant audit --fail-on merge-worthy).
 */
export function shouldFail(findings: PostureFinding[], failOn: FailOn): boolean {
  switch (failOn) {
    case "merge-worthy":
      return findings.some((f) => f.tier === "merge-worthy");
    case "any":
      return findings.length > 0;
    case "none":
    default:
      return false;
  }
}

/** All live parts the posture audit reads; identity only when config declares it. */
export function postureFetchParts(config: AwsGovernanceConfig): { scps: true; trails: true; identity?: true } {
  return { scps: true, trails: true, ...(config.identity ? { identity: true as const } : {}) };
}
