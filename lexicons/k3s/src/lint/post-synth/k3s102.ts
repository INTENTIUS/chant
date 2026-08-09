/**
 * K3S102: registry credentials as literals.
 *
 * registries.yaml supports inline `auth.password` / `auth.token`, and a
 * committed estate that uses them has published its registry credentials.
 * The TLS file paths beside them are host paths — those are fine; it is
 * the credential values that must come from somewhere else.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { entitiesOfType } from "./k3s-helpers";

export const k3s102: PostSynthCheck = {
  id: "K3S102",
  description: "registries.yaml carries a literal registry credential",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const entity of entitiesOfType(ctx, "K3s::Registries")) {
      const configs = entity.props.configs;
      if (typeof configs !== "object" || configs === null) continue;
      for (const [registry, config] of Object.entries(configs as Record<string, unknown>)) {
        const auth = resolveProps(config)?.auth;
        const authProps = resolveProps(auth);
        if (!authProps) continue;
        for (const key of ["password", "token"]) {
          const value = authProps[key];
          if (typeof value === "string" && value.length > 0) {
            diagnostics.push({
              checkId: "K3S102",
              severity: "error",
              message:
                `"${entity.name}" carries a literal \`${key}\` for registry "${registry}" — ` +
                "a committed registries.yaml is a leaked credential. Configure registry auth " +
                "on the host outside the declaration.",
              entity: entity.name,
              lexicon: "k3s",
            });
          }
        }
      }
    }
    return diagnostics;
  },
};

/** A nested value may be a plain object or a property declarable carrying props. */
function resolveProps(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.props === "object" && obj.props !== null && "entityType" in obj) {
    return obj.props as Record<string, unknown>;
  }
  return obj;
}
