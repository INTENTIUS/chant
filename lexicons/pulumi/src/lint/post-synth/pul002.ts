/**
 * PUL002: the member's stack export records pending operations.
 *
 * Pulumi writes a `deployment.pending_operations` entry for each step an
 * update started and did not finish (a killed `pulumi up`, a lost runner).
 * Until someone resolves them (`pulumi refresh`, or `pulumi stack export`,
 * edit, `pulumi stack import`), the stack may hold a resource its state does
 * not list, and `pulumi preview` and `pulumi refresh` warn about them on
 * every run. chant reads the checked-in export for the graph, so an export
 * taken in that state puts the same gap in the graph: the half-created
 * resources have no node.
 *
 * A warning, not an error: the export is still read, and the fix is the
 * stack owner's, outside chant.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { lastMemberReport, PULUMI_EXPORT_FILE } from "../../workspace-member";

export const pul002: PostSynthCheck = {
  id: "PUL002",
  description: "The pulumi member's stack export records operations an interrupted update left pending",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const pending = lastMemberReport()?.pendingOperations ?? 0;
    if (pending === 0) return [];
    return [
      {
        checkId: "PUL002",
        severity: "warning",
        message:
          `${PULUMI_EXPORT_FILE} records ${pending} pending operation(s): an update was interrupted and the stack may hold ` +
          `resources its state does not list, so the graph is missing them too. Resolve them with \`pulumi refresh\` ` +
          `(or export, edit and \`pulumi stack import\`), then export the stack again.`,
        lexicon: "pulumi",
      },
    ];
  },
};
