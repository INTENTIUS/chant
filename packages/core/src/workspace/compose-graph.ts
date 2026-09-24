/**
 * The composed workspace IR that `chant workspace graph` prints (#2537, #2524
 * D8, ws-009, ws-018, ws-022).
 *
 * Each member is read through its own `chant graph --format ir`, under its
 * own toolchain. This module takes those documents and composes them:
 *
 * - Every node id becomes `<member>/<id>`. Member names can't hold `/`, and
 *   `::` keeps its meaning for stacks inside a member (`app/web::Bucket`).
 *   Edge ends, `$ref` values in attributes, `compositeInstance`,
 *   `runtimeOwner` and export and import nodes are rewritten the same way.
 * - `groups.byMember` maps each member to its node ids. `byLexicon` and
 *   `byComposite` keep their keys (a lexicon or composite type is the same
 *   thing in every member) and merge the ids. `byStack`, `byContainer` and
 *   `byWave` name things inside one member, so their keys are prefixed too.
 * - `links` holds the member links (#2524 D6, #2539): the declared links and
 *   the joins inferred from members' `imports` and `exports` with the core
 *   `joinKey()`, labelled `exact` or `folded` (`./links.ts`). A declared link
 *   suppresses the inferred edge it covers. `records` is the section record
 *   kinds fill (#2524 D4), empty so far.
 *
 * A member's IR with no `version` field comes from a chant older than #2529.
 * It is version 1, and it is upgraded in place by stamping that version. An IR
 * newer than {@link GRAPH_IR_VERSION} can't be read safely, so that member is
 * listed with a reason code and left out, like any other member that can't be
 * read (#2524 D15).
 *
 * `chant graph` itself is untouched: this is the only place members compose.
 */

import type { Declaration } from "./declaration";
import type { KindRegistry } from "./kinds";
import { graphLinks, type LinkTableRow } from "./links";
import type { ReasonCode } from "./reason-codes";
import { GRAPH_IR_VERSION, type GraphIR, type IRExport, type IRGroups, type IRImport, type IREdge, type IRNode } from "../graph-ir";

/** The version of the composed document `chant workspace graph` writes. */
export const WORKSPACE_GRAPH_VERSION = 1;

/**
 * Why a member is missing from the composed graph, or from any per-member
 * run. Closed, like the `ls` reason codes: a new code is a contract change.
 */
export const MEMBER_RUN_REASON_CODES = [
  /** The member's kind is one the workspace commands don't run, such as `other`. */
  "kind-not-run",
  /** The member's directory does not exist. */
  "dir-missing",
  /** No installed kind has the member's kind name. */
  "unknown-kind",
  /** The directory is not what its kind reads. */
  "kind-probe-failed",
  /** The member's command exited with a failure. */
  "command-failed",
  /** The member's command printed something that isn't the document asked for. */
  "output-unreadable",
  /** The member's IR has a version this chant can't read. */
  "ir-version-unsupported",
] as const satisfies readonly ReasonCode[];
export type MemberRunReasonCode = (typeof MEMBER_RUN_REASON_CODES)[number];

export interface MemberReason {
  code: MemberRunReasonCode;
  message: string;
}

export interface ComposedMember {
  name: string;
  dir: string;
  kind: string;
  status: "composed" | "skipped" | "failed";
  reason: MemberReason | null;
  /** The chant version that read the member, when its toolchain said. */
  chant: string | null;
  /** The IR version the member printed; `null` when it printed none and was upgraded as version 1. */
  irVersion: number | null;
  /** Whole-read facts the member's IR carried (`meta`, `pipeline`), kept apart from the composed sections. */
  meta?: Record<string, unknown>;
  pipeline?: unknown;
}

export type ComposedNode = IRNode & { member: string };
export type ComposedEdge = IREdge & { member: string };

export interface WorkspaceGraph {
  version: number;
  workspace: { name: string; root: string };
  members: ComposedMember[];
  nodes: ComposedNode[];
  edges: ComposedEdge[];
  groups: IRGroups & { byMember: Record<string, string[]> };
  exports: (IRExport & { member: string })[];
  imports: (IRImport & { member: string })[];
  derivedAttrs?: Record<string, string[]>;
  /** Member links (#2524 D6, #2539), declared and inferred. Empty when no declaration is given. */
  links: LinkTableRow[];
  /** Record sections (#2524 D4). Empty until record kinds join the graph. */
  records: unknown[];
}

/** Read one member's `chant graph --format ir` output, upgrading an unversioned (v1) IR in place. */
export function readMemberIr(text: string): { ir: GraphIR; irVersion: number | null } | { reason: MemberReason } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { reason: { code: "output-unreadable", message: "chant graph --format ir printed something that is not JSON" } };
  }
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as GraphIR).nodes) || !Array.isArray((raw as GraphIR).edges)) {
    return { reason: { code: "output-unreadable", message: "chant graph --format ir printed JSON with no nodes and edges" } };
  }
  const ir = raw as GraphIR;
  const printed = ir.version;
  if (printed === undefined) {
    ir.version = 1;
  } else if (typeof printed !== "number" || printed > GRAPH_IR_VERSION) {
    return {
      reason: {
        code: "ir-version-unsupported",
        message: `the member's chant printed IR version ${String(printed)}, and this chant reads up to version ${GRAPH_IR_VERSION}`,
      },
    };
  }
  ir.groups ??= {};
  return { ir, irVersion: printed === undefined ? null : printed };
}

export interface ComposeInput {
  member: ComposedMember;
  /** Present for a member whose IR was read. */
  ir?: GraphIR;
}

const prefix = (member: string, id: string): string => `${member}/${id}`;

function prefixRefs(value: unknown, member: string): unknown {
  if (Array.isArray(value)) return value.map((v) => prefixRefs(v, member));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === "$ref" && typeof v === "string" ? prefix(member, v) : prefixRefs(v, member);
  }
  return out;
}

function mergeInto(target: Record<string, string[]>, key: string, ids: string[]): void {
  (target[key] ??= []).push(...ids);
}

function sorted(rec: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(rec).sort()) out[k] = [...rec[k]].sort();
  return out;
}

/**
 * Compose the members' IRs into the workspace document. Members keep the
 * order they are given in. With `links`, the `links` section is filled from
 * the declaration; `kinds` lets a member that isn't composed but whose kind
 * lists its outputs (`other`, kinds from a package) be a link target.
 */
export function composeWorkspaceGraph(
  workspace: { name: string; root: string },
  inputs: ComposeInput[],
  links?: { declaration: Declaration; kinds?: KindRegistry },
): WorkspaceGraph {
  const nodes: ComposedNode[] = [];
  const edges: ComposedEdge[] = [];
  const exports: WorkspaceGraph["exports"] = [];
  const imports: WorkspaceGraph["imports"] = [];
  const byMember: Record<string, string[]> = {};
  const shared: Record<"byLexicon" | "byComposite", Record<string, string[]>> = { byLexicon: {}, byComposite: {} };
  const scoped: Record<"byStack" | "byContainer" | "byWave", Record<string, string[]>> = { byStack: {}, byContainer: {}, byWave: {} };
  const derivedAttrs: Record<string, Set<string>> = {};

  for (const { member, ir } of inputs) {
    if (!ir) continue;
    const m = member.name;
    const ids: string[] = [];
    for (const node of ir.nodes) {
      const composed: ComposedNode = { ...node, id: prefix(m, node.id), member: m, attrs: prefixRefs(node.attrs ?? {}, m) as Record<string, unknown> };
      if (node.compositeInstance) composed.compositeInstance = prefix(m, node.compositeInstance);
      if (node.runtimeOwner) composed.runtimeOwner = prefix(m, node.runtimeOwner);
      nodes.push(composed);
      ids.push(composed.id);
    }
    byMember[m] = ids.sort();
    for (const edge of ir.edges) edges.push({ ...edge, from: prefix(m, edge.from), to: prefix(m, edge.to), member: m });
    for (const key of ["byLexicon", "byComposite"] as const) {
      for (const [k, v] of Object.entries(ir.groups[key] ?? {})) mergeInto(shared[key], k, v.map((id) => prefix(m, id)));
    }
    for (const key of ["byStack", "byContainer", "byWave"] as const) {
      for (const [k, v] of Object.entries(ir.groups[key] ?? {})) mergeInto(scoped[key], prefix(m, k), v.map((id) => prefix(m, id)));
    }
    for (const e of ir.exports ?? []) exports.push({ ...e, ...(e.node ? { node: prefix(m, e.node) } : {}), member: m });
    for (const i of ir.imports ?? []) imports.push({ ...i, node: prefix(m, i.node), member: m });
    for (const [kind, attrs] of Object.entries(ir.derivedAttrs ?? {})) for (const a of attrs) (derivedAttrs[kind] ??= new Set()).add(a);
    if (ir.meta) member.meta = ir.meta;
    if (ir.pipeline) member.pipeline = ir.pipeline;
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  const edgeKey = (e: ComposedEdge) => `${e.from}\u0000${e.to}\u0000${e.viaAttr ?? ""}`;
  edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  const groups: WorkspaceGraph["groups"] = { byMember };
  for (const key of ["byLexicon", "byComposite"] as const) if (Object.keys(shared[key]).length) groups[key] = sorted(shared[key]);
  for (const key of ["byStack", "byContainer", "byWave"] as const) if (Object.keys(scoped[key]).length) groups[key] = sorted(scoped[key]);

  const doc: WorkspaceGraph = {
    version: WORKSPACE_GRAPH_VERSION,
    workspace,
    members: inputs.map((i) => i.member),
    nodes,
    edges,
    groups,
    exports,
    imports,
    links: links
      ? graphLinks(links.declaration, { composed: inputs.filter((i) => i.ir).map((i) => i.member.name), exports, imports }, links.kinds)
      : [],
    records: [],
  };
  if (Object.keys(derivedAttrs).length) {
    doc.derivedAttrs = Object.fromEntries(Object.keys(derivedAttrs).sort().map((k) => [k, [...derivedAttrs[k]].sort()]));
  }
  return doc;
}
