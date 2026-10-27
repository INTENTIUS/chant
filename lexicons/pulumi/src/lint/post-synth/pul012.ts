/**
 * PUL012: the export holds resources the stack reads but does not manage.
 *
 * A resource a program reads with a `get` function (`aws.s3.Bucket.get`) is
 * in the state with `external: true`. It is a node like any other, but the
 * stack never creates, updates or deletes it, so a drift record on it shows
 * a change some other owner made, and the member's preview never plans a fix
 * for it. Information, so a reader of the graph knows which nodes this
 * member only looks at.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPulumiNodeless } from "@intentius/chant/pulumi-urn";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { finding, flagged, listed, memberExport } from "./member-read-helpers";

export const pul012: PostSynthCheck = {
  id: "PUL012",
  description: "The pulumi member's stack export holds resources the stack reads and does not manage (external: true)",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    const external = flagged(exp.resources, "external").filter((r) => !isPulumiNodeless(r.type));
    if (external.length === 0) return [];
    return [
      finding(
        "PUL012",
        "info",
        `${PULUMI_EXPORT_FILE} holds ${external.length} resource(s) the program reads with a get function and does not manage ` +
          `(${listed(external.map((r) => r.urn))}). They are nodes, but this member's preview never changes them, ` +
          `so drift on them is another owner's.`,
      ),
    ];
  },
};
