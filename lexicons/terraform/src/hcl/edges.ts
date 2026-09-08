/**
 * Resolve each block's references into graph edges (chant #2265).
 *
 * `chant graph --format ir` used to emit a complete, module-descended,
 * fully-attributed node set for a Terraform estate and zero edges. Core's
 * `collectEdges` walks a node's config bag for `AttrRef` objects and `Ref`
 * intrinsics; a block body out of hcl2json holds `"${aws_vpc.main.id}"`, a
 * string, so the walk found nothing and said so. This module supplies what
 * that walk cannot see: the references, already resolved to the entity keys
 * `blocksToEntities` minted, published on each entity as core's lexicon-neutral
 * `EntityReference` (see `@intentius/chant/graph-ir`).
 *
 * ## Where the reference forms come from
 *
 * The `${...}` body is tokenized by hcl2json's own expression AST
 * (`getReferencesInExpression`), never by a regex over the string. That is the
 * same instrument `packages/core/src/terraform/parse.ts` uses for the carve-out
 * advisor, and for the same reason: a quoted address used as a map key
 * (`var.m["aws_s3_bucket.assets.arn"]`) and an escaped `$${...}` literal are
 * not references, and no regex over the raw string can tell. `./references.ts`
 * IS such a regex scan and stays one: it answers "is this declaration used
 * anywhere", deliberately generously, for a report-only rule. An edge a
 * renderer draws is a stricter claim and gets the stricter instrument.
 *
 * Each accessor the AST returns is classified by core's own `refFromAccessor`
 * for the three forms it already knows (`<type>.<name>`, `module.<name>`,
 * `data.<type>.<name>`), and here for the two it deliberately excludes as
 * non-resources, `var.<name>` and `local.<name>`.
 *
 * ## Four decisions a renderer will draw
 *
 * **Which forms become edges.** All five: `resource`, `data`, `module`, `var`
 * and `local`. The first three are uncontroversial. The last two are edges
 * because this lexicon emits a NODE for every `variable` and every `locals`
 * block, and on a real estate those are the majority of them (108 variables
 * and 10 locals out of 247 nodes, on the estate the issue was filed against).
 * Dropping their edges would leave nearly half the graph as unconnected cards,
 * which is the same picture the zero-edge bug drew. "Which resources consume
 * `var.region`" is also a question a reader of a root module actually asks,
 * and `terraform graph` itself answers it.
 *
 * A `local.<name>` resolves to the `locals` BLOCK that declares that name,
 * found by looking `name` up in each block's body, so two `locals` blocks in
 * one scope resolve independently rather than both matching.
 *
 * `provider = aws.west` is NOT an edge. The reference names a `provider`
 * block by type AND alias, and this lexicon's entity key for one is
 * `provider.<type>` with the alias inside the body, so two aliased providers
 * of one type key as `provider.aws` and `provider.aws~2` and the reference
 * cannot be resolved to either without guessing. `./references.ts` still
 * records it for TF020, where "is it used at all" is answerable without
 * knowing which block.
 *
 * **`depends_on` is an edge.** It arrives from hcl2json as
 * `["${aws_vpc.main}"]` under the key `depends_on`, so it resolves through the
 * same path as any other reference and lands as `viaAttr: "depends_on"` with
 * no `toAttr`, which is exactly what it is: an ordering edge with no attribute
 * flowing along it.
 *
 * **`count` / `for_each` are block-to-block.** chant's entity is the block, so
 * `count = 3` is one node and one edge, not three. The expansion itself is
 * recorded on the entity (`props.expansion`, `./parse.ts`) rather than left to
 * be inferred from a node count that never grows. A `count = length(var.x)`
 * also yields a real edge to `var.x` through `viaAttr: "count"`, since the
 * meta-argument is an expression like any other.
 *
 * **Attribute naming.** `viaAttr` is the consumer-side TOP-LEVEL attribute the
 * reference sits under and `toAttr` the producer-side attribute it read, which
 * is the same pair carve's `TfEdge` carries as `via` and `attrs` and the pair
 * behold already renders. One edge per (consumer, producer, `viaAttr`), and
 * `toAttr` is set only when that edge read exactly one producer attribute:
 * `subnet_id = aws_subnet.a.id` gives `id`, while
 * `tags = merge(aws_vpc.main.tags, { id = aws_vpc.main.id })` names two and
 * gets none rather than an arbitrary one.
 *
 * ## Scope, and what is deliberately not resolved
 *
 * Resolution is bounded to the referring block's own module scope
 * (`scopeOfKey`), which is Terraform's own namespace: a `var.region` inside
 * `module.cdn` is the child module's variable and never the root's. That also
 * means no edge ever crosses roots, which is correct and intended (#2265):
 * separate roots read each other by NAME through a data source, never by
 * reference, and a value-match pass over those is a consumer's job, not this
 * one's.
 */

import { isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import type { EntityReference } from "@intentius/chant/graph-ir";
import { loadHcl2json, type Hcl2Json } from "@intentius/chant/terraform/parse";
import { refFromAccessor } from "@intentius/chant/terraform/graph";
import { LOCALS_TYPE, scopeOfKey, type BlockBody, type TerraformEntity } from "./parse";

/** An identifier as Terraform's grammar allows it. Same as `./references.ts`. */
const NAME = "[A-Za-z_][A-Za-z0-9_-]*";

/** `var.<name>` / `local.<name>` at the head of a traversal accessor. */
const SCALAR_HEAD_RE = new RegExp(`^(var|local)\\.(${NAME})(?:\\.|$)`);

/** One reference read out of a body, before it is resolved to an entity key. */
interface RawReference {
  /** The address in this lexicon's own vocabulary: `aws_vpc.main`, `var.region`, `local.tags`. */
  address: string;
  /** Producer-side attribute, when the accessor named one. */
  attr?: string;
  /** Consumer-side top-level attribute the reference sits under. */
  via: string;
}

/**
 * Classify one AST traversal accessor. `var`/`local` are handled here because
 * core's `refFromAccessor` excludes them by design (they are not carvable
 * resources); everything else defers to it, quoted map keys and numeric
 * indexes included.
 */
export function referenceFromAccessor(accessor: string): { address: string; attr?: string } | undefined {
  const scalar = SCALAR_HEAD_RE.exec(accessor);
  if (scalar) return { address: `${scalar[1]}.${scalar[2]}` };
  return refFromAccessor(accessor) ?? undefined;
}

/** Every `${...}` string in a body, paired with the top-level attribute it sits under. */
function expressionsInBody(body: BlockBody): Array<{ via: string; expression: string }> {
  const out: Array<{ via: string; expression: string }> = [];
  const visit = (value: unknown, via: string, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === "string") {
      if (value.includes("${")) out.push({ via, expression: value });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, via, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        visit(inner, depth === 0 ? key : via, depth + 1);
      }
    }
  };
  visit(body, "", 0);
  return out;
}

/** The `${...}` strings of every entity in the map, deduplicated. */
function allExpressions(entities: ReadonlyMap<string, Declarable>): string[] {
  const seen = new Set<string>();
  for (const entity of entities.values()) {
    if (!isResourceDeclarable(entity)) continue;
    const body = bodyOf(entity as TerraformEntity);
    for (const { expression } of expressionsInBody(body)) seen.add(expression);
  }
  return [...seen];
}

function bodyOf(entity: TerraformEntity): BlockBody {
  const props = entity.props as Partial<TerraformEntity["props"]>;
  return (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
}

/**
 * Resolve every expression once through the AST. An expression the parser
 * refuses in isolation resolves to no references: fewer edges, never a phantom
 * one, which is the same trade `resolveExpressionRefs` makes in core.
 */
async function resolveAccessors(
  parser: Hcl2Json,
  expressions: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const expression of expressions) {
    try {
      const found = await parser.getReferencesInExpression("expression.tf", expression);
      out.set(
        expression,
        found.map((r) => r.value),
      );
    } catch {
      out.set(expression, []);
    }
  }
  return out;
}

/** Address to entity key, and local name to the `locals` block declaring it, per module scope. */
export interface ScopeIndex {
  byAddress: Map<string, string>;
  byLocal: Map<string, string>;
}

function buildScopeIndex(entities: ReadonlyMap<string, Declarable>): Map<string, ScopeIndex> {
  const scopes = new Map<string, ScopeIndex>();
  for (const [key, entity] of entities) {
    if (!isResourceDeclarable(entity)) continue;
    const te = entity as TerraformEntity;
    const address = (te.props as Partial<TerraformEntity["props"]>).address;
    if (typeof address !== "string") continue;
    const scope = scopeOfKey(key);
    let index = scopes.get(scope);
    if (!index) {
      index = { byAddress: new Map(), byLocal: new Map() };
      scopes.set(scope, index);
    }
    // First key wins: two blocks that genuinely share an address are keyed
    // `~2`, `~3` (`./parse.ts`), and a reference cannot say which it meant.
    if (!index.byAddress.has(address)) index.byAddress.set(address, key);
    if (te.entityType === LOCALS_TYPE) {
      for (const name of Object.keys(bodyOf(te))) {
        if (!index.byLocal.has(name)) index.byLocal.set(name, key);
      }
    }
  }
  return scopes;
}

/** The entity key an address names within one scope, or undefined. */
function resolveAddress(address: string, index: ScopeIndex): string | undefined {
  if (address.startsWith("local.")) return index.byLocal.get(address.slice("local.".length));
  return index.byAddress.get(address);
}

/** Every reference in one body, as raw addresses paired with the attribute they sit under. */
function rawReferences(body: BlockBody, accessors: ReadonlyMap<string, readonly string[]>): RawReference[] {
  const out: RawReference[] = [];
  for (const { via, expression } of expressionsInBody(body)) {
    for (const accessor of accessors.get(expression) ?? []) {
      const ref = referenceFromAccessor(accessor);
      if (ref) out.push({ address: ref.address, ...(ref.attr ? { attr: ref.attr } : {}), via });
    }
  }
  return out;
}

/**
 * The references one block declares, resolved to entity keys and collapsed to
 * one entry per (producer, `viaAttr`). Sorted, so the IR a build emits is
 * byte-stable across runs.
 */
export function referencesOfEntity(
  key: string,
  entity: TerraformEntity,
  scopes: ReadonlyMap<string, ScopeIndex>,
  accessors: ReadonlyMap<string, readonly string[]>,
): EntityReference[] {
  const index = scopes.get(scopeOfKey(key));
  if (!index) return [];

  const grouped = new Map<string, { to: string; viaAttr: string; attrs: Set<string> }>();
  for (const raw of rawReferences(bodyOf(entity), accessors)) {
    const to = resolveAddress(raw.address, index);
    if (!to || to === key) continue;
    const groupKey = `${to} ${raw.via}`;
    let group = grouped.get(groupKey);
    if (!group) {
      group = { to, viaAttr: raw.via, attrs: new Set() };
      grouped.set(groupKey, group);
    }
    if (raw.attr) group.attrs.add(raw.attr);
  }

  const out: EntityReference[] = [];
  for (const { to, viaAttr, attrs } of grouped.values()) {
    out.push({
      to,
      ...(viaAttr ? { viaAttr } : {}),
      // Exactly one, or none: an edge carrying an arbitrary pick out of two
      // would be a label a reader cannot trust.
      ...(attrs.size === 1 ? { toAttr: [...attrs][0] } : {}),
    });
  }
  return out.sort((a, b) => cmp(a.to, b.to) || cmp(a.viaAttr ?? "", b.viaAttr ?? ""));
}

/** Code-point ordering, so output does not depend on the machine's locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stamp `references` onto every terraform entity in `entities`, in place.
 *
 * Takes the whole build's entity map rather than one root's, because one
 * shared expression cache across every root is what keeps this to one wasm
 * call per DISTINCT expression instead of one per occurrence. Resolution is
 * still per module scope, so pooling the parse pools no references.
 *
 * Best effort, like everything else on this path: a parser that cannot be
 * loaded, or one that does not expose the expression AST, leaves every entity
 * unreferenced rather than failing a build over a diagram.
 */
export async function resolveEntityReferences(
  entities: Map<string, Declarable>,
  hcl2json?: Hcl2Json,
): Promise<void> {
  const expressions = allExpressions(entities);
  if (expressions.length === 0) return;

  let parser: Hcl2Json;
  try {
    parser = hcl2json ?? (await loadHcl2json());
  } catch {
    return;
  }
  if (typeof parser.getReferencesInExpression !== "function") return;

  const accessors = await resolveAccessors(parser, expressions);
  const scopes = buildScopeIndex(entities);

  for (const [key, entity] of entities) {
    if (!isResourceDeclarable(entity)) continue;
    const te = entity as TerraformEntity;
    const references = referencesOfEntity(key, te, scopes, accessors);
    if (references.length === 0) continue;
    const stamped: TerraformEntity = { ...te, references };
    entities.set(key, stamped);
  }
}
