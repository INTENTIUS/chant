/**
 * PUL004: the stack export holds resources pending deletion.
 *
 * A create-before-delete replacement creates the new resource, then deletes
 * the old one. When the delete fails, Pulumi keeps the old resource in the
 * state with `delete: true` under the same URN, and the next `pulumi up`
 * tries the delete again. Until then the stack owns two cloud objects for
 * one URN. The graph has one node per URN, so the old object has no node of
 * its own, and drift for that URN reads the live resource only.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { entityOf, finding, flagged, memberExport } from "./member-read-helpers";

export const pul004: PostSynthCheck = {
  id: "PUL004",
  description: "The pulumi member's stack export holds replaced resources whose delete failed (delete: true)",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    return flagged(exp.resources, "delete").map((r) =>
      finding(
        "PUL004",
        "warning",
        `${PULUMI_EXPORT_FILE} holds ${r.urn} marked delete: true, the old object of a replacement whose delete failed. ` +
          `The stack owns two objects for this URN and the graph shows one. Run \`pulumi up\` to retry the delete, then export again.`,
        entityOf(exp.read, r.urn),
      ),
    );
  },
};
