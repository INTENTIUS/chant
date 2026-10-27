/**
 * PUL009: the export was taken from another project.
 *
 * Every URN in an export names the project it belongs to, and `Pulumi.yaml`'s
 * `name` is the member's project. When they differ, the checked-in export is
 * some other program's (copied in, or left from before a rename), and the
 * graph shows resources this member's preview and refresh never touch.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { finding, memberExport, pulumiYamlName, urnScopes } from "./member-read-helpers";

export const pul009: PostSynthCheck = {
  id: "PUL009",
  description: "The pulumi member's stack export belongs to a project other than the one Pulumi.yaml names",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    const name = pulumiYamlName(exp.read.dir);
    const { projects } = urnScopes(exp.resources);
    if (!name || projects.length !== 1 || projects[0] === name) return [];
    return [
      finding(
        "PUL009",
        "warning",
        `${PULUMI_EXPORT_FILE} was taken from project "${projects[0]}", but Pulumi.yaml names "${name}": ` +
          `the graph shows another program's resources. Export this member's own stack again.`,
      ),
    ];
  },
};
