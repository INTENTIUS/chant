/**
 * Turn a CDK cloud assembly into the same dependency graph the Terraform
 * advisor scores (#1056).
 *
 * Two jobs, both exact rather than heuristic:
 *
 * **Grouping.** CloudFormation resources are the wrong unit to rank. One L2
 * construct emits several of them — a `Function` emits a role, a policy and the
 * function — and they carve together or not at all. Every resource carries its
 * emitting construct in `Metadata["aws:cdk:path"]`, and `tree.json` says which
 * ancestor of that path is the construct a person actually wrote. So resources
 * fold up to the shallowest L2 (or L3) ancestor and that construct ranks once.
 * This is the CDK analogue of Terraform sub-resources folding into their parent.
 *
 * **Edges.** `Ref`, `Fn::GetAtt` and `Fn::Sub` are intra-stack; `Fn::ImportValue`
 * resolves through the exporting stack's `Outputs` to the construct that
 * actually produces the value, so a cross-stack dependency lands as a real edge
 * between two constructs in both directions rather than a dangling name. There
 * is no expression AST to consult and no regex over HCL: the template is JSON,
 * and an intrinsic is a JSON object with a known key.
 *
 * Pure — no filesystem, no CDK CLI. `assembly.ts` does the reading.
 */

import { indexTree } from "./assembly";
import { NESTED_STACK_TYPE, SCAFFOLDING_TYPES, isScaffoldingParameter, resolveCfnTier } from "./tier-map";
import type { CdkStack, CdkTreeNode, CfnResource, CloudAssembly } from "./types";
import type { CarveUnitMember, ScoreSignals } from "../terraform/score";
import type { TfEdge, TfGraph, TfNode } from "../terraform/types";

/**
 * What a construct is, from its jsii class name.
 *
 *  - `l1`        — a `Cfn*` class: one construct, one CloudFormation resource.
 *  - `l2`        — a curated service construct (`aws-cdk-lib.aws_s3.Bucket`).
 *  - `l3`        — a pattern or a hand-written grouping construct. A Composite
 *                  candidate (#1000), ranked whole instead of leaf by leaf.
 *  - `nested`    — a `NestedStack`: a template of its own.
 *  - `container` — App/Stage/Stack. Never a scoring unit; the ranking lives
 *                  inside it.
 *  - `unknown`   — no tree metadata to go on.
 *
 * A user's own construct class is not jsii-compiled, so tree metadata reports
 * its nearest jsii ancestor: `constructs.Construct` for a grouping construct,
 * `aws-cdk-lib.Stack` for a stack subclass. That is why stacks are recognized
 * by their manifest artifact rather than by fqn — the fqn alone cannot tell a
 * user's stack from a user's L3.
 */
export type ConstructLevel = "l1" | "l2" | "l3" | "nested" | "container" | "unknown";

const CONTAINER_FQNS = new Set([
  "aws-cdk-lib.App",
  "aws-cdk-lib.Stack",
  "aws-cdk-lib.Stage",
  "aws-cdk-lib.TreeMetadata",
  "@aws-cdk/core.App",
  "@aws-cdk/core.Stack",
  "@aws-cdk/core.Stage",
]);

const NESTED_STACK_FQNS = new Set(["aws-cdk-lib.NestedStack", "@aws-cdk/core.NestedStack"]);

/** The leaf ids CDK gives an L2's own L1 child. Not constructs anyone wrote. */
const IMPLICIT_LEAF_IDS = new Set(["Resource", "Default"]);

export function constructLevel(fqn: string | undefined): ConstructLevel {
  if (!fqn) return "unknown";
  if (CONTAINER_FQNS.has(fqn)) return "container";
  if (NESTED_STACK_FQNS.has(fqn)) return "nested";
  const cls = fqn.slice(fqn.lastIndexOf(".") + 1);
  if (cls.startsWith("Cfn")) return "l1";
  if (/^(aws-cdk-lib\.aws_|@aws-cdk\/aws-)/.test(fqn)) return "l2";
  return "l3";
}

/** One CloudFormation resource, tied back to the construct that emitted it. */
interface ResourceEntry {
  logicalId: string;
  type: string;
  stack: string;
  /** Construct path from `aws:cdk:path`, or a synthetic one when absent. */
  path: string;
  resource: CfnResource;
}

/** A scoring unit: one construct plus every CloudFormation resource under it. */
interface Unit {
  path: string;
  kind: "resource" | "module";
  level: ConstructLevel;
  members: ResourceEntry[];
}

/** A reference found inside a template, before it is resolved to a unit. */
interface RawRef {
  /** Logical ID in the referring stack, or an export name when `crossStack`. */
  target: string;
  attr: string;
  via?: string;
  crossStack?: boolean;
}

const AWS_PSEUDO = /^AWS::/;

/**
 * Every reference in a JSON value, plus whether the value carries a construct
 * that makes it dynamic (`Fn::If`, a template `Condition`). Walks the JSON
 * looking for CloudFormation intrinsics — the whole grammar is `{"Fn::X": ...}`
 * and `{"Ref": "..."}`, so there is nothing to tokenize.
 */
function refsIn(value: unknown, via: string | undefined, out: RawRef[], flags: { conditional: boolean }): void {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, via, out, flags);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (keys.length === 1) {
    const [key] = keys;
    const arg = obj[key];
    if (key === "Ref" && typeof arg === "string") {
      if (!AWS_PSEUDO.test(arg)) out.push({ target: arg, attr: "Ref", via });
      return;
    }
    if (key === "Fn::GetAtt") {
      // Both encodings: ["LogicalId", "Attr"] and the "LogicalId.Attr" shorthand.
      const parts = Array.isArray(arg) ? arg : typeof arg === "string" ? arg.split(".") : [];
      const [id, ...rest] = parts;
      if (typeof id === "string" && !AWS_PSEUDO.test(id)) {
        out.push({ target: id, attr: rest.filter((p) => typeof p === "string").join(".") || "Ref", via });
      }
      // A GetAtt argument can itself be an intrinsic in the array form.
      if (Array.isArray(arg)) for (const item of arg) if (typeof item !== "string") refsIn(item, via, out, flags);
      return;
    }
    if (key === "Fn::ImportValue") {
      if (typeof arg === "string") out.push({ target: arg, attr: "Export", via, crossStack: true });
      else refsIn(arg, via, out, flags);
      return;
    }
    if (key === "Fn::Sub") {
      // `"...${LogicalId.Attr}..."` or `["...", { var: <expr> }]`.
      const body = Array.isArray(arg) ? arg[0] : arg;
      const vars = Array.isArray(arg) && arg[1] && typeof arg[1] === "object" ? (arg[1] as Record<string, unknown>) : {};
      const declared = new Set(Object.keys(vars));
      if (typeof body === "string") {
        for (const match of body.matchAll(/\$\{([^}]+)\}/g)) {
          const token = match[1].trim();
          if (AWS_PSEUDO.test(token) || declared.has(token) || token.startsWith("!")) continue;
          const dot = token.indexOf(".");
          const id = dot > 0 ? token.slice(0, dot) : token;
          out.push({ target: id, attr: dot > 0 ? token.slice(dot + 1) : "Ref", via });
        }
      }
      for (const inner of Object.values(vars)) refsIn(inner, via, out, flags);
      return;
    }
    if (key === "Fn::If") {
      flags.conditional = true;
      // The condition name is not a resource; its branches are.
      if (Array.isArray(arg)) for (const branch of arg.slice(1)) refsIn(branch, via, out, flags);
      return;
    }
  }

  for (const [key, inner] of Object.entries(obj)) refsIn(inner, via ?? key, out, flags);
}

/** The construct path a resource declares, normalized (CDK writes a leading `/` in places). */
function declaredPath(resource: CfnResource): string | undefined {
  const raw = resource.Metadata?.["aws:cdk:path"];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw.replace(/^\/+/, "");
}

/**
 * The property a CDK asset backs, when the resource is asset-backed at all.
 * `""` means asset metadata is present but names no property; `undefined` means
 * the resource carries no asset.
 */
function assetProperty(resource: CfnResource): string | undefined {
  const metadata = resource.Metadata ?? {};
  const prop = metadata["aws:asset:property"];
  if (typeof prop === "string") return prop;
  return Object.keys(metadata).some((k) => k.startsWith("aws:asset:")) ? "" : undefined;
}

/**
 * Strip an implicit `Resource`/`Default` leaf: the construct a person wrote is
 * the parent. Used only when tree metadata cannot say better.
 */
function ownerOf(path: string): string {
  const segments = path.split("/");
  if (segments.length > 1 && IMPLICIT_LEAF_IDS.has(segments[segments.length - 1])) segments.pop();
  return segments.join("/");
}

/**
 * The construct a resource ranks under: the shallowest ancestor inside the
 * stack that is an L2, an L3 or a nested stack. With no such ancestor (a bare
 * L1, or no tree metadata at all) it is the construct that owns the resource.
 */
function resolveUnit(
  resourcePath: string,
  stackPath: string,
  tree: Map<string, CdkTreeNode>,
): { path: string; level: ConstructLevel } {
  const inStack = resourcePath.startsWith(`${stackPath}/`) ? resourcePath.slice(stackPath.length + 1) : undefined;
  if (inStack) {
    const segments = inStack.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const candidate = `${stackPath}/${segments.slice(0, i).join("/")}`;
      const level = constructLevel(tree.get(candidate)?.constructInfo?.fqn);
      if (level === "l2" || level === "l3" || level === "nested") return { path: candidate, level };
    }
  }
  const owner = ownerOf(resourcePath);
  return { path: owner, level: constructLevel(tree.get(owner)?.constructInfo?.fqn) };
}

/** Every resource in a stack that describes infrastructure rather than synthesis. */
function realResources(stack: CdkStack): ResourceEntry[] {
  const entries: ResourceEntry[] = [];
  for (const [logicalId, resource] of Object.entries(stack.template.Resources ?? {})) {
    const type = typeof resource?.Type === "string" ? resource.Type : "";
    if (!type || SCAFFOLDING_TYPES.has(type)) continue;
    entries.push({
      logicalId,
      type,
      stack: stack.path,
      path: declaredPath(resource) ?? `${stack.path}/${logicalId}`,
      resource: resource ?? {},
    });
  }
  return entries;
}

/**
 * The unit's primary CloudFormation type — the one a carve would target. A
 * construct's own resource sits at `<construct>/Resource` or `<construct>/Default`
 * (or is the construct, for an L1); anything else is a supporting resource that
 * carves along with it. With no obvious principal, the shallowest member wins,
 * tie-broken by type so the answer does not depend on template key order.
 */
function primaryMember(unit: Unit): ResourceEntry | undefined {
  const principal = unit.members.find(
    (m) => m.path === unit.path || IMPLICIT_LEAF_IDS.has(m.path.slice(unit.path.length + 1)),
  );
  if (principal) return principal;
  return [...unit.members].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
  )[0];
}

/** The assembly's dependency graph, plus the signals only a CDK reader can see. */
export interface CdkCarveGraph {
  graph: TfGraph;
  /** Per-node scoring signals, keyed by construct path. */
  signals: Map<string, ScoreSignals>;
  diagnostics: string[];
}

/**
 * Placeholder values `cdk synth` writes when a context lookup could not be
 * answered. A template holding one describes an account that does not exist.
 */
const DUMMY_MARKERS = ["dummy-value-for-", "vpc-12345678", "dummy1a", "ami-1234", "s-12345"];

/**
 * Is the assembly a faithful picture of an account, or a guess? Either the
 * manifest admits an unresolved context query, or a template still carries the
 * placeholder that query would have replaced.
 */
export function dummyAssemblyReason(assembly: CloudAssembly): string | undefined {
  const missing = assembly.manifest.missing ?? [];
  if (missing.length > 0) {
    const providers = [...new Set(missing.map((m) => m.provider).filter((p): p is string => !!p))].sort();
    return (
      `The assembly was synthesized with ${missing.length} unresolved context lookup(s)` +
      `${providers.length ? ` (${providers.join(", ")})` : ""}, so its templates hold placeholder values rather ` +
      "than this account's. Prime the context and re-synthesize before advising."
    );
  }
  for (const stack of assembly.stacks) {
    const text = JSON.stringify(stack.template);
    const hit = DUMMY_MARKERS.find((marker) => text.includes(marker));
    if (hit) {
      return (
        `${stack.templateFile} still holds the context placeholder \`${hit}\`, so it describes a lookup that ` +
        "never resolved. Prime the context and re-synthesize before advising."
      );
    }
  }
  return undefined;
}

/**
 * Build the graph and the per-construct signals from a read assembly.
 *
 * Every resource folds into a construct, every construct becomes one node, and
 * every intrinsic becomes an edge between two nodes. Nothing is inferred: a
 * reference with no resolvable target is dropped rather than drawn.
 */
export function buildCdkGraph(assembly: CloudAssembly): CdkCarveGraph {
  const tree = indexTree(assembly.tree);
  const diagnostics = [...assembly.diagnostics];

  // Resources, grouped into units.
  const units = new Map<string, Unit>();
  /** logical ID → unit address, per stack. */
  const unitOfLogicalId = new Map<string, Map<string, string>>();
  const resourcesOf = new Map<string, ResourceEntry[]>();

  for (const stack of assembly.stacks) {
    const byLogicalId = new Map<string, string>();
    unitOfLogicalId.set(stack.path, byLogicalId);
    const entries = realResources(stack);
    resourcesOf.set(stack.path, entries);
    for (const entry of entries) {
      const { path, level } = resolveUnit(entry.path, stack.path, tree);
      const unit = units.get(path) ?? { path, kind: level === "l3" ? "module" : "resource", level, members: [] };
      unit.members.push(entry);
      units.set(path, unit);
      byLogicalId.set(entry.logicalId, path);
    }
  }

  // Cross-stack exports: export name → the refs the exporting stack's output
  // resolves to, so an ImportValue lands on a real construct rather than a name.
  interface ExportEntry {
    stack: string;
    refs: RawRef[];
  }
  const exports = new Map<string, ExportEntry>();
  for (const stack of assembly.stacks) {
    for (const output of Object.values(stack.template.Outputs ?? {})) {
      const name = output?.Export?.Name;
      if (typeof name !== "string") continue;
      const refs: RawRef[] = [];
      refsIn(output.Value, "Value", refs, { conditional: false });
      exports.set(name, { stack: stack.path, refs });
    }
  }

  // Edges.
  const rawEdges: TfEdge[] = [];
  const consumedExports = new Set<string>();
  const push = (from: string, to: string, attrs: string[], via: string[], crossStack?: boolean): void => {
    if (!from || !to || from === to) return;
    rawEdges.push({ from, to, attrs, via, ...(crossStack ? { crossStack: true } : {}) });
  };

  /** Resolve a raw ref to the unit(s) it names, following exports across stacks. */
  const targetsOf = (ref: RawRef, stackPath: string): Array<{ address: string; crossStack: boolean }> => {
    if (ref.crossStack) {
      const entry = exports.get(ref.target);
      if (!entry) return [];
      consumedExports.add(ref.target);
      const local = unitOfLogicalId.get(entry.stack);
      return entry.refs
        .map((inner) => local?.get(inner.target))
        .filter((address): address is string => !!address)
        .map((address) => ({ address, crossStack: true }));
    }
    const address = unitOfLogicalId.get(stackPath)?.get(ref.target);
    return address ? [{ address, crossStack: false }] : [];
  };

  const dynamicUnits = new Set<string>();
  /** unit address → the property the asset backs, `""` when CDK did not name one. */
  const assetUnits = new Map<string, string>();

  for (const stack of assembly.stacks) {
    const parameters = new Set(Object.keys(stack.template.Parameters ?? {}));
    for (const entry of resourcesOf.get(stack.path) ?? []) {
      const from = unitOfLogicalId.get(stack.path)?.get(entry.logicalId);
      if (!from) continue;
      const refs: RawRef[] = [];
      const flags = { conditional: !!entry.resource.Condition };
      refsIn(entry.resource.Properties, undefined, refs, flags);

      const asset = assetProperty(entry.resource);
      if (asset !== undefined && !assetUnits.get(from)) assetUnits.set(from, asset);

      for (const ref of refs) {
        if (!ref.crossStack && parameters.has(ref.target)) {
          // A template parameter, not a resource. The synthesizer's own
          // bootstrap/asset parameters say nothing about the author's design.
          if (isScaffoldingParameter(ref.target)) {
            if (ref.target.startsWith("AssetParameters") && !assetUnits.has(from)) assetUnits.set(from, "");
          } else {
            flags.conditional = true;
          }
          continue;
        }
        for (const target of targetsOf(ref, stack.path)) {
          push(from, target.address, [ref.attr], ref.via ? [ref.via] : [], target.crossStack);
        }
      }

      // `DependsOn` is an ordering dependency, and just as real a cut.
      const dependsOn = entry.resource.DependsOn;
      for (const id of Array.isArray(dependsOn) ? dependsOn : dependsOn ? [dependsOn] : []) {
        if (typeof id !== "string") continue;
        const address = unitOfLogicalId.get(stack.path)?.get(id);
        if (address) push(from, address, ["DependsOn"], ["DependsOn"]);
      }

      if (flags.conditional) dynamicUnits.add(from);
    }
  }

  // `Outputs` blocks reference without being nodes — the CloudFormation twin of
  // a Terraform `output` (#1638). An output whose export something imports is
  // skipped: the direct cross-stack edge already stands for that cut, and
  // counting both would charge one dependency twice.
  const outputEdges: TfEdge[] = [];
  for (const stack of assembly.stacks) {
    for (const [outputName, output] of Object.entries(stack.template.Outputs ?? {})) {
      const exportName = output?.Export?.Name;
      if (typeof exportName === "string" && consumedExports.has(exportName)) continue;
      const refs: RawRef[] = [];
      refsIn(output?.Value, "Value", refs, { conditional: false });
      for (const ref of refs) {
        for (const target of targetsOf(ref, stack.path)) {
          outputEdges.push({
            from: `output.${stack.path}.${outputName}`,
            to: target.address,
            attrs: [ref.attr],
            via: ["Value"],
            fromKind: "output",
          });
        }
      }
    }
  }

  // Nodes.
  const nodes: TfNode[] = [];
  const signals = new Map<string, ScoreSignals>();
  const dummyReason = dummyAssemblyReason(assembly);

  for (const unit of units.values()) {
    const primary = primaryMember(unit);
    const type = unit.kind === "module" ? undefined : primary?.type;
    const nested = unit.level === "nested" || primary?.type === NESTED_STACK_TYPE;
    const assetProp = assetUnits.get(unit.path);
    const stacks = [...new Set(unit.members.map((m) => m.stack))].sort();

    nodes.push({
      address: unit.path,
      kind: unit.kind,
      ...(type ? { type } : {}),
      name: unit.path.split("/").pop() ?? unit.path,
      instances: 1,
      hasDynamic: dynamicUnits.has(unit.path),
    });

    const members: CarveUnitMember[] = [...unit.members]
      .sort((a, b) => (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0))
      .map((m) => ({ id: m.logicalId, type: m.type, stack: m.stack, path: m.path }));

    const notes: string[] = [];
    if (unit.kind === "module") {
      notes.push(
        "L3 construct subtree — a Composite candidate (#1000). Its leaves rank here as one unit rather than separately.",
      );
    }
    if (assetProp !== undefined) {
      notes.push(
        `Asset-backed${assetProp ? ` (${assetProp})` : ""} — carving it moves the CDK bundling too, not just the resource.`,
      );
    }
    if (unit.members.length > 1) {
      notes.push(`${unit.members.length} CloudFormation resources fold into this construct.`);
    }
    if (stacks.length > 1) notes.push(`Spans ${stacks.length} stacks: ${stacks.join(", ")}.`);
    if (type && !nested && resolveCfnTier(type) === null) {
      notes.push(`No chant AWS lexicon target for ${type}.`);
    }

    const disqualified = dummyReason
      ? dummyReason
      : nested
        ? "Nested stack — its resources live in a template this advisor does not descend into, so carving it means " +
          "carving that whole template. Advise the nested assembly on its own."
        : undefined;

    signals.set(unit.path, {
      ...(assetProp !== undefined && !disqualified ? { penalties: { asset: -10 } } : {}),
      ...(notes.length ? { notes } : {}),
      members,
      ...(disqualified ? { disqualified } : {}),
    });
  }

  if (dummyReason) diagnostics.push(dummyReason);

  // Merge duplicate edges (same pair), then order by code point so the report
  // is stable across platforms and template key order.
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const merged = new Map<string, TfEdge>();
  for (const edge of [...rawEdges, ...outputEdges]) {
    const key = `${edge.from}|${edge.to}|${edge.fromKind ?? ""}`;
    const prev = merged.get(key);
    if (prev) {
      prev.attrs = [...new Set([...prev.attrs, ...edge.attrs])].sort(cmp);
      prev.via = [...new Set([...prev.via, ...edge.via])].sort(cmp);
      if (edge.crossStack) prev.crossStack = true;
    } else {
      merged.set(key, { ...edge, attrs: [...new Set(edge.attrs)].sort(cmp), via: [...new Set(edge.via)].sort(cmp) });
    }
  }

  return {
    graph: {
      nodes: nodes.sort((a, b) => cmp(a.address, b.address)),
      edges: [...merged.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
    },
    signals,
    diagnostics,
  };
}
