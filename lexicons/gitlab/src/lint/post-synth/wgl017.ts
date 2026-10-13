/**
 * WGL017: Insecure Registry
 *
 * Detects Docker push/pull to non-HTTPS registries in job scripts.
 * Using HTTP for container registries is a security risk.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, topLevelSections } from "./yaml-helpers";

const INSECURE_REGISTRY_PATTERN = /docker\s+(push|pull|tag|login)\s+.*http:\/\/[^\s]+/;

export function checkInsecureRegistry(yaml: string): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const { key: jobName, text } of topLevelSections(yaml)) {
    for (const line of text.split("\n")) {
      if (INSECURE_REGISTRY_PATTERN.test(line)) {
        diagnostics.push({
          checkId: "WGL017",
          severity: "warning",
          message: `Job "${jobName}" uses an insecure (HTTP) container registry — use HTTPS instead`,
          entity: jobName,
          lexicon: "gitlab",
        });
        break;
      }
    }
  }

  return diagnostics;
}

export const wgl017: PostSynthCheck = {
  id: "WGL017",
  description: "Insecure registry — Docker push/pull to non-HTTPS registry",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      diagnostics.push(...checkInsecureRegistry(yaml));
    }
    return diagnostics;
  },
};
