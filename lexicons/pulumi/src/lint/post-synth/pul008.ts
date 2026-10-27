/**
 * PUL008: the export's URNs name more than one stack or project.
 *
 * Pulumi writes one stack's resources to an export, all under one
 * `urn:pulumi:<stack>::<project>::` prefix. A node key drops that prefix
 * (`@intentius/chant/pulumi-urn`), so two stacks' copies of a resource fall
 * on one node, and the drift read cannot tell which stack to pass as
 * `--stack`. An export like this was merged or edited by hand.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { finding, memberExport, urnScopes } from "./member-read-helpers";

export const pul008: PostSynthCheck = {
  id: "PUL008",
  description: "The pulumi member's stack export names more than one stack or project in its URNs",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    const { stacks, projects } = urnScopes(exp.resources);
    const parts: string[] = [];
    if (stacks.length > 1) parts.push(`stacks ${stacks.join(", ")}`);
    if (projects.length > 1) parts.push(`projects ${projects.join(", ")}`);
    if (parts.length === 0) return [];
    return [
      finding(
        "PUL008",
        "warning",
        `${PULUMI_EXPORT_FILE} names ${parts.join(" and ")} in its URNs. Node ids drop the stack and project, ` +
          `so resources of different stacks share nodes. Replace the file with one \`pulumi stack export\`.`,
      ),
    ];
  },
};
