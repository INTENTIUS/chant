/**
 * The member-link checks, WSP091 to WSP097 (#2539; #2524 D6, ws-008).
 *
 * `chant workspace check` resolves every declared link in source: the
 * producer's outputs come from its kind, and a `chant` producer's are read
 * from its TypeScript without running it (`../member-handles.ts`). Nothing
 * here reaches the network or starts a process. The rows themselves come
 * from `../links.ts`, which `chant workspace graph` shares.
 *
 * | Id | Fails when |
 * |---|---|
 * | WSP091 | a link names no member, an example group, or its own member (fixed) |
 * | WSP092 | a link's kind is not a link kind chant knows (fixed) |
 * | WSP093 | the producer exposes no output of that name, as when it was renamed |
 * | WSP094 | the producer's outputs can't be read in source, so the link is kept unresolved |
 * | WSP095 | an inferred join is ambiguous: a parameter matches two or more outputs |
 * | WSP096 | a consumer states the same link twice |
 * | WSP097 | an entry lists `outputs` for a kind that doesn't take them from the entry |
 * | WSP098 | a link states a `protocol` and its kind is not `telemetry` (#2558) |
 * | WSP099 | a kind's link reader could not read part of a member's files without guessing (#3932) |
 *
 * Links a kind's reader finds in a member's own files (#3932), such as a dbt
 * project's sources, are checked by WSP093 to WSP095 like declared ones, and
 * their findings name the member's file and line instead of the declaration.
 */

import type { WorkspaceCheck, WorkspaceCheckContext, WorkspaceDiagnostic } from "../checks";
import type { Member } from "../declaration";
import { sourceMemberHandles } from "../member-handles";
import { readKindLinks, type KindLinkRead } from "../kind-link-readers";
import { DEFAULT_LINK_KIND, LINK_KINDS, TELEMETRY_LINK_KIND, linkTargetProblem, resolveLinks, type AmbiguousRow, type LinkRow, type LinkTableRow } from "../links";

const tables = new WeakMap<WorkspaceCheckContext, LinkTableRow[]>();
const reads = new WeakMap<WorkspaceCheckContext, Map<string, KindLinkRead>>();

/** What each member's kind reader found (#3932), read once per check run. */
function kindReads(ctx: WorkspaceCheckContext): Map<string, KindLinkRead> {
  let read = reads.get(ctx);
  if (!read) {
    read = readKindLinks(ctx.declaration, ctx.tree, ctx.kinds);
    reads.set(ctx, read);
  }
  return read;
}

/** The link rows for a check run, resolved once and shared by every link check. */
export function linkTable(ctx: WorkspaceCheckContext): LinkTableRow[] {
  let rows = tables.get(ctx);
  if (!rows) {
    rows = resolveLinks(ctx.declaration, sourceMemberHandles(ctx.declaration, ctx.tree, ctx.groups, ctx.kinds, ctx.facts?.lexiconOutputs), undefined, kindReads(ctx));
    tables.set(ctx, rows);
  }
  return rows;
}

/** The declared links, and the links a kind's reader found: the rows a member states. */
const statedRows = (ctx: WorkspaceCheckContext) => linkTable(ctx).filter((r): r is LinkRow => r.status !== "ambiguous" && r.origin !== "inferred:joinKey");

/** A finding at a declared link's field in the declaration, or at the file and line a reader's link came from. */
function linkFinding(check: WorkspaceCheck, ctx: WorkspaceCheckContext, row: LinkTableRow, field: string, message: string): WorkspaceDiagnostic {
  const base = { checkId: check.id, severity: check.severity, message, entity: row.consumer };
  if (row.origin === "kind-reader" && row.file !== undefined) {
    const member = ctx.declaration.members.find((m) => m.name === row.consumer);
    return { ...base, pointer: member?.pointer ?? "", treeFile: row.file, line: row.line ?? 1, column: 1 };
  }
  return { ...base, pointer: `${(row as LinkRow).pointer}/${field}` };
}

/** Where a reader's link came from, for its message; empty for a declared link. */
const statedAt = (row: LinkRow) => (row.origin === "kind-reader" ? ` (read by ${row.reader} from ${row.file}:${row.line})` : "");

const describeLink = (row: LinkRow) => `${row.consumer}'s link to ${row.producer} output ${row.output}`;

export const LINK_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: "WSP091",
    name: "link-target-unknown",
    description: "Every member link names another member of the workspace. A link to an unknown name, an example group or the consumer itself fails closed.",
    severity: "error",
    configurable: false,
    check(ctx) {
      return ctx.declaration.members.flatMap((m) =>
        m.links.flatMap((l) => {
          const problem = linkTargetProblem(ctx.declaration, m, l);
          return problem ? [{ checkId: this.id, severity: this.severity, message: problem, entity: m.name, pointer: `${l.pointer}/member` }] : [];
        }),
      );
    },
  },
  {
    id: "WSP092",
    name: "link-kind-unknown",
    description: `Every member link's kind is one chant knows. Unknown link kinds fail closed; ${DEFAULT_LINK_KIND} is the default, and ${LINK_KINDS.filter((k) => k !== DEFAULT_LINK_KIND).join(", ")} is the other.`,
    severity: "error",
    configurable: false,
    check(ctx) {
      return ctx.declaration.members.flatMap((m) =>
        m.links
          .filter((l) => l.kind !== null && !(LINK_KINDS as readonly string[]).includes(l.kind))
          .map((l) => ({
            checkId: this.id,
            severity: this.severity,
            message: `member ${m.name}'s link to ${l.member} has kind ${l.kind}, which is not a link kind chant knows; known link kinds: ${LINK_KINDS.join(", ")}`,
            entity: m.name,
            pointer: `${l.pointer}/kind`,
          })),
      );
    },
  },
  {
    id: "WSP093",
    name: "link-output-missing",
    description: "Every member link names an output its producer exposes, matched exactly. A producer that renames an output fails this for every consumer that links to the old name.",
    severity: "error",
    configurable: true,
    check(ctx) {
      return statedRows(ctx)
        .filter((r) => r.status === "missing")
        .map((r) => linkFinding(this, ctx, r, "output", `${describeLink(r)}${statedAt(r)} does not resolve: ${r.reason}`));
    },
  },
  {
    id: "WSP094",
    name: "link-unresolved",
    description: "A member link whose producer's outputs can't be read in source is kept, unresolved, and reported.",
    severity: "info",
    configurable: true,
    check(ctx) {
      return statedRows(ctx)
        .filter((r) => r.status === "unresolved")
        .map((r) => linkFinding(this, ctx, r, "output", `${describeLink(r)}${statedAt(r)} is kept unresolved: ${r.reason}`));
    },
  },
  {
    id: "WSP095",
    name: "join-ambiguous",
    description: "No inferred join is ambiguous: a parameter that matches outputs of two producers (or two outputs of one) needs a declared link saying which.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const byName = new Map(ctx.declaration.members.map((m) => [m.name, m]));
      return linkTable(ctx)
        .filter((r): r is AmbiguousRow => r.status === "ambiguous")
        .map((r) => {
          if (r.origin === "kind-reader") {
            const choices = r.candidates.map((c) => c.producer).join(", ");
            return linkFinding(this, ctx, r, "", `${r.consumer}'s link to ${r.input} (read by ${r.reader}) has no single producer: ${r.reason}${choices ? `. Candidates: ${choices}` : ""}`);
          }
          const choices = r.candidates.map((c) => `${c.producer} output ${c.output} (${c.label})`).join(", ");
          const first = r.candidates[0];
          return {
            checkId: this.id,
            severity: this.severity,
            message: `${r.reason}: ${choices}. Declare the one it reads, such as { "member": "${first.producer}", "output": "${first.output}" } in ${r.consumer}'s links`,
            entity: r.consumer,
            pointer: byName.get(r.consumer)!.pointer,
          };
        });
    },
  },
  {
    id: "WSP096",
    name: "link-duplicate",
    description: "A link is stated once: no consumer lists the same member and output twice.",
    severity: "error",
    configurable: true,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      for (const m of ctx.declaration.members) {
        const seen = new Map<string, string>();
        for (const l of m.links) {
          const key = `${l.member}\0${l.output}\0${l.kind ?? DEFAULT_LINK_KIND}`;
          const first = seen.get(key);
          if (first) {
            out.push({
              checkId: this.id,
              severity: this.severity,
              message: `member ${m.name} links to ${l.member} output ${l.output} twice; the first is at ${first}`,
              entity: m.name,
              pointer: l.pointer,
            });
          } else {
            seen.set(key, l.pointer);
          }
        }
      }
      return out;
    },
  },
  {
    id: "WSP097",
    name: "outputs-not-listable",
    description: "An entry lists outputs only when its kind takes them from the entry: other, or a kind from a package. A chant member's outputs are read from its source, and a nested workspace exposes none.",
    severity: "error",
    configurable: true,
    check(ctx) {
      return ctx.declaration.members
        .filter((m): m is Member & { outputs: string[] } => m.outputs !== null)
        .flatMap((m) => {
          const kind = ctx.kinds.get(m.kind);
          if (!kind || kind.outputs.from === "declared") return [];
          const why = kind.outputs.from === "chant-source" ? "reads a member's outputs from its source" : "exposes no outputs";
          return [
            {
              checkId: this.id,
              severity: this.severity,
              message: `member ${m.name} lists outputs, and kind ${m.kind} ${why}; remove the list`,
              entity: m.name,
              pointer: `${m.pointer}/outputs`,
            },
          ];
        });
    },
  },
  {
    id: "WSP098",
    name: "link-protocol-misplaced",
    description: "A link states a protocol only when it is a telemetry link: protocol is the OTLP protocol the consumer sends to the producer's collector, and no other link kind has one.",
    severity: "error",
    configurable: true,
    check(ctx) {
      return ctx.declaration.members.flatMap((m) =>
        m.links
          .filter((l) => l.protocol !== null && (l.kind ?? DEFAULT_LINK_KIND) !== TELEMETRY_LINK_KIND)
          .map((l) => ({
            checkId: this.id,
            severity: this.severity,
            message: `member ${m.name}'s link to ${l.member} output ${l.output} states protocol ${l.protocol}, and its kind is ${l.kind ?? DEFAULT_LINK_KIND}; protocol belongs to a ${TELEMETRY_LINK_KIND} link`,
            entity: m.name,
            pointer: `${l.pointer}/protocol`,
          })),
      );
    },
  },
  {
    id: "WSP099",
    name: "kind-reader-gap",
    description:
      "A kind's link reader read every link in a member's files that it could read without guessing (#3932). A value it would have to render, such as a Jinja template in a dbt source, is reported here with its file and line, and the links it would state are not checked.",
    severity: "info",
    configurable: true,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      for (const [member, read] of kindReads(ctx)) {
        const pointer = ctx.declaration.members.find((m) => m.name === member)?.pointer ?? "";
        for (const gap of read.gaps) {
          out.push({ checkId: this.id, severity: this.severity, message: `${member} (read by ${read.reader}): ${gap.message}`, entity: member, pointer, treeFile: gap.file, line: gap.line, column: 1 });
        }
      }
      return out;
    },
  },
];
