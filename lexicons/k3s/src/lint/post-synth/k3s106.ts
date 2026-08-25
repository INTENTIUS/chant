/**
 * K3S106: tls-san missing when the server is reachable at a declared
 * address beyond the implicit default.
 *
 * The kube-apiserver certificate is only valid for the addresses baked
 * into it. `bind-address` and `advertise-address` both say "clients reach
 * this server somewhere other than its bare node-ip" — a fixed bind
 * address, or a front-door address for an HA load balancer / VIP. Either
 * one without a matching `tls-san` entry means the first connection
 * through that address hits a certificate mismatch.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { entitiesOfType } from "./k3s-helpers";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export const k3s106: PostSynthCheck = {
  id: "K3S106",
  description: "tls-san is missing while bind-address or advertise-address is declared",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const entity of entitiesOfType(ctx, "K3s::Server")) {
      const tlsSan = entity.props["tls-san"];
      const hasTlsSan = isNonEmptyString(tlsSan) || (Array.isArray(tlsSan) && tlsSan.length > 0);
      if (hasTlsSan) continue;

      const bindAddress = entity.props["bind-address"];
      const advertiseAddress = entity.props["advertise-address"];
      const declaredField = isNonEmptyString(bindAddress)
        ? "bind-address"
        : isNonEmptyString(advertiseAddress)
          ? "advertise-address"
          : undefined;
      if (!declaredField) continue;

      diagnostics.push({
        checkId: "K3S106",
        severity: "warning",
        message:
          `"${entity.name}" sets \`${declaredField}\` but declares no \`tls-san\` — ` +
          "the apiserver certificate won't cover that address, and the first client to reach " +
          "it there hits a TLS mismatch. Add it to `tls-san`.",
        entity: entity.name,
        lexicon: "k3s",
      });
    }
    return diagnostics;
  },
};
