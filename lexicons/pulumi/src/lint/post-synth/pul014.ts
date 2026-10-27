/**
 * PUL014: the export holds no resources.
 *
 * PUL001 covers a member with no export. An export that reads but holds
 * nothing besides the root stack and its providers gives the same empty
 * member, quietly: the stack was never deployed, was destroyed, or the file
 * was exported from a fresh stack. Information, since an empty stack can be
 * what the owner meant.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPulumiNodeless } from "@intentius/chant/pulumi-urn";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { finding, memberExport } from "./member-read-helpers";

export const pul014: PostSynthCheck = {
  id: "PUL014",
  description: "The pulumi member's stack export reads but holds no resources besides the stack and its providers",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    if (exp.resources.some((r) => !isPulumiNodeless(r.type))) return [];
    return [
      finding(
        "PUL014",
        "info",
        `${PULUMI_EXPORT_FILE} holds no resources besides the stack and its providers, so the member has no nodes. ` +
          `If the stack has been deployed since, export it again after \`pulumi up\`.`,
      ),
    ];
  },
};
