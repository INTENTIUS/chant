/**
 * How a carved Terraform type is read back as a `data` source (#2034).
 *
 * `carve bridge` replaces a carved resource with a data source the survivors
 * read instead. Until now a carve provider said only which attribute carries
 * the physical name (`identityAttrs`), and the bridge assumed the data source
 * was the same type as the resource, with that one attribute in its body:
 *
 *     data "aws_s3_bucket" "assets" { bucket = "myapp-assets-prod" }
 *
 * That assumption holds for AWS and google, and breaks for Kubernetes twice
 * over. `kubernetes_manifest` names itself by `manifest.metadata.name`, a path
 * into a nested value that a flat `attr = value` body cannot express; and the
 * kubernetes provider ships no `kubernetes_manifest` data source at all
 * (verified against hashicorp/kubernetes v3.2.1: 27 data sources, none a
 * manifest). Its generic read is `data "kubernetes_resource"`, with a
 * different type, different arguments, a nested `metadata` block, and its own
 * attribute path for survivors to read through.
 *
 * So a provider contributes a *shape*: the data-source type, where each
 * argument comes from in the carved body, and how a survivor's attribute path
 * translates. An identity attribute is one instance of that shape
 * ({@link identityAttrShape}), so nothing that bridges today changes.
 */

/** One argument of the data-source body, and where its value comes from. */
export interface ShapeField {
  /** Argument name in the emitted data source, e.g. `api_version`. */
  name: string;
  /**
   * Dotted path into the carved resource's HCL body the literal is read from,
   * e.g. `manifest.apiVersion`. Nested blocks are walked by segment.
   */
  from: string;
  /**
   * A shape that cannot resolve a required field renders the TODO body rather
   * than a data source missing an argument Terraform needs.
   */
  required?: boolean;
}

/** A nested block in the data-source body, e.g. `metadata { name = "x" }`. */
export interface ShapeBlock {
  name: string;
  fields: readonly ShapeField[];
}

export interface DataSourceShape {
  /** The `data` type standing in for the carved resource, e.g. `kubernetes_resource`. */
  type: string;
  /** Flat `name = value` arguments of the body. */
  args?: readonly ShapeField[];
  /** Nested `name { ... }` blocks of the body. */
  blocks?: readonly ShapeBlock[];
  /**
   * The carved resource's top-level attribute → the data source's, for the
   * survivor rewrite. `kubernetes_manifest` exposes both `manifest` (what the
   * config declared) and `object` (the API server's read-back), and
   * `kubernetes_resource` exposes only `object`, so both map to `object`. An
   * attribute with no entry passes through unchanged, which is what every
   * same-type identity-attribute shape wants.
   */
  readAttrs?: Readonly<Record<string, string>>;
}

/**
 * The shape a plain identity attribute implies: the same type as the resource,
 * one required argument, no path translation. Returns undefined for a dotted
 * attribute, which is a path into nested values and needs a declared shape.
 */
export function identityAttrShape(tfType: string, attr: string): DataSourceShape | undefined {
  if (attr.includes(".")) return undefined;
  return { type: tfType, args: [{ name: attr, from: attr, required: true }] };
}

/** Every source path the shape reads, for the graph to resolve out of the carved block. */
export function shapeSourcePaths(shape: DataSourceShape): string[] {
  const paths = (shape.args ?? []).map((f) => f.from);
  for (const block of shape.blocks ?? []) for (const f of block.fields) paths.push(f.from);
  return [...new Set(paths)];
}

/**
 * Translate a survivor's attribute path onto the data source. `path` is the
 * text after the address, leading dot included (`.manifest.data.log_level`) or
 * empty. Only the first segment is mapped: everything under it is the object's
 * own structure, which the data source reproduces.
 */
export function rewriteReadPath(shape: DataSourceShape | undefined, path: string): string {
  if (!path || !shape?.readAttrs) return path;
  const [head, ...rest] = path.slice(1).split(".");
  const mapped = shape.readAttrs[head];
  if (mapped === undefined) return path;
  return `.${[mapped, ...rest].join(".")}`;
}
