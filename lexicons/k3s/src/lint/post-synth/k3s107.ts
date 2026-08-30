/**
 * K3S107: a packaged component is disabled but also configured.
 *
 * `disable` removes a packaged component entirely — the flags that
 * configure it (`cluster-dns` for coredns, `servicelb-namespace` for
 * servicelb, `default-local-storage-path` for local-storage) then land in
 * config.yaml for a component that never starts. Dead config, and a
 * signal the `disable` and the config drifted out of sync rather than
 * being written together.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { entitiesOfType } from "./k3s-helpers";

/**
 * Packaged component name (as it appears in `disable`) to the config keys
 * that only make sense while that component runs. Limited to the
 * components the k3s server flag surface actually has dedicated
 * configuration for — traefik and metrics-server are configured via Helm
 * chart manifests, not server flags, so there is nothing here to conflict.
 */
const COMPONENT_CONFIG_KEYS: Record<string, string[]> = {
  coredns: ["cluster-dns"],
  servicelb: ["servicelb-namespace"],
  "local-storage": ["default-local-storage-path"],
};

export const k3s107: PostSynthCheck = {
  id: "K3S107",
  description: "disable names a component the config also configures",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const entity of entitiesOfType(ctx, "K3s::Server")) {
      const raw = entity.props.disable;
      const disabled = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
      for (const component of disabled) {
        if (typeof component !== "string") continue;
        const configKeys = COMPONENT_CONFIG_KEYS[component];
        if (!configKeys) continue;
        for (const key of configKeys) {
          const value = entity.props[key];
          const isSet =
            (typeof value === "string" && value.length > 0) ||
            (Array.isArray(value) && value.length > 0);
          if (!isSet) continue;
          diagnostics.push({
            checkId: "K3S107",
            severity: "warning",
            message:
              `"${entity.name}" disables \`${component}\` but also sets \`${key}\` — ` +
              `that config has no effect on a component that never starts. Remove \`${key}\`, ` +
              `or drop \`${component}\` from \`disable\`.`,
            entity: entity.name,
            lexicon: "k3s",
          });
        }
      }
    }
    return diagnostics;
  },
};
