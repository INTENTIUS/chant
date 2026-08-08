/**
 * Types for the read-only Terraform carve-out advisor (#214).
 *
 * The advisor never emits, patches, or mutates state. It parses a Terraform
 * estate into a dependency graph and scores each resource/module by
 * "peelability" — how cleanly it could later be carved into native chant
 * source (the emit/boundary/apply phases stay in #197, gated on demand).
 *
 * The graph layer here is intentionally pure: it consumes the JSON shape
 * `@cdktf/hcl2json` produces (see `parse.ts`), so the graph and scoring can
 * be tested without loading the wasm parser.
 */

/** A node in the Terraform dependency graph — one resource or module block. */
export interface TfNode {
  /** Terraform address, e.g. `aws_s3_bucket.assets` or `module.cdn`. */
  address: string;
  kind: "resource" | "module";
  /** Resource type (`aws_s3_bucket`); undefined for modules. */
  type?: string;
  /** Local name (`assets`) or module name (`cdn`). */
  name: string;
  /**
   * State-expanded instance count. 1 unless `count`/`for_each` is present and
   * a `.tfstate` was read (see `state.ts`, #214 T2). Without state, a block
   * with `count`/`for_each` reports 1 and sets `hasDynamic`.
   */
  instances: number;
  /** `count`, `for_each`, a `data` source, or an unresolved interpolation is present. */
  hasDynamic: boolean;
  /**
   * The resource's physical name, when it is a plain literal in the HCL (e.g.
   * `bucket = "myapp-assets-prod"`). Used to build the live-import selector on
   * emit. Undefined when the identity attribute is absent or interpolated.
   */
  identity?: string;
}

/**
 * A directed dependency edge: `from` references `to`.
 *
 * For a candidate carve target T:
 *  - inbound  = edges where `to === T`  (surviving resources depend on T → each is a data-source patch)
 *  - outbound = edges where `from === T` (T depends on survivors → a deferred deploy-time input)
 */
export interface TfEdge {
  from: string;
  to: string;
  /** The attribute path(s) referenced, e.g. `["id", "arn"]`. */
  attrs: string[];
  /**
   * The referring block's own top-level attribute(s) the reference sits in,
   * e.g. `["vpc_id"]` for a subnet reading its VPC (#998). This is what a
   * deferred outbound input is named after when emit turns it into a build
   * parameter. Empty when the reference came from a non-object block shape.
   */
  via: string[];
}

export interface TfGraph {
  nodes: TfNode[];
  edges: TfEdge[];
}

/**
 * The subset of `@cdktf/hcl2json`'s `parse()` output the advisor reads. A
 * merged tree across every `.tf` file in the estate. Values are left as the
 * raw hcl2json encoding (interpolations survive as `"${...}"` strings), which
 * is what edge extraction scans.
 */
export interface Hcl2JsonTree {
  resource?: Record<string, Record<string, unknown[]>>;
  module?: Record<string, unknown[]>;
  data?: Record<string, Record<string, unknown[]>>;
  [k: string]: unknown;
}
