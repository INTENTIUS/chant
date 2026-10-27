/**
 * PUL007: the configured stack is not the stack the export was taken from.
 *
 * `pulumi.member.stack` is the stack the drift read passes as `--stack`
 * (#4496). The graph comes from the checked-in export, whose URNs name the
 * stack it was taken from. When the two differ, the nodes are one stack's
 * resources and the drift records are another's: a URN only one of them
 * holds reads as not-observed, and every other record lands on a node it
 * does not describe.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { finding, memberExport, urnScopes } from "./member-read-helpers";

export const pul007: PostSynthCheck = {
  id: "PUL007",
  description: "pulumi.member.stack names a stack other than the one the checked-in stack export was taken from",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    const configured = exp?.read.stack;
    if (!exp || !configured) return [];
    const { stacks } = urnScopes(exp.resources);
    if (stacks.length !== 1 || stacks[0] === configured) return [];
    return [
      finding(
        "PUL007",
        "warning",
        `pulumi.member.stack is "${configured}", but ${PULUMI_EXPORT_FILE} was taken from stack "${stacks[0]}": ` +
          `the graph shows one stack and drift reads the other. Export "${configured}" ` +
          `(\`pulumi stack export --stack ${configured} --file ${PULUMI_EXPORT_FILE}\`) or set the stack the export names.`,
      ),
    ];
  },
};
