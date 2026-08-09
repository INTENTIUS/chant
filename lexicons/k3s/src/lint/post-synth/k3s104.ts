/**
 * K3S104: kubeconfig written wider than 0644.
 *
 * `write-kubeconfig-mode` widens /etc/rancher/k3s/k3s.yaml — the file
 * carrying the cluster's admin credential. k3s's own default is 0600;
 * 0644 is the documented convenience for a single-user host. Anything
 * granting write to group/other, or beyond read to other, hands the
 * admin kubeconfig to every local account.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { entitiesOfType } from "./k3s-helpers";

export const k3s104: PostSynthCheck = {
  id: "K3S104",
  description: "write-kubeconfig-mode is wider than 0644",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const entity of entitiesOfType(ctx, "K3s::Server")) {
      const raw = entity.props["write-kubeconfig-mode"];
      if (raw === undefined) continue;
      const mode = parseInt(String(raw), 8);
      if (Number.isNaN(mode)) continue;
      // Bits outside rw-r--r-- mean group/other write, or execute anywhere.
      if ((mode & ~0o644) !== 0) {
        diagnostics.push({
          checkId: "K3S104",
          severity: "warning",
          message:
            `"${entity.name}" sets write-kubeconfig-mode ${String(raw)} — wider than 0644. ` +
            "The kubeconfig carries the cluster admin credential; keep it 0600, or 0644 at most.",
          entity: entity.name,
          lexicon: "k3s",
        });
      }
    }
    return diagnostics;
  },
};
