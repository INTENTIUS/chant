/**
 * `chant import --index` (#4524, the step from tier 1 to tier 2 of
 * INTENTIUS/behold#1025): typed source for indexed resources. Nothing is
 * applied and nothing is written to the cloud.
 *
 * {@link planIndexImport} is the pure part. It takes the documents of one
 * index read, a selection and the lexicons, and returns one import IR per
 * output group plus the report. The caller (../cli/commands/import-index.ts)
 * hands each IR to the lexicon's own `templateGenerator()`, the codegen
 * `chant import <template>` uses, and writes the files.
 *
 * Rules:
 * - each selected node goes to the lexicon its kind belongs to. A lexicon
 *   writes it only through its `indexImport` seam ({@link IndexImportCodegen}).
 *   A node of unknown kind, or of a lexicon with no seam, is reported as
 *   unsupported by name and written nowhere;
 * - a node already declared in the project (the identity matcher, #4523,
 *   bound an entity to it) is reported as declared with the entity's name and
 *   is not imported again ({@link declaredNodes});
 * - a derived edge (#4522, `origin: "derived"`) becomes a reference when its
 *   target is imported into the same group and the lexicon can spell the
 *   value as a reference to it. Otherwise the value stays a literal, and a
 *   comment in the file names the edge and why;
 * - a value the listing masked (`[REDACTED]`) is never written. Each one
 *   becomes a parameter to fill in;
 * - output is deterministic: nodes, edges, parameters and logical ids are
 *   ordered by id, so the same index and selection give the same IR, and the
 *   same files.
 *
 * The report names each resource's identity (substrate, scope id, listed
 * type, location, native id) and cloud ids, for the adoption step that
 * follows (INTENTIUS/choudoufu#2284).
 */
import { createHash } from "node:crypto";
import { MASKED } from "../deep-observation";
import type { IREdge, IRNode } from "../graph-ir";
import { readPath } from "../graph-refs";
import type { ParameterIR, ResourceIR, TemplateIR } from "../import/parser";
import { matchDeclaredToIndex, type DeclaredEntity, type IndexIdentity } from "./identity-match";
import type { IndexDocument } from "./index-document";

/** What to import from the index. Within one field any value matches; every field given must match. */
export interface IndexImportSelection {
  /** Listed types or lexicon kinds (`AWS::S3::Bucket`). */
  types?: readonly string[];
  /** Native ids or node ids. */
  names?: readonly string[];
  /** Tags the node carries, every one with this value. */
  tags?: Readonly<Record<string, string>>;
  /** Node ids, a subgraph from a query (`chant search --index ... --json`). */
  nodes?: readonly string[];
  /** Every node in the index. */
  all?: boolean;
}

/** An imported node as a reference target. */
export interface IndexImportTarget {
  logicalId: string;
  node: IRNode;
}

/**
 * A lexicon's index import seam (a plugin's `indexImport`). Data plus pure
 * functions that turn an indexed node into the lexicon's own import IR
 * ({@link ResourceIR}), which its `templateGenerator()` then writes.
 */
export interface IndexImportCodegen {
  /**
   * The resource for one indexed node: its import IR type and the
   * properties a declaration can hold (server-assigned fields left out), or
   * why the node cannot be written. `attributes` are resource-level
   * attributes under the lexicon's own keys (the aws lexicon writes
   * `DeletionPolicy: Retain` on every imported resource, #4536).
   */
  resource(node: IRNode): { type: string; properties: Record<string, unknown>; attributes?: Record<string, unknown> } | { unsupported: string };
  /**
   * `value`, held by another node, as a reference to `target` in this
   * lexicon's IR, or undefined when the value is not one the lexicon can
   * spell as a reference (it then stays a literal).
   */
  reference(value: string, target: IndexImportTarget): unknown | undefined;
  /** The parameter that stands in for a masked value. */
  secretParameter(name: string, context: { node: IRNode; logicalId: string; path: string }): ParameterIR;
  /** A reference to that parameter, as a property value in this lexicon's IR. */
  parameterReference(name: string): unknown;
  /** The type's short name for logical ids (`Bucket` for `AWS::S3::Bucket`). Absent: the kind's last segment. */
  typeLabel?(node: IRNode): string;
}

/** What {@link planIndexImport} needs from a lexicon. A `LexiconPlugin` is one. */
export interface IndexImportLexicon {
  name: string;
  indexImport?: IndexImportCodegen;
}

/** One reference a node holds, as the import wrote it. */
export interface IndexImportReference {
  path: string;
  target: string;
  rule?: string;
  written: "reference" | "literal";
  /** Why a literal stayed a literal. */
  reason?: string;
}

/** One selected resource in the report. */
export interface IndexImportResourceReport {
  node: string;
  identity: { substrate: string; scopeId: string; listedType: string; location: string; nativeId: string };
  cloudIds: Array<{ kind: string; value: string }>;
  /** The ownership markers the listing read off the resource, when any. */
  markers?: unknown;
  lexicon: string;
  kind: string;
  status: "imported" | "declared" | "unsupported";
  reason?: string;
  /** With `declared`: the entity the matcher bound to it. */
  entity?: string;
  /** With `imported`: the logical id and the group's directory (`""` is the output root). */
  logicalId?: string;
  group?: string;
  references?: IndexImportReference[];
  parameters?: string[];
}

export interface IndexImportParameterReport {
  name: string;
  node: string;
  path: string;
  group: string;
}

/** The import report (`chant-index-import.json`), deterministic for one index and selection. */
export interface IndexImportReport {
  report: "chant-index-import/v1";
  index: Array<{ scopeKey: string; observedAt: string; digest: string; source: string }>;
  selection: IndexImportSelection;
  resources: IndexImportResourceReport[];
  parameters: IndexImportParameterReport[];
  groups: Array<{ group: string; lexicon: string; location: string; resources: number }>;
}

/** One output group: a lexicon and a location, written to `dir` under the output. */
export interface IndexImportGroup {
  /** `""` when the import has one group, else `<lexicon>/<location>`. */
  dir: string;
  lexicon: string;
  location: string;
  ir: TemplateIR;
  /** Comment lines (without `// `) to put at the top of the group's first file. */
  header: string[];
}

export interface IndexImportPlan {
  groups: IndexImportGroup[];
  report: IndexImportReport;
}

export interface PlanOptions {
  /** Node id -> declared entity name, from {@link declaredNodes}. */
  declared?: ReadonlyMap<string, string>;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Locations that hold global types, as derive-edges.ts reads them. */
const GLOBAL_LOCATIONS: ReadonlySet<string> = new Set(["global", "cluster", ""]);

function canonicalSelection(sel: IndexImportSelection): IndexImportSelection {
  const sortU = (xs?: readonly string[]) => (xs && xs.length > 0 ? [...new Set(xs)].sort(byString) : undefined);
  const out: IndexImportSelection = {};
  if (sel.all) out.all = true;
  const types = sortU(sel.types);
  if (types) out.types = types;
  const names = sortU(sel.names);
  if (names) out.names = names;
  const nodes = sortU(sel.nodes);
  if (nodes) out.nodes = nodes;
  if (sel.tags && Object.keys(sel.tags).length > 0) {
    out.tags = Object.fromEntries(Object.keys(sel.tags).sort(byString).map((k) => [k, sel.tags![k]]));
  }
  return out;
}

/** True when the selection names nothing: no `all` and no filter. An empty selection selects no node. */
export function selectionIsEmpty(sel: IndexImportSelection): boolean {
  const c = canonicalSelection(sel);
  return !c.all && !c.types && !c.names && !c.nodes && !c.tags;
}

/** Whether a node is selected. */
export function nodeSelected(node: IRNode, sel: IndexImportSelection): boolean {
  if (selectionIsEmpty(sel)) return false;
  if (sel.all) return true;
  if (sel.types && sel.types.length > 0 && !sel.types.includes(node.listedType ?? node.kind) && !sel.types.includes(node.kind)) return false;
  if (sel.names && sel.names.length > 0 && !sel.names.includes(node.nativeId ?? "") && !sel.names.includes(node.id)) return false;
  if (sel.nodes && sel.nodes.length > 0 && !sel.nodes.includes(node.id)) return false;
  if (sel.tags) {
    for (const [k, v] of Object.entries(sel.tags)) if (node.tags?.[k] !== v) return false;
  }
  return true;
}

/**
 * The indexed nodes the project already declares, keyed by node id, with
 * the entity's name: the identity matcher (#4523) run once per location the
 * index holds, for each lexicon that declares an `indexIdentity`. A node two
 * entities bind keeps the first by entity name.
 */
export function declaredNodes(
  docs: readonly IndexDocument[],
  entitiesByLexicon: ReadonlyMap<string, readonly DeclaredEntity[]>,
  identities: ReadonlyArray<{ name: string; indexIdentity?: IndexIdentity }>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (docs.length === 0) return out;
  const scope = docs[0].stamp.scope;
  if (scope.kind !== "cloud") return out;
  const locations = [...new Set(docs.flatMap((d) => d.graph.nodes.map((n) => n.location ?? "")))]
    .filter((l) => !GLOBAL_LOCATIONS.has(l))
    .sort(byString);
  for (const { name, indexIdentity } of [...identities].sort((a, b) => byString(a.name, b.name))) {
    if (!indexIdentity || indexIdentity.substrate !== scope.substrate) continue;
    const entities = entitiesByLexicon.get(name) ?? [];
    if (entities.length === 0) continue;
    // A global type matches at `global` whatever the region; one pass with no region covers it.
    for (const region of locations.length > 0 ? locations : [undefined]) {
      const { matches } = matchDeclaredToIndex(entities, docs, indexIdentity, region ? { region } : {});
      for (const m of Object.values(matches)) {
        if (m.verdict === "bound" && !out.has(m.node)) out.set(m.node, m.entity);
      }
    }
  }
  return out;
}

function pascalWords(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** The kind's last `::`, `/` or `.` segment: `Bucket` for `AWS::S3::Bucket`. */
function defaultTypeLabel(node: IRNode): string {
  const parts = node.kind.split(/::|\/|\./).filter(Boolean);
  return pascalWords(parts[parts.length - 1] ?? "Resource") || "Resource";
}

/**
 * `<TypeLabel><NativeId in PascalCase>`, letters and digits only. A long id
 * keeps its tail and a hash of the node id. Collisions take a number, in
 * node id order, so the names are stable.
 */
function assignLogicalIds(nodes: readonly IRNode[], label: (n: IRNode) => string): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const n of [...nodes].sort((a, b) => byString(a.id, b.id))) {
    const native = n.nativeId ?? n.id;
    // An ARN or a URL: its last path segment names the object.
    const tail = native.includes("/") ? native.slice(native.lastIndexOf("/") + 1) || native : native;
    const prefix = label(n);
    let words = tail.split(/[^A-Za-z0-9]+/).filter(Boolean);
    // `vpc-0a1` under `VPC` reads `VPC0a1`, not `VPCVpc0a1`.
    if (words.length > 1 && words[0].toLowerCase() === prefix.toLowerCase()) words = words.slice(1);
    let id = pascalWords(words.join("-"));
    if (id.length > 48) id = `${id.slice(-40)}${shortHash(n.id)}`;
    let base = `${prefix}${id}`;
    if (!/^[A-Za-z]/.test(base)) base = `R${base}`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    out.set(n.id, name);
  }
  return out;
}

/** The path a derived edge's rule names on its holder, or undefined (identity-match and tag rules name none). */
export function edgeRulePath(edge: IREdge, holder: IRNode): string | undefined {
  const rule = edge.rule;
  if (!rule) return undefined;
  const prefix = `${holder.lexicon}:${holder.kind}:`;
  if (!rule.startsWith(prefix)) return undefined;
  const path = rule.slice(prefix.length);
  return path.startsWith("tag:") ? undefined : path;
}

/**
 * Rewrite the string leaves at `path` (`a.b`, `arr[].id`, as readPath reads
 * it). A path that ends on an array rewrites its string elements. Returns
 * the new tree and the dotted paths it changed.
 */
function rewriteAtPath(
  tree: Record<string, unknown>,
  path: string,
  fn: (value: string) => unknown | undefined,
): { tree: Record<string, unknown>; changed: string[] } {
  const changed: string[] = [];
  const parts = path.split(".");
  const walk = (value: unknown, i: number, at: string): unknown => {
    if (i === parts.length) {
      if (typeof value === "string") {
        const r = fn(value);
        if (r !== undefined) {
          changed.push(at);
          return r;
        }
        return value;
      }
      if (Array.isArray(value)) return value.map((v, j) => walk(v, i, `${at}[${j}]`));
      return value;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const part = parts[i];
    const isArr = part.endsWith("[]");
    const key = isArr ? part.slice(0, -2) : part;
    const obj = value as Record<string, unknown>;
    if (!(key in obj)) return value;
    const here = at === "" ? key : `${at}.${key}`;
    const child = obj[key];
    let next: unknown;
    if (isArr) {
      if (!Array.isArray(child)) return value;
      next = child.map((c, j) => walk(c, i + 1, `${here}[${j}]`));
    } else {
      next = walk(child, i + 1, here);
    }
    return next === child ? value : { ...obj, [key]: next };
  };
  return { tree: walk(tree, 0, "") as Record<string, unknown>, changed };
}

/** Every string leaf, outside `Tags`, as a dotted path (identity-match edges name no path). */
function stringLeafPaths(tree: unknown, at = ""): string[] {
  if (typeof tree === "string") return [at];
  if (Array.isArray(tree)) return tree.flatMap((v, j) => stringLeafPaths(v, `${at}[${j}]`));
  if (tree === null || typeof tree !== "object") return [];
  return Object.keys(tree as Record<string, unknown>)
    .sort(byString)
    .filter((k) => !(at === "" && (k === "Tags" || k === "tags")))
    .flatMap((k) => stringLeafPaths((tree as Record<string, unknown>)[k], at === "" ? k : `${at}.${k}`));
}

/** A path with explicit indices (`a[2].b`) as readPath/rewriteAtPath segments over one leaf. */
function exactPathParts(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const seg of path.split(".")) {
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(seg);
    if (!m) {
      out.push(seg);
      continue;
    }
    if (m[1] !== "") out.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

function setExact(tree: unknown, parts: ReadonlyArray<string | number>, value: unknown): unknown {
  if (parts.length === 0) return value;
  const [head, ...rest] = parts;
  if (typeof head === "number") {
    if (!Array.isArray(tree)) return tree;
    const copy = [...tree];
    copy[head] = setExact(copy[head], rest, value);
    return copy;
  }
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) return tree;
  const obj = tree as Record<string, unknown>;
  return { ...obj, [head]: setExact(obj[head], rest, value) };
}

function getExact(tree: unknown, parts: ReadonlyArray<string | number>): unknown {
  let cur = tree;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

/** Every masked leaf, as a dotted path with indices, in key order. */
function maskedPaths(tree: unknown, at = ""): string[] {
  if (tree === MASKED) return [at];
  if (Array.isArray(tree)) return tree.flatMap((v, j) => maskedPaths(v, `${at}[${j}]`));
  if (tree === null || typeof tree !== "object") return [];
  return Object.keys(tree as Record<string, unknown>)
    .sort(byString)
    .flatMap((k) => maskedPaths((tree as Record<string, unknown>)[k], at === "" ? k : `${at}.${k}`));
}

function identityOf(doc: IndexDocument, node: IRNode): IndexImportResourceReport["identity"] {
  const scope = doc.stamp.scope;
  return {
    substrate: scope.kind === "cloud" ? scope.substrate : node.lexicon,
    scopeId: scope.kind === "cloud" ? scope.scopeId : doc.stamp.scopeKey,
    listedType: node.listedType ?? node.kind,
    location: node.location ?? "",
    nativeId: node.nativeId ?? node.physicalId ?? node.id,
  };
}

/**
 * Plan an import from the documents of one index read. Pure; throws only on
 * documents from two accounts or two reads, as derive-edges.ts does.
 */
export function planIndexImport(
  docs: readonly IndexDocument[],
  selection: IndexImportSelection,
  lexicons: readonly IndexImportLexicon[],
  options: PlanOptions = {},
): IndexImportPlan {
  const first = docs[0]?.stamp;
  for (const d of docs) {
    if (first && (d.stamp.observedAt !== first.observedAt || JSON.stringify(scopeAccount(d)) !== JSON.stringify(scopeAccount(docs[0])))) {
      throw new Error(`an index import reads one read of one account: ${first.scopeKey} and ${d.stamp.scopeKey} differ`);
    }
  }
  const sel = canonicalSelection(selection);
  const declared = options.declared ?? new Map<string, string>();
  const byLexicon = new Map(lexicons.map((l) => [l.name, l]));

  const docOf = new Map<string, IndexDocument>();
  const nodes: IRNode[] = [];
  for (const d of docs) {
    for (const n of d.graph.nodes) {
      if (docOf.has(n.id)) continue;
      docOf.set(n.id, d);
      nodes.push(n);
    }
  }
  nodes.sort((a, b) => byString(a.id, b.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = docs
    .flatMap((d) => d.graph.edges)
    .filter((e) => e.origin === "derived")
    .sort((a, b) => byString(`${a.from}\u0000${a.rule ?? ""}\u0000${a.to}`, `${b.from}\u0000${b.rule ?? ""}\u0000${b.to}`));

  const reports = new Map<string, IndexImportResourceReport>();
  const writable: Array<{ node: IRNode; codegen: IndexImportCodegen; type: string; properties: Record<string, unknown>; attributes?: Record<string, unknown> }> = [];
  for (const node of nodes) {
    if (!nodeSelected(node, sel)) continue;
    const doc = docOf.get(node.id)!;
    const base: IndexImportResourceReport = {
      node: node.id,
      identity: identityOf(doc, node),
      cloudIds: (node.facts?.cloudIds ?? []).map((c) => ({ kind: c.kind, value: c.value })),
      ...(node.facts?.markers ? { markers: node.facts.markers } : {}),
      lexicon: node.lexicon,
      kind: node.kind,
      status: "unsupported",
    };
    const entity = declared.get(node.id);
    if (entity !== undefined) {
      reports.set(node.id, { ...base, status: "declared", entity, reason: `already declared as ${entity}; not imported again` });
      continue;
    }
    if (node.unmappedKind) {
      reports.set(node.id, { ...base, reason: `no lexicon kind maps the listed type ${node.listedType ?? node.kind}` });
      continue;
    }
    const lexicon = byLexicon.get(node.lexicon);
    if (!lexicon) {
      reports.set(node.id, { ...base, reason: `the ${node.lexicon} lexicon is not loaded` });
      continue;
    }
    if (!lexicon.indexImport) {
      reports.set(node.id, { ...base, reason: `the ${node.lexicon} lexicon has no index import codegen (indexImport)` });
      continue;
    }
    const r = lexicon.indexImport.resource(node);
    if ("unsupported" in r) {
      reports.set(node.id, { ...base, reason: r.unsupported });
      continue;
    }
    reports.set(node.id, { ...base, status: "imported" });
    writable.push({ node, codegen: lexicon.indexImport, type: r.type, properties: r.properties, ...(r.attributes ? { attributes: r.attributes } : {}) });
  }

  // Groups: lexicon + location. Global nodes join their lexicon's only regional group, when there is one.
  const regional = new Map<string, Set<string>>();
  for (const w of writable) {
    const loc = w.node.location ?? "";
    if (!GLOBAL_LOCATIONS.has(loc)) (regional.get(w.node.lexicon) ?? regional.set(w.node.lexicon, new Set()).get(w.node.lexicon)!).add(loc);
  }
  const groupLocation = (n: IRNode): string => {
    const loc = n.location ?? "";
    if (!GLOBAL_LOCATIONS.has(loc)) return loc;
    const regions = regional.get(n.lexicon);
    return regions && regions.size === 1 ? [...regions][0] : loc === "" ? "global" : loc;
  };
  const groupKeys = [...new Set(writable.map((w) => `${w.node.lexicon}/${groupLocation(w.node)}`))].sort(byString);
  const single = groupKeys.length === 1;
  const groupDir = (n: IRNode) => (single ? "" : `${n.lexicon}/${groupLocation(n)}`);

  const logicalIds = new Map<string, string>();
  for (const key of groupKeys) {
    const members = writable.filter((w) => `${w.node.lexicon}/${groupLocation(w.node)}` === key);
    const codegen = members[0].codegen;
    const label = (n: IRNode) => codegen.typeLabel?.(n) ?? defaultTypeLabel(n);
    for (const [id, name] of assignLogicalIds(members.map((m) => m.node), label)) logicalIds.set(id, name);
  }

  const groups: IndexImportGroup[] = [];
  const parameterReports: IndexImportParameterReport[] = [];
  for (const key of groupKeys) {
    const members = writable.filter((w) => `${w.node.lexicon}/${groupLocation(w.node)}` === key);
    const dir = groupDir(members[0].node);
    const header: string[] = [];
    const resources: ResourceIR[] = [];
    const parameters: ParameterIR[] = [];
    const usedParams = new Set<string>();
    for (const w of members) {
      const logicalId = logicalIds.get(w.node.id)!;
      const report = reports.get(w.node.id)!;
      report.logicalId = logicalId;
      report.group = dir;
      let props = w.properties;
      const references: IndexImportReference[] = [];

      for (const e of edges.filter((x) => x.from === w.node.id)) {
        const target = nodeById.get(e.to);
        const path = edgeRulePath(e, w.node);
        const literal = (reason: string) => {
          const at = path ?? e.viaAttr ?? "";
          references.push({ path: at, target: e.to, ...(e.rule ? { rule: e.rule } : {}), written: "literal", reason });
          const values = path ? readPath(props, path) : [];
          header.push(
            `${logicalId}.${at}${values.length > 0 ? ` = ${values.map((v) => JSON.stringify(v)).join(", ")}` : ""} stays a literal: ` +
              `derived edge ${e.rule ?? "(no rule)"} to ${e.to}; ${reason}`,
          );
        };
        if (e.rule && edgeRulePath(e, w.node) === undefined && e.rule.startsWith(`${w.node.lexicon}:${w.node.kind}:tag:`)) {
          literal("a tag rule names no property to reference");
          continue;
        }
        if (!target) {
          literal("the target is not in the index");
          continue;
        }
        const targetDeclared = declared.get(target.id);
        if (targetDeclared !== undefined) {
          literal(`the target is already declared as ${targetDeclared}`);
          continue;
        }
        const targetReport = reports.get(target.id);
        if (!targetReport) {
          literal("the target is not in the selection");
          continue;
        }
        if (targetReport.status !== "imported") {
          literal(`the target is not imported (${targetReport.reason ?? targetReport.status})`);
          continue;
        }
        if (groupDir(target) !== dir || target.lexicon !== w.node.lexicon) {
          literal(`the target is written to another group (${groupDir(target) || "."})`);
          continue;
        }
        const t: IndexImportTarget = { logicalId: logicalIds.get(target.id)!, node: target };
        const changed: string[] = [];
        if (path) {
          const r = rewriteAtPath(props, path, (v) => w.codegen.reference(v, t));
          props = r.tree;
          changed.push(...r.changed);
        } else {
          for (const leaf of stringLeafPaths(props)) {
            const parts = exactPathParts(leaf);
            const v = getExact(props, parts);
            if (typeof v !== "string") continue;
            const ref = w.codegen.reference(v, t);
            if (ref === undefined) continue;
            props = setExact(props, parts, ref) as Record<string, unknown>;
            changed.push(leaf);
          }
        }
        if (changed.length === 0) {
          literal(`the ${w.node.lexicon} lexicon cannot spell the value as a reference to ${t.logicalId}`);
          continue;
        }
        for (const at of changed) references.push({ path: at, target: e.to, ...(e.rule ? { rule: e.rule } : {}), written: "reference" });
      }

      const params: string[] = [];
      for (const at of maskedPaths(props)) {
        let name = `${logicalId}${pascalWords(at)}`;
        for (let i = 2; usedParams.has(name); i++) name = `${logicalId}${pascalWords(at)}${i}`;
        usedParams.add(name);
        parameters.push(w.codegen.secretParameter(name, { node: w.node, logicalId, path: at }));
        props = setExact(props, exactPathParts(at), w.codegen.parameterReference(name)) as Record<string, unknown>;
        params.push(name);
        parameterReports.push({ name, node: w.node.id, path: at, group: dir });
        header.push(`${logicalId}.${at} was masked in the index; fill in the parameter ${name}`);
      }

      if (references.length > 0) report.references = references;
      if (params.length > 0) report.parameters = params;
      resources.push({ logicalId, type: w.type, properties: props, ...(w.attributes && Object.keys(w.attributes).length > 0 ? { attributes: w.attributes } : {}) });
    }
    const [lexicon, ...loc] = key.split("/");
    groups.push({ dir, lexicon, location: loc.join("/"), ir: { resources, parameters }, header });
  }

  const report: IndexImportReport = {
    report: "chant-index-import/v1",
    index: [...docs]
      .map((d) => ({ scopeKey: d.stamp.scopeKey, observedAt: d.stamp.observedAt, digest: d.stamp.digest, source: d.stamp.source.name }))
      .sort((a, b) => byString(a.scopeKey, b.scopeKey)),
    selection: sel,
    resources: [...reports.values()].sort((a, b) => byString(a.node, b.node)),
    parameters: parameterReports,
    groups: groups.map((g) => ({ group: g.dir, lexicon: g.lexicon, location: g.location, resources: g.ir.resources.length })),
  };
  return { groups, report };
}

function scopeAccount(d: IndexDocument): unknown {
  const s = d.stamp.scope;
  return s.kind === "cloud" ? [s.substrate, s.scopeId] : [s.kind, d.stamp.scopeKey];
}

/** The header comment for a group's first file. Same plan, same text. */
export function indexImportHeader(plan: IndexImportPlan, group: IndexImportGroup): string {
  const lines = [
    "Generated by chant import --index. Nothing was applied. Review before committing.",
    ...plan.report.index.map((i) => `index ${i.scopeKey} read ${i.observedAt} (digest ${i.digest.slice(0, 12)})`),
    ...group.header,
  ];
  return lines.map((l) => `// ${l.replace(/\r?\n/g, " ")}`).join("\n") + "\n\n";
}
