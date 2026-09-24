/**
 * `chant workspace graph --composites` (#2662): each composite instance the
 * workspace's members declare, joined to the components that can deploy it.
 *
 * The composed graph already knows which composite instances each member
 * declares (a node's `compositeInstance` and `compositeParent`), and a
 * member's `chant graph --components --format ir` knows its components and
 * the composite kinds each names in its contract's `composites`. This module
 * joins the two and prints the rows. chant supplies the data and never the
 * choice (ws-052): the document says how each component matched, and a
 * reader decides what to offer.
 *
 * A component matches an instance in one of two ways:
 *
 * - `composites`: the component's contract lists one of the instance's
 *   composite kinds, compared exactly.
 * - `name`: the component declares no `composites`, and its `name` joins the
 *   instance's kind or the instance's own name with the core `joinKey()`
 *   (`LoomBackend` and `loom-backend` join, labelled `folded`). This is the
 *   naming convention the component contract documents for a component that
 *   says nothing (#1492).
 *
 * Every match says how it crosses members (`via`): `member` when the
 * component and the instance are in the same member, `link` when the
 * component's member reads the instance's member through a resolved member
 * link (#2539), and `unlinked` otherwise. An instance with no component is
 * listed with an empty `components`, so the gap is visible.
 *
 * Each member runs under its own toolchain, as for `workspace graph`, and at
 * the same revision with `--at`. Nothing is written and no listener starts.
 */

import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { joinLabel, type JoinLabel } from "../join-key";
import type { ComposedMember, MemberReason, WorkspaceGraph } from "./compose-graph";
import { readMemberIr } from "./compose-graph";
import { GRAPH_ERROR_CODES, workspaceGraph, type GraphQuery } from "./graph-cli";
import type { LinkRow } from "./links";
import { emitDocument, type UnitResult } from "./member-commands";
import { readerVersion, type ErrorLocation, type WorkspaceErrorCode } from "./declaration";
import type { ReasonCode } from "./reason-codes";

/** `$id` of the JSON Schema for the document, shipped beside this file. */
export const COMPOSITES_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/composites/v1/composites.schema.json";

/** The read-contract version the document follows. */
export const COMPOSITES_CONTRACT_VERSION = 1;

/** Why the composites couldn't be read at all: the graph's codes. */
export const COMPOSITES_ERROR_CODES = GRAPH_ERROR_CODES;

/** Why the list is empty, or why no instance has a component. Closed: part of the read contract. */
export const COMPOSITES_REASON_CODES = [
  /** No member of kind chant was read, so nothing declares a composite or a component. */
  "composites-no-chant-member",
  /** The members read declare no composite instance. */
  "composites-none-declared",
  /** The members read declare no component, so no instance has one. */
  "composites-no-component",
] as const satisfies readonly ReasonCode[];
export type CompositesReasonCode = (typeof COMPOSITES_REASON_CODES)[number];

export interface CompositesMember {
  name: string;
  dir: string;
  kind: string;
  /** `read` when both its graph and its component graph were read. */
  status: "read" | "skipped" | "failed";
  reason: MemberReason | null;
  chant: string | null;
}

export interface ComponentEntry {
  /** `<member>/<name>`. */
  id: string;
  name: string;
  member: string;
  /** Declared or inferred; null when the member's chant does not print it. */
  archetype: string | null;
  /** The contract's `composites`, or null when it declares none. */
  composites: string[] | null;
  /** The component's file from the workspace root, when the member's chant names it. */
  file: string | null;
}

export interface ComponentMatch {
  /** The {@link ComponentEntry} id. */
  component: string;
  by: "composites" | "name";
  /** What was matched: one of the instance's kinds, or the instance's own name. */
  against: "kind" | "instance";
  value: string;
  label: JoinLabel;
  via: "member" | "link" | "unlinked";
}

export interface CompositeInstanceRow {
  /** `<member>/<instance>`, the composed graph's `compositeInstance`. */
  id: string;
  member: string;
  /** The instance's name in its member: the export name. */
  instance: string;
  /** The composite kinds its nodes came from; more than one when composites nest. */
  kinds: string[];
  lexicons: string[];
  /** The composed ids of its nodes. */
  nodes: string[];
  components: ComponentMatch[];
}

interface Head {
  $schema: string;
  contract: number;
  chant: string;
}

export type CompositesDocument =
  | (Head & {
      at: string | null;
      workspace: { name: string; root: string };
      members: CompositesMember[];
      composites: CompositeInstanceRow[];
      components: ComponentEntry[];
      reasons: { code: CompositesReasonCode; message: string }[];
      summary: { composites: number; withComponent: number; withoutComponent: number; components: number };
    })
  | (Head & { error: { code: WorkspaceErrorCode; message: string; location: ErrorLocation | null } });

export interface CompositesResult {
  doc: CompositesDocument;
  failed: boolean;
}

/** Read one member's component graph run into components, or the reason it can't be read. */
function readComponents(member: string, dir: string, run: UnitResult): { components: ComponentEntry[] } | { reason: MemberReason } {
  if (run.exitCode !== 0) {
    const tail = run.stderr.trim().split("\n").slice(-5).join("\n");
    return { reason: { code: "command-failed", message: `chant graph --components exited ${run.exitCode}${tail ? `: ${tail}` : ""}` } };
  }
  const read = readMemberIr(run.stdout);
  if ("reason" in read) return { reason: { ...read.reason, message: `chant graph --components: ${read.reason.message}` } };
  const components: ComponentEntry[] = [];
  for (const n of read.ir.nodes) {
    if (n.kind !== "Component") continue;
    const attrs = n.attrs ?? {};
    const composites = Array.isArray(attrs.composites) ? (attrs.composites as unknown[]).filter((c): c is string => typeof c === "string") : null;
    const file = n.sourceLoc?.file;
    components.push({
      id: `${member}/${n.id}`,
      name: n.id,
      member,
      archetype: typeof attrs.archetype === "string" ? attrs.archetype : null,
      composites: composites && composites.length > 0 ? composites : null,
      file: file ? (dir === "." ? file : `${dir}/${file}`) : null,
    });
  }
  return { components };
}

/** The composite instances in a composed graph, without their components. */
export function compositeInstances(graph: Pick<WorkspaceGraph, "nodes">): CompositeInstanceRow[] {
  const byId = new Map<string, { member: string; kinds: Set<string>; lexicons: Set<string>; nodes: string[] }>();
  for (const n of graph.nodes) {
    if (!n.compositeInstance) continue;
    const row = byId.get(n.compositeInstance) ?? { member: n.member, kinds: new Set(), lexicons: new Set(), nodes: [] };
    if (n.compositeParent) row.kinds.add(n.compositeParent);
    row.lexicons.add(n.lexicon);
    row.nodes.push(n.id);
    byId.set(n.compositeInstance, row);
  }
  return [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, r]) => ({
      id,
      member: r.member,
      instance: id.slice(r.member.length + 1),
      kinds: [...r.kinds].sort(),
      lexicons: [...r.lexicons].sort(),
      nodes: r.nodes.sort(),
      components: [],
    }));
}

/**
 * Join instances to components. `links` are the composed graph's member link
 * rows: a component crosses to another member's instance `via: "link"` when
 * its member is the consumer of a resolved link whose producer is the
 * instance's member.
 */
export function joinComponents(instances: CompositeInstanceRow[], components: ComponentEntry[], links: WorkspaceGraph["links"]): CompositeInstanceRow[] {
  const linked = new Set<string>();
  for (const r of links) {
    if ("consumer" in r && "producer" in r && (r as LinkRow).status === "resolved") linked.add(`${r.consumer}\u0000${(r as LinkRow).producer}`);
  }
  const via = (c: ComponentEntry, i: CompositeInstanceRow): ComponentMatch["via"] =>
    c.member === i.member ? "member" : linked.has(`${c.member}\u0000${i.member}`) ? "link" : "unlinked";

  return instances.map((i) => {
    const matches: ComponentMatch[] = [];
    for (const c of components) {
      if (c.composites) {
        const kind = i.kinds.find((k) => c.composites!.includes(k));
        if (kind) matches.push({ component: c.id, by: "composites", against: "kind", value: kind, label: "exact", via: via(c, i) });
        continue;
      }
      let match: Omit<ComponentMatch, "component" | "via"> | undefined;
      for (const k of i.kinds) {
        const label = joinLabel(c.name, k);
        if (label && (!match || (label === "exact" && match.label !== "exact"))) match = { by: "name", against: "kind", value: k, label };
      }
      if (!match) {
        const label = joinLabel(c.name, i.instance);
        if (label) match = { by: "name", against: "instance", value: i.instance, label };
      }
      if (match) matches.push({ component: c.id, ...match, via: via(c, i) });
    }
    matches.sort((a, b) => a.component.localeCompare(b.component));
    return { ...i, components: matches };
  });
}

function memberEntry(m: ComposedMember, componentReason: MemberReason | null): CompositesMember {
  const reason = m.reason ?? componentReason;
  const status = m.status === "composed" ? (componentReason ? "failed" : "read") : m.status;
  return { name: m.name, dir: m.dir, kind: m.kind, status, reason, chant: m.chant };
}

/** Read the workspace's composites and components, and build the document. Never throws a `WorkspaceReadError`. */
export async function workspaceComposites(query: Omit<GraphQuery, "kind" | "components">): Promise<CompositesResult> {
  const head: Head = { $schema: COMPOSITES_OUTPUT_SCHEMA_ID, contract: COMPOSITES_CONTRACT_VERSION, chant: readerVersion() };
  const { doc: graph, failed, components: runs } = await workspaceGraph({ ...query, components: true });
  if ("error" in graph) return { doc: { ...head, error: graph.error }, failed: true };

  const byMember = new Map((runs ?? []).map((r) => [r.unit.member, r]));
  const members: CompositesMember[] = [];
  const components: ComponentEntry[] = [];
  let componentsFailed = false;
  for (const m of graph.members) {
    const run = m.status === "composed" ? byMember.get(m.name) : undefined;
    let reason: MemberReason | null = null;
    if (run) {
      const read = readComponents(m.name, m.dir, run);
      if ("reason" in read) {
        reason = read.reason;
        componentsFailed = true;
      } else components.push(...read.components);
    }
    members.push(memberEntry(m, reason));
  }
  components.sort((a, b) => a.id.localeCompare(b.id));

  const composites = joinComponents(compositeInstances(graph), components, graph.links);
  const read = members.filter((m) => m.status === "read");
  const reasons: { code: CompositesReasonCode; message: string }[] = [];
  if (!members.some((m) => m.kind === "chant" && m.status !== "skipped")) {
    reasons.push({ code: "composites-no-chant-member", message: "no member of kind chant was read, so nothing declares a composite or a component" });
  } else if (read.length > 0) {
    const names = read.map((m) => m.name).join(", ");
    if (composites.length === 0) reasons.push({ code: "composites-none-declared", message: `the members read (${names}) declare no composite instance` });
    if (components.length === 0) reasons.push({ code: "composites-no-component", message: `the members read (${names}) declare no component in a *.component.ts file` });
  }
  const withComponent = composites.filter((c) => c.components.length > 0).length;
  return {
    doc: {
      ...head,
      at: graph.at,
      workspace: graph.workspace,
      members,
      composites,
      components,
      reasons,
      summary: { composites: composites.length, withComponent, withoutComponent: composites.length - withComponent, components: components.length },
    },
    failed: failed || componentsFailed,
  };
}

/** `chant workspace graph --composites`: print the document as JSON, always, like the composed graph. */
export async function runWorkspaceComposites(ctx: CommandContext, cwd: string): Promise<number> {
  const { args } = ctx;
  const { doc, failed } = await workspaceComposites({
    cwd,
    at: args.at,
    members: args.members,
    args,
    onStderr: (text) => process.stderr.write(text),
  });
  emitDocument(doc, args.output);
  if ("error" in doc) {
    const l = doc.error.location;
    console.error(formatError({ message: `${doc.error.code}: ${l ? `${l.file}:${l.line}:${l.column}: ` : ""}${doc.error.message}` }));
  }
  return failed ? 1 : 0;
}
