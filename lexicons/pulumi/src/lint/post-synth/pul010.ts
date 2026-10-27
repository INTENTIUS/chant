/**
 * PUL010: a resource's parent or dependency is not in the export.
 *
 * Edges come from each resource's `parent` and `dependencies`
 * (`../../workspace-member.ts`), and an edge to a URN the export does not
 * hold is dropped without a word. Pulumi's own integrity check refuses a
 * deployment whose resources name a parent or dependency it does not hold,
 * so an export like this was edited by hand or cut short, and the graph is
 * missing the edges it names.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { entityOf, finding, listed, memberExport } from "./member-read-helpers";

export const pul010: PostSynthCheck = {
  id: "PUL010",
  description: "A resource in the pulumi member's stack export names a parent or dependency the export does not hold",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    const held = new Set(exp.resources.map((r) => r.urn));
    const out: PostSynthDiagnostic[] = [];
    for (const r of exp.resources) {
      const named = [r.parent, ...(Array.isArray(r.dependencies) ? r.dependencies : [])].filter(
        (u): u is string => typeof u === "string" && u.length > 0,
      );
      const dangling = [...new Set(named.filter((u) => !held.has(u)))];
      if (dangling.length === 0) continue;
      out.push(
        finding(
          "PUL010",
          "warning",
          `${r.urn} names ${dangling.length} parent or dependency URN(s) ${PULUMI_EXPORT_FILE} does not hold (${listed(dangling)}), ` +
            `so the graph has no edge for them. Replace the file with a fresh \`pulumi stack export\`.`,
          entityOf(exp.read, r.urn),
        ),
      );
    }
    return out;
  },
};
