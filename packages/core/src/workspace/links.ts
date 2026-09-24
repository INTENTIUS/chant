/**
 * Member links (#2524 D6, #2539; ws-008).
 *
 * A member link is stated once, on the consumer, as `{member, output}`, and it
 * is matched exactly against the outputs the producer exposes. Which outputs
 * a member exposes is up to its kind ({@link KindOutputs}): a `chant` member's
 * are read from its source, a nested workspace exposes none, and `other` and
 * kinds from a package expose what the kind and the entry list.
 *
 * A join nobody wrote down is inferred: a `chant` consumer's parameter is
 * matched to other members' outputs with the core {@link joinKey}, and the
 * join is labelled `exact` or `folded`. A parameter that matches two or more
 * outputs is an ambiguity row, not an edge. A declared link from the same
 * consumer to one of the matched outputs settles it: the inferred rows for
 * that parameter give way to the declared one, which is how an inferred edge
 * is promoted.
 *
 * Every row says how it was found (`declared` or `inferred:joinKey`), where it
 * resolved (`source`; `check --live` comes later) and its status. A link that
 * can't be resolved is kept, with the reason.
 *
 * {@link resolveLinks} takes the members' handles as plain data, so the same
 * rules serve `chant workspace check`, which reads the handles from source
 * (`sourceMemberHandles` in `./member-handles.ts`, which loads the TypeScript
 * parser), and `chant workspace graph`, which reads
 * them from each member's graph IR ({@link irMemberHandles}).
 */

import { joinKey, joinLabel, type JoinLabel } from "../join-key";
import type { Declaration, LinkDeclaration, Member } from "./declaration";
import type { KindRegistry, MemberKind } from "./kinds";

/** The link kinds chant knows. Closed: a link of any other kind fails closed. */
export const LINK_KINDS = ["output"] as const;
export const DEFAULT_LINK_KIND = "output";

/** How a row was found: written down, or inferred by the named rule. */
export type LinkOrigin = "declared" | "inferred:joinKey";

/** One output or parameter of a member, as a join sees it. */
export interface JoinHandle {
  name: string;
  /** The node that holds it, when the reader knows one (a graph IR id). */
  node?: string;
}

/** What a member offers links, and what it reads. */
export interface MemberHandles {
  member: string;
  outputs: JoinHandle[];
  /** Parameters a join may feed. Only `chant` members have them. */
  inputs: JoinHandle[];
  /**
   * Whether `outputs` is every output the member exposes. When it isn't, a
   * link to a name not in the list is unresolved, not missing.
   */
  complete: boolean;
  /** Why the list is incomplete, or why the member exposes none. */
  why: string | null;
  /** True when the member's kind exposes no outputs at all. */
  exposesNone: boolean;
}

interface RowBase {
  consumer: string;
  kind: string;
  origin: LinkOrigin;
  resolves: "source";
  /** Why the row is not `resolved`, or null. */
  reason: string | null;
}

/** A declared link, or an inferred join with one producer. */
export interface LinkRow extends RowBase {
  status: "resolved" | "missing" | "unresolved" | "invalid";
  producer: string;
  output: string;
  /** `exact` for every declared link; `exact` or `folded` for an inferred one. */
  label: JoinLabel;
  /** The consumer's parameter an inferred join feeds; null for a declared link. */
  input: string | null;
  /** The consumer's parameter node and the producer's output node, when known. */
  from?: string;
  to?: string;
  /** The declared link's JSON Pointer in the declaration. */
  pointer?: string;
}

/** A parameter that joins outputs of two or more producers (or two outputs of one). */
export interface AmbiguousRow extends RowBase {
  status: "ambiguous";
  input: string;
  from?: string;
  candidates: { producer: string; output: string; label: JoinLabel; to?: string }[];
}

export type LinkTableRow = LinkRow | AmbiguousRow;

/** A link between two members, in the shape the pipeline checks read (#2542). */
export interface MemberLinkPair {
  consumer: string;
  producer: string;
}

/**
 * The member pairs the declaration links, consumer first, once each, in
 * declaration order. Only links to a declared member other than the consumer
 * count.
 */
export function declaredMemberLinks(declaration: Declaration): MemberLinkPair[] {
  const names = new Set(declaration.members.map((m) => m.name));
  const seen = new Set<string>();
  const out: MemberLinkPair[] = [];
  for (const m of declaration.members) {
    for (const l of m.links) {
      const key = `${m.name}\0${l.member}`;
      if (l.member === m.name || !names.has(l.member) || seen.has(key)) continue;
      seen.add(key);
      out.push({ consumer: m.name, producer: l.member });
    }
  }
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Why a declared link's target is not a member it may name, or undefined. */
export function linkTargetProblem(declaration: Declaration, consumer: Member, link: LinkDeclaration): string | undefined {
  if (link.member === consumer.name) return `member ${consumer.name} links to itself; a link joins two members`;
  const entry = declaration.entries.find((e) => e.name === link.member);
  if (!entry) return `member ${consumer.name} links to ${link.member}, which is not a member of this workspace`;
  if (entry.type === "group") return `member ${consumer.name} links to ${link.member}, which is an example group; a group has no links`;
  return undefined;
}

/** Output names that fold to the same key as `name`, for a "did you mean" hint. */
function nearNames(name: string, outputs: JoinHandle[]): string[] {
  const key = joinKey(name);
  return [...new Set(outputs.filter((o) => o.name !== name && joinKey(o.name) === key).map((o) => o.name))].sort(cmp);
}

/**
 * Resolve every declared link and infer the joins nobody wrote down.
 * `handles` holds one entry per member whose handles were read; a member
 * missing from it is unresolved. Declared rows come first, in declaration
 * order; inferred and ambiguous rows follow, sorted by consumer and parameter.
 */
export function resolveLinks(declaration: Declaration, handles: ReadonlyMap<string, MemberHandles>): LinkTableRow[] {
  const rows: LinkTableRow[] = [];
  const declaredTargets = new Map<string, Set<string>>();

  for (const consumer of declaration.members) {
    for (const link of consumer.links) {
      const kind = link.kind ?? DEFAULT_LINK_KIND;
      const row: LinkRow = {
        consumer: consumer.name,
        producer: link.member,
        output: link.output,
        kind,
        origin: "declared",
        label: "exact",
        input: null,
        resolves: "source",
        status: "resolved",
        reason: null,
        pointer: link.pointer,
      };
      rows.push(row);
      const targetProblem = linkTargetProblem(declaration, consumer, link);
      if (targetProblem) {
        row.status = "invalid";
        row.reason = targetProblem;
        continue;
      }
      (declaredTargets.get(consumer.name) ?? declaredTargets.set(consumer.name, new Set()).get(consumer.name)!).add(`${link.member}\0${link.output}`);
      if (!(LINK_KINDS as readonly string[]).includes(kind)) {
        row.status = "invalid";
        row.reason = `the link kind ${kind} is not one chant knows; known link kinds: ${LINK_KINDS.join(", ")}`;
        continue;
      }
      const producer = handles.get(link.member);
      const found = producer?.outputs.find((o) => o.name === link.output);
      if (found) {
        if (found.node) row.to = found.node;
        continue;
      }
      if (!producer) {
        row.status = "unresolved";
        row.reason = `the outputs of ${link.member} were not read`;
      } else if (producer.exposesNone) {
        row.status = "missing";
        row.reason = producer.why ?? `${link.member} exposes no outputs`;
      } else if (!producer.complete) {
        row.status = "unresolved";
        row.reason = `${link.output} was not found in ${link.member}, whose outputs could not all be read in source${producer.why ? ` (${producer.why})` : ""}`;
      } else {
        const near = nearNames(link.output, producer.outputs);
        const known = producer.outputs.map((o) => o.name);
        row.status = "missing";
        row.reason =
          `${link.member} has no output ${link.output}` +
          (near.length ? `; did you mean ${near.join(" or ")}? Links match exactly` : "") +
          (known.length ? `; its outputs: ${[...new Set(known)].sort(cmp).join(", ")}` : "; it exposes no outputs");
      }
    }
  }

  // Inferred joins: a consumer's parameter against every other member's outputs.
  const inferred: LinkTableRow[] = [];
  for (const consumer of declaration.members) {
    const mine = handles.get(consumer.name);
    if (!mine) continue;
    const declared = declaredTargets.get(consumer.name) ?? new Set<string>();
    for (const input of mine.inputs) {
      const candidates: { producer: string; output: string; label: JoinLabel; to?: string }[] = [];
      for (const producer of declaration.members) {
        if (producer.name === consumer.name) continue;
        for (const o of handles.get(producer.name)?.outputs ?? []) {
          const label = joinLabel(input.name, o.name);
          if (!label) continue;
          if (candidates.some((c) => c.producer === producer.name && c.output === o.name)) continue;
          candidates.push({ producer: producer.name, output: o.name, label, ...(o.node ? { to: o.node } : {}) });
        }
      }
      if (candidates.length === 0) continue;
      // A declared link to one of the matches settles the parameter.
      if (candidates.some((c) => declared.has(`${c.producer}\0${c.output}`))) continue;
      const base = { consumer: consumer.name, kind: DEFAULT_LINK_KIND, origin: "inferred:joinKey" as const, resolves: "source" as const };
      if (candidates.length === 1) {
        const c = candidates[0];
        inferred.push({
          ...base,
          status: "resolved",
          reason: null,
          producer: c.producer,
          output: c.output,
          label: c.label,
          input: input.name,
          ...(input.node ? { from: input.node } : {}),
          ...(c.to ? { to: c.to } : {}),
        });
      } else {
        candidates.sort((a, b) => cmp(a.producer, b.producer) || cmp(a.output, b.output));
        const producers = new Set(candidates.map((c) => c.producer));
        inferred.push({
          ...base,
          status: "ambiguous",
          reason:
            producers.size > 1
              ? `parameter ${input.name} of ${consumer.name} matches outputs of ${[...producers].join(" and ")}`
              : `parameter ${input.name} of ${consumer.name} matches ${candidates.map((c) => c.output).join(" and ")} of ${candidates[0].producer}`,
          input: input.name,
          ...(input.node ? { from: input.node } : {}),
          candidates,
        });
      }
    }
  }
  inferred.sort((a, b) => cmp(a.consumer, b.consumer) || cmp(a.input ?? "", b.input ?? ""));
  return [...rows, ...inferred];
}

// ── Where the handles come from ──────────────────────────────────────────────

/**
 * The handles of a member whose kind lists its outputs, or exposes none.
 * Undefined for a kind whose outputs are read from the member (`chant`).
 */
export function kindHandles(m: Member, kind: MemberKind): MemberHandles | undefined {
  const outputs = kind.outputs;
  if (outputs.from === "none") {
    return { member: m.name, outputs: [], inputs: [], complete: true, why: `${m.name} is kind ${m.kind}, which exposes no outputs as link targets`, exposesNone: true };
  }
  if (outputs.from === "declared") {
    const names = [...new Set([...outputs.names, ...(m.outputs ?? [])])];
    return { member: m.name, outputs: names.map((name) => ({ name })), inputs: [], complete: true, why: null, exposesNone: false };
  }
  return undefined;
}

/** The part of a composed workspace graph (#2537) the links read. */
export interface ComposedHandles {
  /** Members whose IR was composed. */
  composed: readonly string[];
  exports: readonly { member: string; name: string; node?: string }[];
  imports: readonly { member: string; name: string; node: string }[];
}

/**
 * Every composed member's handles, from the `exports` and `imports` of the
 * composed workspace graph, for its `links` section. Node ids are the
 * composed ones (`<member>/<id>`). A member's IR lists all its outputs, so
 * its list is complete.
 */
export function irMemberHandles(graph: ComposedHandles): Map<string, MemberHandles> {
  const out = new Map<string, MemberHandles>();
  for (const member of graph.composed) {
    out.set(member, {
      member,
      outputs: graph.exports.filter((e) => e.member === member).map((e) => ({ name: e.name, ...(e.node ? { node: e.node } : {}) })),
      inputs: graph.imports.filter((i) => i.member === member).map((i) => ({ name: i.name, node: i.node })),
      complete: true,
      why: null,
      exposesNone: false,
    });
  }
  return out;
}

/**
 * The `links` section of the composed workspace graph (#2537, #2524 D8):
 * the declared links and inferred joins, with composed node ids on the ends
 * that have one. Declared links suppress the inferred edges they cover.
 * With `kinds`, a member that isn't composed but whose kind lists its outputs
 * (`other`, kinds from a package) is a link target too.
 */
export function graphLinks(declaration: Declaration, graph: ComposedHandles, kinds?: KindRegistry): LinkTableRow[] {
  const handles = irMemberHandles(graph);
  for (const m of declaration.members) {
    const kind = kinds?.get(m.kind);
    if (handles.has(m.name) || !kind) continue;
    const listed = kindHandles(m, kind);
    if (listed) handles.set(m.name, listed);
  }
  return resolveLinks(declaration, handles).map((row) => {
    if (row.status === "ambiguous" || row.origin !== "declared") return row;
    // The declaration's pointer means nothing to a graph reader.
    const { pointer: _pointer, ...rest } = row;
    return rest;
  });
}
