/**
 * PUL001: a pulumi member was read with no graph.
 *
 * The member's graph is the `pulumi stack export` checked in beside
 * `Pulumi.yaml` as `stack-export.json` (`../../workspace-member.ts`). The
 * graph read never runs the program or `pulumi`, so a member with no export,
 * or one that is not JSON, has no nodes at all. The build still succeeds, the
 * change set and drift still run, and the graph silently shows an empty
 * member: nothing links to its resources and no drift record lands on a node.
 * This check says so at build time, with the reason the read recorded.
 *
 * It reads the report the plugin's `buildRoots` left for `graphMeta`
 * (`lastMemberReport`), so it fires only in a build that read a member: a
 * project that names the lexicon without a `pulumi.member` gets nothing.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { lastMemberReport, PULUMI_EXPORT_FILE } from "../../workspace-member";

export const pul001: PostSynthCheck = {
  id: "PUL001",
  description: "A pulumi member with no readable stack-export.json has no nodes in the graph",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const report = lastMemberReport();
    if (!report || report.exported) return [];
    return [
      {
        checkId: "PUL001",
        severity: "warning",
        message:
          `the pulumi member was read with no nodes: ${report.reason ?? `no readable ${PULUMI_EXPORT_FILE}`}. ` +
          `Its change set and drift still run, but nothing in the graph can link to its resources.`,
        lexicon: "pulumi",
        missing: { kind: PULUMI_EXPORT_FILE, scope: "pulumi member" },
      },
    ];
  },
};
