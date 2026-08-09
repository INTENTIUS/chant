/**
 * K3S103: an agent that joins nothing.
 *
 * An agent config without `server` is a node with no cluster to join —
 * `k3s agent` refuses to start without it (or K3S_URL in the service
 * environment). Declaring the agent while leaving the join out of band
 * defeats the declaration, so this asks for it in the config.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { entitiesOfType } from "./k3s-helpers";

export const k3s103: PostSynthCheck = {
  id: "K3S103",
  description: "An agent config declares no server to join",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const entity of entitiesOfType(ctx, "K3s::Agent")) {
      const server = entity.props.server;
      if (typeof server === "string" && server.length > 0) continue;
      diagnostics.push({
        checkId: "K3S103",
        severity: "error",
        message:
          `"${entity.name}" declares no \`server\` — the agent has no cluster to join. ` +
          "Set `server: https://<server-host>:6443` in the declaration.",
        entity: entity.name,
        lexicon: "k3s",
      });
    }
    return diagnostics;
  },
};
