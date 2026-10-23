/**
 * The lexicon-neutral view capability rules read (#4375, ruled on #4361).
 *
 * chant's graph IR can't serve as a rule surface as it stands: an IAM
 * statement or an inline security-group rule is a property tree inside one
 * node, a Terraform policy is HCL text in a string, Terraform has link
 * resources where CloudFormation has a direct reference, and every Terraform
 * resource is `Terraform::Resource`. So rules read this view instead:
 *
 * - labels (`Instance`, `Role`, `SecurityGroup`) from each lexicon's kind
 *   mapping, and edge names (`subnet`, `sg`) from the IR edge's `viaAttr`;
 * - a node per policy statement and per inline block (an ingress rule, an
 *   inline route), joined to its holder by a named edge;
 * - one edge per link resource (a Terraform policy attachment);
 * - an edge for an ARN string that names a declared role or bucket.
 *
 * The mapping is data, shipped by each lexicon (`CapabilityMapping`). The
 * adapter below is the code that reads it. What a lexicon can't say as data
 * (reading a Terraform `jsonencode(...)` policy) it supplies as a hook.
 */
import type { GraphIR, IRNode, IREdge } from "../graph-ir";
import { terraformType } from "../graph-effective";

/** A path into a node's attributes: `A.B` follows objects, `A[]` spreads a list. */
export type AttrPath = string;

/** Where a neutral attribute is read from: one path, the first present of several, or every value of several. */
export type AttrSource = AttrPath | AttrPath[] | { all: AttrPath[] } | { const: unknown };

/** A label for a kind, optionally only when the node's attributes match. */
export type LabelSpec = string | { label: string; when?: Record<string, unknown>; style?: string; set?: Record<string, unknown> };

/** An inline block exploded into nodes of its own. */
export interface BlockSpec {
  /** The attribute holding the block or list of blocks. */
  attr: AttrPath;
  label: string;
  /** The edge from the holder to the block; a leading `-` points it from the block to the holder. */
  edge: string;
  attrs?: Record<string, AttrSource>;
  /** Attributes of the block that reference other nodes, and the edge name each makes from the block. */
  refs?: Record<string, string>;
  /** Only blocks whose attributes match. */
  when?: Record<string, unknown>;
  /** Recorded as the block node's `style` attribute. */
  style?: string;
}

/** A link resource turned into one edge between the two nodes it links. */
export interface LinkSpec {
  /** The view edge (from the link node) whose target is the new edge's source. */
  from: string;
  /** The view edge (from the link node) whose target is the new edge's target. */
  to: string;
  edge: string;
}

/** Why a lexicon can't supply a capability. */
export interface Unsupported {
  code: string;
  message: string;
}

/**
 * A lexicon's mapping onto the view, as data (`<lexicon>/src/capabilities/mapping.json`).
 * Every field is optional, so a mapping can extend another.
 */
export interface CapabilityMapping {
  lexicon: string;
  /** How a node's type is read: its IR kind, or its Terraform resource type. */
  types?: "kind" | "terraform";
  /** The attribute holding the block body, when it isn't the attributes themselves. */
  body?: string;
  /** How references inside attribute values are spelled. */
  refs?: "cloudformation" | "terraform";
  labels?: Record<string, LabelSpec>;
  /**
   * Per label: IR `viaAttr` -> view edge name. A leading `-` reverses the
   * edge. Where one attribute references several kinds (a launch template's
   * `LaunchTemplateData`), the name can be given per target label.
   */
  edges?: Record<string, Record<string, string | Record<string, string>>>;
  /** Per label: neutral attribute -> where it is read from. */
  attrs?: Record<string, Record<string, AttrSource>>;
  blocks?: Record<string, BlockSpec[]>;
  links?: Record<string, LinkSpec>;
  /** Per label: attribute path of a policy document -> its kind (`permission`, `trust`, `resource`). */
  documents?: Record<string, Record<AttrPath, string>>;
  /** Where tags are read from, and which tag keys give a data store its classification. */
  tags?: AttrPath[];
  classificationTags?: string[];
  /** Capabilities this lexicon can't supply, and why. */
  unsupported?: Record<string, Unsupported>;
}

/** What a lexicon supplies as code, for what its mapping can't say as data. */
export interface CapabilityAdapter {
  /**
   * Read a policy document held in an attribute. Return the document as a
   * JSON object; a value position holding an expression comes back as a
   * string with the expression in `${...}`. Undefined when it can't be read.
   */
  readDocument?(value: unknown): unknown;
}

/** One lexicon's contribution: its mapping (data) and its adapter (code). */
export interface CapabilityPack {
  mapping: CapabilityMapping;
  adapter?: CapabilityAdapter;
}

/**
 * One edge of the IR a view edge stands for, in the IR's own direction:
 * `from` holds the reference, `to` is what it names. #4359's `PathHop`, with
 * the view edge's name.
 */
export interface ViewHop {
  from: string;
  fromAttr?: string;
  to: string;
  toAttr?: string;
  edge: string;
}

export interface ViewNode {
  id: string;
  label: string;
  /** The IR node this view node is, or sits inside (a statement's holder). */
  irId: string;
  lexicon: string;
  attrs: Record<string, unknown>;
  /** What the node was read from: the resource's attributes (its block body), or the inline block. */
  body?: Record<string, unknown>;
}

export interface ViewEdge {
  from: string;
  to: string;
  name: string;
  /** The IR hops this edge stands for, in walk order from `from`. */
  hops: ViewHop[];
}

export interface View {
  nodes: Map<string, ViewNode>;
  edges: ViewEdge[];
  /** Lexicons whose nodes the view read through a mapping. */
  lexicons: Set<string>;
}

/**
 * Merge mappings for the same lexicon: objects merge key by key at every
 * depth, lists concatenate, and anything else in a later mapping wins.
 */
export function mergeMappings(...ms: CapabilityMapping[]): CapabilityMapping {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a;
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b.filter((x) => typeof x === "object" || !a.includes(x))];
    const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
    if (isObj(a) && isObj(b)) {
      const out: Record<string, unknown> = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
      return out;
    }
    return b;
  };
  return ms.reduce((acc, m) => merge(acc, m) as CapabilityMapping, { lexicon: ms[0]?.lexicon ?? "" } as CapabilityMapping);
}

const arr = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Every value at `path` (`A.B`, `A[].B`), flattened. */
function readPath(obj: unknown, path: AttrPath): unknown[] {
  let cur: unknown[] = [obj];
  for (const seg of path.split(".")) {
    const spread = seg.endsWith("[]");
    const key = spread ? seg.slice(0, -2) : seg;
    const next: unknown[] = [];
    for (const c of cur) {
      if (!c || typeof c !== "object") continue;
      const v = (c as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (spread) next.push(...arr(v));
      else next.push(v);
    }
    cur = next;
  }
  return cur;
}

function readSource(obj: unknown, src: AttrSource): unknown {
  if (typeof src === "string") return readPath(obj, src)[0];
  if (Array.isArray(src)) {
    for (const p of src) {
      const v = readPath(obj, p)[0];
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  }
  if ("const" in src) return src.const;
  return src.all.flatMap((p) => readPath(obj, p).flatMap(arr));
}

function matchesWhen(obj: unknown, when?: Record<string, unknown>): boolean {
  if (!when) return true;
  return Object.entries(when).every(([k, v]) => readPath(obj, k)[0] === v);
}

/** The bare name a row prints: no stack qualification, no root directory. */
export function displayName(id: string): string {
  const s = id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
  return s.slice(s.lastIndexOf("/") + 1);
}

const ARN_NAMES: { label: string; re: RegExp }[] = [
  { label: "Role", re: /^arn:aws[\w-]*:iam::[^:]*:role\/(?:[^*]*\/)?([^/*]+)$/ },
  { label: "Bucket", re: /^arn:aws[\w-]*:s3:::([^/*]+)(?:\/.*)?$/ },
  { label: "Table", re: /^arn:aws[\w-]*:dynamodb:[^:]*:[^:]*:table\/([^/*]+)$/ },
];

/**
 * Normalize what each lexicon spells its own way, for labels whose meaning is
 * core vocabulary: an ingress rule's protocol and port range.
 */
function normalize(label: string, attrs: Record<string, unknown>): void {
  if (label === "IngressRule") {
    const raw = attrs.proto == null ? "-1" : String(attrs.proto).toLowerCase();
    const proto = raw === "all" || raw === "-1" ? "-1" : raw;
    attrs.proto = proto;
    if (proto === "-1" || attrs.from == null) {
      attrs.from = 0;
      attrs.to = 65535;
    } else {
      attrs.from = Number(attrs.from);
      attrs.to = attrs.to == null ? attrs.from : Number(attrs.to);
    }
    attrs.cidrs = arr(attrs.cidrs).map(String);
  }
}

/**
 * Build the view of an IR through the packs given. Nodes of a kind no
 * mapping labels are left out, as are edges no mapping names.
 */
export function buildView(ir: GraphIR, packs: CapabilityPack[]): View {
  const byLexicon = new Map<string, CapabilityPack>();
  for (const p of packs) {
    const prev = byLexicon.get(p.mapping.lexicon);
    byLexicon.set(
      p.mapping.lexicon,
      prev ? { mapping: mergeMappings(prev.mapping, p.mapping), adapter: { ...prev.adapter, ...p.adapter } } : p,
    );
  }
  const terraformPack = [...byLexicon.values()].find((p) => p.mapping.types === "terraform");
  const kindPacks = [...byLexicon.values()].filter((p) => p.mapping.types !== "terraform");

  const nodes = new Map<string, ViewNode>();
  const edges: ViewEdge[] = [];
  const lexicons = new Set<string>();
  const irById = new Map(ir.nodes.map((n) => [n.id, n]));
  const packOf = new Map<string, CapabilityPack>();

  const typeAndPack = (n: IRNode): { type: string; pack: CapabilityPack } | undefined => {
    const tf = terraformType(n);
    if (tf !== undefined) return terraformPack ? { type: tf, pack: terraformPack } : undefined;
    const kind = n.kind ?? "";
    const pack = kindPacks.find((p) => p.mapping.labels?.[kind] !== undefined);
    return pack ? { type: kind, pack } : undefined;
  };
  const bodyOf = (n: IRNode, pack: CapabilityPack): Record<string, unknown> => {
    const attrs = (n.attrs ?? {}) as Record<string, unknown>;
    if (!pack.mapping.body) return attrs;
    const b = attrs[pack.mapping.body];
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };

  // Terraform locals, per scope, so `tags = local.restricted` reads as a map.
  const locals = new Map<string, Record<string, unknown>>();
  const scopeOf = (id: string): string => id.slice(0, id.lastIndexOf("/") + 1);
  for (const n of ir.nodes) {
    if (n.kind !== "Terraform::Locals") continue;
    const body = ((n.attrs as Record<string, unknown>)?.body ?? {}) as Record<string, unknown>;
    locals.set(scopeOf(n.id), { ...locals.get(scopeOf(n.id)), ...body });
  }
  const resolveLocal = (from: string, v: unknown): unknown => {
    const m = typeof v === "string" ? /^\$\{local\.([\w-]+)\}$/.exec(v) : null;
    return m ? locals.get(scopeOf(from))?.[m[1]] : v;
  };

  // ---- nodes
  for (const n of ir.nodes) {
    const tp = typeAndPack(n);
    if (!tp) continue;
    const { type, pack } = tp;
    const m = pack.mapping;
    const spec = m.labels?.[type];
    if (spec === undefined) continue;
    const label = typeof spec === "string" ? spec : spec.label;
    const body = bodyOf(n, pack);
    if (typeof spec !== "string" && !matchesWhen(body, spec.when)) continue;
    const attrs: Record<string, unknown> = { type };
    if (typeof spec !== "string" && spec.style) attrs.style = spec.style;
    if (typeof spec !== "string" && spec.set) Object.assign(attrs, spec.set);
    for (const [neutral, src] of Object.entries(m.attrs?.[label] ?? {})) {
      const v = readSource(body, src);
      if (v !== undefined) attrs[neutral] = resolveLocal(n.id, v);
    }
    // Carry the IR's own derived attributes (a live read's `internetFacing`).
    for (const [k, v] of Object.entries((n.attrs ?? {}) as Record<string, unknown>)) {
      if (k === "internetFacing" && attrs[k] === undefined) attrs[k] = v;
    }
    if (m.classificationTags?.length) {
      for (const path of m.tags ?? []) {
        const tags = resolveLocal(n.id, readPath(body, path)[0]);
        const map: Record<string, unknown> = Array.isArray(tags)
          ? Object.fromEntries(tags.map((t) => [(t as { Key?: unknown }).Key, (t as { Value?: unknown }).Value]))
          : tags && typeof tags === "object"
            ? (tags as Record<string, unknown>)
            : {};
        for (const key of m.classificationTags) {
          if (map[key] !== undefined && attrs.classification === undefined) attrs.classification = map[key];
        }
      }
    }
    normalize(label, attrs);
    nodes.set(n.id, { id: n.id, label, irId: n.id, lexicon: m.lexicon, attrs, body });
    packOf.set(n.id, pack);
    lexicons.add(m.lexicon);
  }

  // ---- references inside attribute values
  const byName = new Map<string, Map<string, string>>();
  for (const v of nodes.values()) {
    const name = v.attrs.name;
    if (typeof name !== "string" || !name) continue;
    if (!byName.has(v.label)) byName.set(v.label, new Map());
    byName.get(v.label)!.set(name, v.id);
  }
  const refTarget = (from: string, value: unknown): { id: string; attr?: string } | undefined => {
    const pack = packOf.get(from);
    if (value && typeof value === "object") {
      const ref = (value as { $ref?: unknown }).$ref;
      if (typeof ref === "string") {
        if (nodes.has(ref)) return { id: ref };
        const dot = ref.lastIndexOf(".");
        if (dot > 0 && nodes.has(ref.slice(0, dot))) return { id: ref.slice(0, dot), attr: ref.slice(dot + 1) };
        return undefined;
      }
      const sub = (value as { $sub?: unknown }).$sub;
      if (typeof sub === "string") {
        const m = /\$\{([^.}]+)(?:\.([^}]+))?\}/.exec(sub);
        if (m && nodes.has(m[1])) return { id: m[1], attr: m[2] };
      }
      return undefined;
    }
    if (typeof value !== "string") return undefined;
    if (pack?.mapping.refs === "terraform") {
      const m = /(?:^|[^\w.])((?:data\.)?[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z0-9_-]+)(?:\[[^\]]*\])?\.([A-Za-z_]+)/.exec(value);
      if (m) {
        const id = scopeOf(from) + m[1];
        if (nodes.has(id)) return { id, attr: m[2] };
      }
    }
    for (const { label, re } of ARN_NAMES) {
      const m = re.exec(value);
      const id = m ? byName.get(label)?.get(m[1]) : undefined;
      if (id) return { id };
    }
    return undefined;
  };

  const blockEdges: ViewEdge[] = [];
  // ---- inline blocks: ingress rules, inline routes
  for (const v of [...nodes.values()]) {
    const pack = packOf.get(v.id)!;
    const specs = pack.mapping.blocks?.[v.label];
    if (!specs) continue;
    const body = bodyOf(irById.get(v.id)!, pack);
    for (const spec of specs) {
      readPath(body, spec.attr)
        .flatMap(arr)
        .forEach((raw, i) => {
          if (!raw || typeof raw !== "object" || !matchesWhen(raw, spec.when)) return;
          const id = `${v.id}#${spec.attr.replace(/\[\]/g, "")}[${i}]`;
          const attrs: Record<string, unknown> = { block: true };
          if (spec.style) attrs.style = spec.style;
          for (const [neutral, src] of Object.entries(spec.attrs ?? {})) {
            const val = readSource(raw, src);
            if (val !== undefined) attrs[neutral] = val;
          }
          normalize(spec.label, attrs);
          nodes.set(id, { id, label: spec.label, irId: v.id, lexicon: v.lexicon, attrs, body: raw as Record<string, unknown> });
          packOf.set(id, pack);
          const back = spec.edge.startsWith("-");
          const name = back ? spec.edge.slice(1) : spec.edge;
          const hop: ViewHop = { from: v.id, fromAttr: spec.attr.replace(/\[\]/g, ""), to: id, edge: name };
          blockEdges.push(back ? { from: id, to: v.id, name, hops: [hop] } : { from: v.id, to: id, name, hops: [hop] });
          for (const [attr, edge] of Object.entries(spec.refs ?? {})) {
            for (const val of arr((raw as Record<string, unknown>)[attr])) {
              const t = refTarget(v.id, val);
              if (t) blockEdges.push({ from: id, to: t.id, name: edge, hops: [{ from: id, fromAttr: attr, to: t.id, ...(t.attr ? { toAttr: t.attr } : {}), edge }] });
            }
          }
        });
    }
  }
  // Blocks first: an inline route is read before a separate route resource,
  // the order the folds always used.
  edges.push(...blockEdges);

  // ---- IR edges, named per label
  for (const e of ir.edges ?? []) {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to) continue;
    const pack = packOf.get(e.from)!;
    const via = e.viaAttr ?? e.kind ?? "";
    const spec = pack.mapping.edges?.[from.label]?.[via];
    const name = typeof spec === "string" ? spec : spec?.[to.label];
    if (!name) continue;
    const back = name.startsWith("-");
    const n = back ? name.slice(1) : name;
    const hop = irHop(e, n);
    edges.push(back ? { from: e.to, to: e.from, name: n, hops: [hop] } : { from: e.from, to: e.to, name: n, hops: [hop] });
  }

  // ---- link resources -> one edge
  for (const v of [...nodes.values()]) {
    const link = packOf.get(v.id)?.mapping.links?.[v.label];
    if (!link) continue;
    const a = edges.find((e) => e.from === v.id && e.name === link.from);
    const b = edges.find((e) => e.from === v.id && e.name === link.to);
    if (a && b) edges.push({ from: a.to, to: b.to, name: link.edge, hops: [...a.hops, ...b.hops] });
  }

  // ---- policy documents -> statements
  for (const holder of [...nodes.values()]) {
    if (holder.attrs.block) continue;
    const pack = packOf.get(holder.id)!;
    const docs = pack.mapping.documents?.[holder.label];
    if (!docs) continue;
    const body = bodyOf(irById.get(holder.id)!, pack);
    for (const [path, docKind] of Object.entries(docs)) {
      readPath(body, path).forEach((raw, di) => {
        const doc = readDocument(raw, pack);
        if (!doc) return;
        const base = path.replace(/\[\]/g, "");
        arr((doc as Record<string, unknown>).Statement).forEach((s0, si) => {
          if (!s0 || typeof s0 !== "object") return;
          const s = s0 as Record<string, unknown>;
          const id = `${holder.id}#${base}[${di}].Statement[${si}]`;
          const principal = s.Principal;
          const principals =
            principal === "*"
              ? ["*"]
              : principal && typeof principal === "object"
                ? Object.values(principal as Record<string, unknown>).flatMap(arr).map((p) => (typeof p === "string" ? p : "ref"))
                : [];
          const resources = arr(s.Resource);
          const attrs: Record<string, unknown> = {
            doc: docKind,
            effect: s.Effect,
            actions: arr(s.Action).map(String),
            ...(s.NotAction !== undefined ? { notActions: arr(s.NotAction).map(String) } : {}),
            ...(s.NotResource !== undefined ? { notResource: true } : {}),
            ...(s.Condition !== undefined ? { condition: true } : {}),
            ...(resources.some((r) => r === "*") ? { anyResource: true } : {}),
            principals,
          };
          nodes.set(id, { id, label: "Statement", irId: holder.id, lexicon: holder.lexicon, attrs });
          packOf.set(id, pack);
          edges.push({ from: holder.id, to: id, name: "statement", hops: [{ from: holder.id, fromAttr: base, to: id, edge: "statement" }] });
          let unresolved = 0;
          resources.forEach((r, ri) => {
            const t = refTarget(holder.id, r);
            // A reference the graph holds but can't name (an intrinsic with
            // no target, a Terraform expression to an undeclared resource) is
            // counted, so an answer can say what it skipped. A `Sub` is read
            // through its `$sub` template (chant#4373).
            if (!t && ((r && typeof r === "object") || (typeof r === "string" && r.includes("${")))) unresolved++;
            if (t) edges.push({ from: id, to: t.id, name: "resource", hops: [{ from: id, fromAttr: `Resource[${ri}]`, to: t.id, ...(t.attr ? { toAttr: t.attr } : {}), edge: "resource" }] });
          });
          if (unresolved > 0) attrs.unresolved = unresolved;
          if (principal && typeof principal === "object") {
            for (const p of arr((principal as Record<string, unknown>).AWS)) {
              const t = refTarget(holder.id, p);
              if (t) edges.push({ from: id, to: t.id, name: "principal", hops: [{ from: id, fromAttr: "Principal.AWS", to: t.id, ...(t.attr ? { toAttr: t.attr } : {}), edge: "principal" }] });
            }
          }
        });
      });
    }
  }
  return { nodes, edges, lexicons };
}

function irHop(e: IREdge, name: string): ViewHop {
  return {
    from: e.from,
    ...(e.viaAttr ? { fromAttr: e.viaAttr } : {}),
    to: e.to,
    ...(e.toAttr ? { toAttr: e.toAttr } : {}),
    edge: name,
  };
}

function readDocument(raw: unknown, pack: CapabilityPack): unknown {
  if (pack.adapter?.readDocument) return pack.adapter.readDocument(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const inner = (raw as Record<string, unknown>).PolicyDocument;
    return inner && typeof inner === "object" ? inner : raw;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
