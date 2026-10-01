/**
 * The live link checks, WSP141 and WSP142 (#2549; #2524 D6, ws-062).
 *
 * `chant workspace check --live --env <env>` resolves each declared member
 * link against what its producer's estate publishes now. It reads the live
 * graph the way `chant workspace graph --live --env <env>` does: each `chant`
 * member runs `chant graph --live` under its own toolchain, and the outputs of
 * the live graph (the stack outputs a lexicon's live read reports) are the
 * names a link may match, exactly. That is the one place this command reaches
 * a network, through the member's own chant, with the member's own
 * credentials. Without `--live` none of this runs, and the source checks
 * (`./links.ts`) stay offline.
 *
 * | Id | Fails when |
 * |---|---|
 * | WSP141 | the producer was read live and publishes no output of that name |
 * | WSP142 | the link could not be resolved live: the producer's kind is not read live, its read failed, or the read returned no outputs at all |
 *
 * Only declared links of kind `output` are resolved live. A `telemetry` link
 * names a collector's pipeline or exporter, which the graph reports from the
 * member's source, so it is not part of this check.
 */

import type { WorkspaceCheck, WorkspaceDiagnostic } from "../checks";
import type { Declaration } from "../declaration";
import type { KindRegistry } from "../kinds";
import { DEFAULT_LINK_KIND, irMemberHandles, resolveLinks, type LinkRow } from "../links";

/** What a live read of the workspace found, for the live link checks. */
export interface LiveLinkFacts {
  env: string;
  /** Every declared `output` link, resolved against the live outputs. */
  rows: LinkRow[];
}

const describeLink = (row: LinkRow) => `${row.consumer}'s link to ${row.producer} output ${row.output}`;

/**
 * Read the live graph of the workspace at `cwd` for `env` and resolve the
 * declared links against it. `onStderr` gets each member's stderr, which is
 * where a lexicon's live read reports an account it could not reach.
 */
export async function gatherLiveLinkFacts(cwd: string, declaration: Declaration, kinds: KindRegistry, env: string, onStderr?: (text: string) => void): Promise<LiveLinkFacts> {
  const { workspaceGraph } = await import("../graph-cli");
  const { doc } = await workspaceGraph({ cwd, args: { live: true, env }, noCache: true, ...(onStderr ? { onStderr } : {}) });
  if ("error" in doc) {
    return { env, rows: unreadRows(declaration, `the live graph could not be read: ${doc.error.code}: ${doc.error.message}`) };
  }
  const read = new Map(doc.members.map((m) => [m.name, m]));
  const composed = doc.members.filter((m) => m.status === "composed").map((m) => m.name);
  const handles = irMemberHandles({ composed, exports: doc.exports, imports: doc.imports });
  const table = resolveLinks(declaration, handles);
  const rows: LinkRow[] = [];
  for (const r of table) {
    if (r.status === "ambiguous" || r.origin !== "declared" || r.kind !== DEFAULT_LINK_KIND) continue;
    const row: LinkRow = { ...r, resolves: "live" };
    if (row.status !== "invalid") {
      const producer = read.get(row.producer);
      const kind = kinds.get(declaration.members.find((m) => m.name === row.producer)?.kind ?? "");
      if (!producer || producer.status !== "composed") {
        row.status = "unresolved";
        row.reason =
          producer?.reason?.message ??
          (kind ? `${row.producer} is kind ${kind.name}, which chant does not read live` : `${row.producer} was not read live`);
      } else if (row.status === "missing" && !doc.exports.some((e) => e.member === row.producer)) {
        row.status = "unresolved";
        row.reason = `the live read of ${row.producer} returned no outputs: the account may be unreachable, or its lexicon reports none`;
      } else if (row.status === "missing") {
        row.reason = row.reason?.replace(/^(\S+) has no output/, "$1 publishes no output") ?? row.reason;
      }
    }
    rows.push(row);
  }
  return { env, rows };
}

/** Every declared output link as unresolved, when the live graph could not be read at all. */
function unreadRows(declaration: Declaration, reason: string): LinkRow[] {
  return resolveLinks(declaration, new Map())
    .filter((r): r is LinkRow => r.status !== "ambiguous" && r.origin === "declared" && r.kind === DEFAULT_LINK_KIND)
    .map((r) => ({ ...r, resolves: "live", ...(r.status === "invalid" ? {} : { status: "unresolved" as const, reason }) }));
}

function liveFinding(check: WorkspaceCheck, row: LinkRow, message: string): WorkspaceDiagnostic {
  return { checkId: check.id, severity: check.severity, message, entity: row.consumer, pointer: `${row.pointer}/output` };
}

export const LIVE_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: "WSP141",
    name: "link-live-missing",
    description: "With --live, a member link names an output its producer's estate publishes now, matched exactly. A producer whose declared output isn't deployed yet, or was renamed in the estate, fails this for every consumer.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      return (ctx.facts?.live?.rows ?? [])
        .filter((r) => r.status === "missing")
        .map((r) => liveFinding(this, r, `${describeLink(r)} does not resolve live in ${ctx.facts!.live!.env}: ${r.reason}`));
    },
  },
  {
    id: "WSP142",
    name: "link-live-unresolved",
    description: "With --live, a member link that could not be resolved against a live read is kept, unresolved, and reported: the producer's kind is not read live, its read failed, or the read returned no outputs.",
    severity: "info",
    configurable: true,
    check(ctx) {
      return (ctx.facts?.live?.rows ?? [])
        .filter((r) => r.status === "unresolved")
        .map((r) => liveFinding(this, r, `${describeLink(r)} is kept unresolved in ${ctx.facts!.live!.env}: ${r.reason}`));
    },
  },
];
