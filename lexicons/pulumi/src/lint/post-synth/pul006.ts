/**
 * PUL006: the stack export holds tainted resources.
 *
 * `pulumi state taint` marks a resource `taint: true`, and the next
 * `pulumi up` replaces it whatever its inputs say. The member's preview
 * already shows the replacement, so this is information: the change set's
 * `replace` entry for the URN comes from the taint, not from a program
 * change, which a reviewer reading the diff alone cannot see.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { entityOf, finding, flagged, memberExport } from "./member-read-helpers";

export const pul006: PostSynthCheck = {
  id: "PUL006",
  description: "The pulumi member's stack export holds tainted resources the next update replaces (taint: true)",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    return flagged(exp.resources, "taint").map((r) =>
      finding(
        "PUL006",
        "info",
        `${PULUMI_EXPORT_FILE} holds ${r.urn} marked taint: true, so the next \`pulumi up\` replaces it ` +
          `and the member's preview shows a replace that no program change explains. \`pulumi state untaint\` clears the mark.`,
        entityOf(exp.read, r.urn),
      ),
    );
  },
};
