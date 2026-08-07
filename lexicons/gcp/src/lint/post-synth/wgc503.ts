/**
 * WGC503: Audit Logging Dropped or Scoped Down (#793, epic #787 C3)
 *
 * Flags IAMAuditConfig resources that capture nothing (no auditLogConfigs)
 * or that carve identities out of the audit trail via exemptedMembers.
 * WGC301 reports the absence of any IAMAuditConfig as hygiene; this check
 * covers the declared-but-weakened sink, which is merge-worthy.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getResourceName, getSpec } from "./gcp-helpers";

export const wgc503: PostSynthCheck = {
  id: "WGC503",
  description: "IAMAuditConfig captures nothing or exempts members — the audit sink is scoped down",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "IAMAuditConfig") continue;
        const name = getResourceName(manifest);
        const configs = getSpec(manifest)?.auditLogConfigs;

        if (!Array.isArray(configs) || configs.length === 0) {
          diagnostics.push({
            checkId: "WGC503",
            severity: "error",
            message: `IAMAuditConfig "${name}" has no auditLogConfigs — the audit sink is declared but captures nothing`,
            entity: name,
            lexicon: "gcp",
          });
          continue;
        }

        for (const config of configs as Array<Record<string, unknown>>) {
          const exempted = config.exemptedMembers;
          if (Array.isArray(exempted) && exempted.length > 0) {
            diagnostics.push({
              checkId: "WGC503",
              severity: "error",
              message: `IAMAuditConfig "${name}" exempts members from ${String(config.logType ?? "audit")} logging — audit evidence is scoped down`,
              entity: name,
              lexicon: "gcp",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
