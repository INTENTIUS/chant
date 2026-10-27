/**
 * PUL005: the stack export holds resources pending replacement.
 *
 * A delete-before-create replacement deletes the old resource first and
 * marks it `pendingReplacement: true` until the new one is created. An
 * export that still carries the mark was taken after an update stopped
 * between the two steps, so the cloud object behind the node may be gone.
 * Its drift reads as missing until the next `pulumi up` creates it.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { entityOf, finding, flagged, memberExport } from "./member-read-helpers";

export const pul005: PostSynthCheck = {
  id: "PUL005",
  description: "The pulumi member's stack export holds resources deleted ahead of a replacement that never finished (pendingReplacement: true)",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    return flagged(exp.resources, "pendingReplacement").map((r) =>
      finding(
        "PUL005",
        "warning",
        `${PULUMI_EXPORT_FILE} holds ${r.urn} marked pendingReplacement: true: it was deleted for a replacement that was never created, ` +
          `so its node may stand for nothing in the cloud. Run \`pulumi up\` to finish the replacement, then export again.`,
        entityOf(exp.read, r.urn),
      ),
    );
  },
};
