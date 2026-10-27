/**
 * PUL011: two live resources in the export share a URN.
 *
 * A URN names one resource. The only state that holds two entries for one
 * URN is a replacement in flight, where the old entry is marked
 * `delete: true` (PUL004 reports those). Two entries with neither mark come
 * from a hand-merged export, which `pulumi stack import` refuses. The graph
 * keeps the last one, so the other has no node.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { entityOf, finding, memberExport } from "./member-read-helpers";

export const pul011: PostSynthCheck = {
  id: "PUL011",
  description: "Two resources in the pulumi member's stack export share a URN and neither is pending deletion",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    const count = new Map<string, number>();
    for (const r of exp.resources) {
      if (r.delete === true) continue;
      count.set(r.urn, (count.get(r.urn) ?? 0) + 1);
    }
    return [...count]
      .filter(([, n]) => n > 1)
      .map(([urn, n]) =>
        finding(
          "PUL011",
          "warning",
          `${PULUMI_EXPORT_FILE} holds ${n} live entries for ${urn}; the graph keeps one. ` +
            `Replace the file with a fresh \`pulumi stack export\`.`,
          entityOf(exp.read, urn),
        ),
      );
  },
};
