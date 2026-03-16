/**
 * WK8041: Hardcoded API Keys
 *
 * Detects well-known API key patterns in container environment variable values.
 * Catches Stripe keys, GitHub PATs, AWS access keys, Google API keys, and
 * other common credential formats.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

/**
 * Known API key patterns and their descriptions.
 */
const API_KEY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^sk_live_/, label: "Stripe secret key" },
  { pattern: /^pk_live_/, label: "Stripe publishable key" },
  { pattern: /^sk_test_/, label: "Stripe test secret key" },
  { pattern: /^pk_test_/, label: "Stripe test publishable key" },
  { pattern: /^ghp_[A-Za-z0-9_]{36,}/, label: "GitHub personal access token" },
  { pattern: /^gho_[A-Za-z0-9_]{36,}/, label: "GitHub OAuth token" },
  { pattern: /^ghs_[A-Za-z0-9_]{36,}/, label: "GitHub app installation token" },
  { pattern: /^ghu_[A-Za-z0-9_]{36,}/, label: "GitHub user-to-server token" },
  { pattern: /^ghr_[A-Za-z0-9_]{36,}/, label: "GitHub refresh token" },
  { pattern: /^AKIA[A-Z0-9]{16}$/, label: "AWS access key ID" },
  { pattern: /^AIza[A-Za-z0-9_-]{35}$/, label: "Google API key" },
  { pattern: /^xox[bprs]-[A-Za-z0-9-]+/, label: "Slack token" },
  { pattern: /^SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/, label: "SendGrid API key" },
];

export const wk8041: PostSynthCheck = {
  id: "WK8041",
  description: "Hardcoded API keys — detects well-known API key patterns in env var values",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;

        const containers = extractContainers(manifest);
        const resourceName = manifest.metadata?.name ?? manifest.kind;

        for (const container of containers) {
          if (!Array.isArray(container.env)) continue;

          for (const envVar of container.env) {
            if (typeof envVar.value !== "string" || envVar.value === "") continue;

            for (const { pattern, label } of API_KEY_PATTERNS) {
              if (pattern.test(envVar.value)) {
                diagnostics.push({
                  checkId: "WK8041",
                  severity: "error",
                  message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" has a ${label} hardcoded in env var "${envVar.name ?? "(unnamed)"}" — use a Secret reference instead`,
                  entity: resourceName,
                  lexicon: "k8s",
                });
                break; // One match per env var is sufficient
              }
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
