/**
 * WK8005: Hardcoded Secrets in Environment Variables
 *
 * Detects container environment variables with names suggesting sensitive
 * values (password, token, key, secret) that use hardcoded string values
 * instead of secretKeyRef or configMapKeyRef.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

const SENSITIVE_NAME_PATTERN = /password|token|key|secret/i;

export const wk8005: PostSynthCheck = {
  id: "WK8005",
  description: "Hardcoded secrets in env vars — sensitive environment variables should use secretKeyRef",

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
            if (
              typeof envVar.name === "string" &&
              SENSITIVE_NAME_PATTERN.test(envVar.name) &&
              envVar.value !== undefined &&
              envVar.value !== null &&
              typeof envVar.value === "string" &&
              envVar.value !== "" &&
              !envVar.valueFrom
            ) {
              diagnostics.push({
                checkId: "WK8005",
                severity: "error",
                message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" has hardcoded value for sensitive env var "${envVar.name}" — use secretKeyRef instead`,
                entity: resourceName,
                lexicon: "k8s",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
