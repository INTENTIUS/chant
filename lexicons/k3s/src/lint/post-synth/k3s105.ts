/**
 * K3S105: a registry mirror that skips TLS verification.
 *
 * `insecure_skip_verify: true` in registries.yaml turns every image pull
 * through that registry into an unauthenticated trust decision. Legitimate
 * for a lab pull-through cache; worth a flag anywhere, because the estate
 * that sets it for the lab keeps it when the registry moves.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { entitiesOfType } from "./k3s-helpers";

export const k3s105: PostSynthCheck = {
  id: "K3S105",
  description: "registries.yaml disables TLS verification for a registry",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const entity of entitiesOfType(ctx, "K3s::Registries")) {
      const configs = entity.props.configs;
      if (typeof configs !== "object" || configs === null) continue;
      for (const [registry, config] of Object.entries(configs as Record<string, unknown>)) {
        const tls = resolveProps(resolveProps(config)?.tls);
        if (tls?.insecure_skip_verify === true) {
          diagnostics.push({
            checkId: "K3S105",
            severity: "warning",
            message:
              `"${entity.name}" disables TLS verification for registry "${registry}" — ` +
              "every pull through it is unauthenticated. Pin the registry CA via `ca_file` instead.",
            entity: entity.name,
            lexicon: "k3s",
          });
        }
      }
    }
    return diagnostics;
  },
};

function resolveProps(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.props === "object" && obj.props !== null && "entityType" in obj) {
    return obj.props as Record<string, unknown>;
  }
  return obj;
}
