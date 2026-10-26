/**
 * Which files of a directory are a root's configuration, and how a JSON-syntax
 * one reads (chant#4457). Every lister in the lexicon asks here, so the parser,
 * change detection, the backend readers, the report and the rollout pin all
 * see the same file set for one root.
 *
 * The set follows the root's binary. Terraform reads `.tf` and `.tf.json`.
 * OpenTofu (and choudoufu, which is OpenTofu) also reads `.tofu` and
 * `.tofu.json`, and when `x.tofu` and `x.tf` both exist it reads `x.tofu`
 * only (likewise `x.tofu.json` over `x.tf.json`). A binary that is not given
 * is `terraform`, the config's default.
 *
 * `parse.ts` re-exports all of this; the module is separate so the readers
 * that never parse HCL (`state/backend.ts`, `changed-roots.ts`) do not load
 * the parser's dependencies.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The configuration file suffixes Terraform reads. */
export const TERRAFORM_SUFFIXES: readonly string[] = [".tf", ".tf.json"];
/** The ones OpenTofu reads as well. */
export const TOFU_SUFFIXES: readonly string[] = [".tofu", ".tofu.json"];

/** Whether a root run by `binary` reads `.tofu` files: `tofu` and `choudoufu` do (by name or path), `terraform` and an unset binary do not. */
export function readsTofuFiles(binary?: string): boolean {
  const base = (binary ?? "terraform").split(/[\\/]/).pop() ?? "";
  return base.startsWith("tofu") || base.startsWith("choudoufu");
}

/** Whether `name` is a configuration file in Terraform's JSON syntax (`.tf.json`, `.tofu.json`). */
export function isJsonConfigFile(name: string): boolean {
  return name.endsWith(".tf.json") || name.endsWith(".tofu.json");
}

/** Whether `name` is a `.tofu` or `.tofu.json` file. */
export function isTofuConfigFile(name: string): boolean {
  return TOFU_SUFFIXES.some((s) => name.endsWith(s));
}

/** Whether `name` is a configuration file a root run by `binary` reads, before the `.tofu`-over-`.tf` rule. */
export function isConfigFileFor(name: string, binary?: string): boolean {
  if (TERRAFORM_SUFFIXES.some((s) => name.endsWith(s))) return true;
  return readsTofuFiles(binary) && isTofuConfigFile(name);
}

/**
 * The configuration files among `names` a root run by `binary` reads, in
 * filename order. For a tofu or choudoufu root, `x.tf` is dropped when
 * `x.tofu` is present and `x.tf.json` when `x.tofu.json` is, which is
 * OpenTofu's own rule. Names may carry a directory; the rule compares names
 * in the same directory.
 */
export function selectConfigFiles(names: Iterable<string>, binary?: string): string[] {
  const kept = [...names].filter((n) => isConfigFileFor(n, binary));
  const present = new Set(kept);
  return kept
    .filter((n) => {
      if (n.endsWith(".tf")) return !present.has(`${n.slice(0, -".tf".length)}.tofu`);
      if (n.endsWith(".tf.json")) return !present.has(`${n.slice(0, -".tf.json".length)}.tofu.json`);
      return true;
    })
    .sort();
}

/**
 * The configuration files directly under `dir` a root run by `binary` reads,
 * by name, in filename order. Non-recursive, matching Terraform's module
 * scoping; directories named like a file are left out. Throws when `dir`
 * cannot be read.
 */
export function listConfigFiles(dir: string, binary?: string): string[] {
  const files = readdirSync(dir).filter((n) => {
    if (!isConfigFileFor(n, binary)) return false;
    try {
      return statSync(join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
  return selectConfigFiles(files, binary);
}

/** {@link listConfigFiles}, empty when `dir` cannot be read. */
export function listConfigFilesSafe(dir: string, binary?: string): string[] {
  try {
    return listConfigFiles(dir, binary);
  } catch {
    return [];
  }
}

/**
 * The nested blocks a JSON-syntax body can carry that hcl2json would give as
 * arrays, by block type: each entry is the nested block's label count and its
 * own nested blocks. Anything not named here is an attribute and is kept as
 * written, since JSON syntax cannot tell a nested block from an object
 * attribute without the provider's schema.
 */
interface BlockShape {
  labels: number;
  nested?: Record<string, BlockShape>;
  /**
   * Attributes JSON syntax writes as a bare expression in a string (a type,
   * a reference), where HCL writes the expression itself and hcl2json gives
   * it as `"${...}"`. Their strings are wrapped the same way.
   */
  exprs?: readonly string[];
}

const LIFECYCLE: BlockShape = { labels: 0, exprs: ["ignore_changes", "replace_triggered_by"] };
const RESOURCE_NESTED: Record<string, BlockShape> = {
  lifecycle: LIFECYCLE,
  provisioner: { labels: 1, nested: { connection: { labels: 0 } } },
  connection: { labels: 0 },
};
const REFERS = ["provider", "depends_on"];

const TOP_LEVEL: Record<string, BlockShape> = {
  terraform: {
    labels: 0,
    nested: {
      backend: { labels: 1 },
      cloud: { labels: 0, nested: { workspaces: { labels: 0 } } },
      required_providers: { labels: 0 },
      provider_meta: { labels: 1 },
      live: { labels: 0 },
    },
  },
  locals: { labels: 0 },
  provider: { labels: 1 },
  module: { labels: 1, exprs: ["depends_on", "providers"] },
  variable: { labels: 1, nested: { validation: { labels: 0 } }, exprs: ["type"] },
  output: { labels: 1, nested: { precondition: { labels: 0 } }, exprs: ["depends_on"] },
  resource: { labels: 2, nested: RESOURCE_NESTED, exprs: REFERS },
  data: { labels: 2, nested: { lifecycle: LIFECYCLE }, exprs: REFERS },
  moved: { labels: 0, exprs: ["from", "to"] },
  import: { labels: 0, exprs: ["to", "provider"] },
  removed: { labels: 0, nested: { lifecycle: LIFECYCLE, provisioner: RESOURCE_NESTED.provisioner! }, exprs: ["from"] },
  check: { labels: 1, nested: { data: { labels: 2 }, assert: { labels: 0 } } },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A bare expression string as hcl2json writes the expression: `aws.west` becomes `${aws.west}`; a template is kept. */
function asExpression(v: unknown): unknown {
  if (typeof v === "string") return v.includes("${") ? v : `\${${v}}`;
  if (Array.isArray(v)) return v.map(asExpression);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asExpression(x)]));
  return v;
}

/** A JSON body with its `"//"` comment keys dropped (Terraform ignores them), its known nested blocks wrapped and its expression attributes written as hcl2json writes them. */
function normaliseBody(body: unknown, shape: BlockShape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObject(body)) return out;
  for (const [k, v] of Object.entries(body)) {
    if (k === "//") continue;
    const inner = shape.nested?.[k];
    out[k] = inner ? wrapBlock(v, inner) : shape.exprs?.includes(k) ? asExpression(v) : v;
  }
  return out;
}

/**
 * A block in JSON syntax as hcl2json gives the same block in HCL: one object
 * level per label, then an array of bodies. JSON syntax writes a single body
 * as an object or several as an array, and allows an array of objects at a
 * label level to be merged, so both are read.
 */
function wrapBlock(value: unknown, shape: BlockShape, labels = shape.labels): unknown {
  if (labels === 0) return (Array.isArray(value) ? value : [value]).filter(isObject).map((b) => normaliseBody(b, shape));
  const out: Record<string, unknown> = {};
  for (const part of Array.isArray(value) ? value : [value]) {
    if (!isObject(part)) continue;
    for (const [label, inner] of Object.entries(part)) {
      if (label === "//") continue;
      const wrapped = wrapBlock(inner, shape, labels - 1);
      const had = out[label];
      if (Array.isArray(had) && Array.isArray(wrapped)) out[label] = [...had, ...wrapped];
      else if (isObject(had) && isObject(wrapped)) out[label] = mergeLabelled(had, wrapped);
      else out[label] = wrapped;
    }
  }
  return out;
}

function mergeLabelled(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const had = out[k];
    if (Array.isArray(had) && Array.isArray(v)) out[k] = [...had, ...v];
    else if (isObject(had) && isObject(v)) out[k] = mergeLabelled(had, v);
    else out[k] = v;
  }
  return out;
}

/**
 * A `.tf.json` or `.tofu.json` document in the tree shape hcl2json gives an
 * HCL file, so `blocksToEntities` reads both the same way. Top-level keys it
 * does not know are kept as written. Throws on malformed JSON, as hcl2json
 * throws on malformed HCL.
 */
export function jsonConfigTree(source: string): Record<string, unknown> {
  const doc: unknown = JSON.parse(source);
  if (!isObject(doc)) throw new Error("a JSON configuration file must hold an object");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "//") continue;
    const shape = TOP_LEVEL[k];
    out[k] = shape ? wrapBlock(v, shape) : v;
  }
  return out;
}
