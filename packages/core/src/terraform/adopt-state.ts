/**
 * Adopt a Terraform-managed resource into chant source from its `.tfstate`
 * (#1009). This is the correct adoption source for carving OUT of Terraform:
 * a TF resource is created through the provider API, not CloudFormation, so it
 * is not in any CFN stack — but its resolved attributes ARE in the state file.
 *
 * chant AWS constructors take CloudFormation PascalCase properties (e.g.
 * `new Bucket({ BucketName })`), while Terraform state uses the provider's
 * snake_case attributes (`bucket`, `tags`). The mapping is driven by the single
 * AWS carve-out table (`aws-resources.ts`) — the same table the advisor's tier
 * map derives from, so every AWS type advise ranks can be emitted. Attributes
 * without a mapping are preserved in a reference comment, never dropped.
 *
 * Deferred outbound inputs (#998): an attribute whose value the Terraform
 * source read from a survivor (`vpc_id = aws_vpc.main.id`) is not a fact of
 * the carved resource — it is a deploy-time input. Those props are emitted as
 * `params.<name>` references instead of frozen literals, with the state's
 * resolved value as the declared default (see `carve-emit.ts`'s scaffold).
 */

import { AWS_CARVE_TYPES, AWS_LEXICON_IMPORT, awsCarveType, applyAwsMapper } from "./aws-resources";
import type { StateResource } from "./state";

/** The core subpath the emitted source reads build parameters from. */
export const PARAMS_IMPORT = "@intentius/chant/params";

/**
 * One deferred outbound input turned into a build parameter (#998). Derived
 * from the boundary report's outbound edges + the state's resolved attributes
 * in `carve-emit.ts`; consumed here (source substitution) and by the scaffold
 * (`chant.config.ts` `buildParams` declaration).
 */
export interface DeferredParam {
  /** Build-parameter name, source-referenceable (`params.<name>`). */
  name: string;
  /** The carved resource's own Terraform attribute the value enters through. */
  tfAttr: string;
  /** The survivor the Terraform source read, e.g. `aws_vpc.main`. */
  survivor: string;
  /** Survivor attribute(s) read, e.g. `["id"]`. */
  attrs: string[];
  /** The state-resolved value — the parameter's declared default. */
  default?: string | number | boolean;
}

export interface AdoptedSource {
  fileName: string;
  content: string;
  /** True when at least one attribute was mapped to a native prop. */
  mapped: boolean;
  nativeType: string;
  /** Deferred params actually substituted into the emitted props (#998). */
  parameterized: string[];
}

/** Is this Terraform type adoptable from state (has a native constructor)? */
export function canAdoptFromState(tfType: string): boolean {
  return awsCarveType(tfType) !== undefined;
}

/** Terraform types that can currently be adopted from state, for user-facing hints. */
export function supportedStateAdoptionTypes(): string[] {
  return AWS_CARVE_TYPES.map((t) => t.tfType).sort();
}

/** Marker for a prop whose value is a `params.<name>` reference, not a literal. */
class ParamRef {
  constructor(
    readonly name: string,
    readonly type: "string" | "number" | "boolean",
  ) {}
}

/**
 * Render chant source for a state-adopted resource. Emits the native
 * constructor with mapped properties, plus a reference comment listing the
 * Terraform attributes that were not mapped so nothing is silently dropped.
 *
 * A mapped attribute named by a `DeferredParam` renders as a `params.<name>`
 * reference (a real chant build parameter) instead of the state literal —
 * the value came from a survivor, so it stays overridable per build.
 */
export function adoptFromState(resource: StateResource, params: DeferredParam[] = []): AdoptedSource | null {
  const entry = awsCarveType(resource.type);
  if (!entry) return null;

  const { props, mappedKeys } = applyAwsMapper(entry, resource.attributes);

  // Substitute deferred inputs: only plain (untransformed) field mappings can
  // carry a parameter reference — a transform ran against the literal at emit
  // time and cannot re-run at build. Everything else keeps the state literal.
  const parameterized: string[] = [];
  for (const param of params) {
    const spec = entry.fields[param.tfAttr];
    if (typeof spec !== "string" || !(spec in props)) continue;
    const type = typeof param.default === "number" ? "number" : typeof param.default === "boolean" ? "boolean" : "string";
    props[spec] = new ParamRef(param.name, type);
    parameterized.push(param.name);
  }

  const unmapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(resource.attributes)) {
    if (!mappedKeys.includes(k)) unmapped[k] = v;
  }

  const L: string[] = [];
  L.push(`// Adopted from Terraform state: ${resource.type}.${resource.name} -> ${entry.nativeType}`);
  L.push(`// Properties mapped from Terraform attributes (CloudFormation PascalCase).`);
  L.push(`import { ${entry.ctor} } from "${AWS_LEXICON_IMPORT}";`);
  if (parameterized.length) {
    L.push(`// Deferred deploy-time input(s) — declared in chant.config.ts's buildParams.`);
    L.push(`import { params } from "${PARAMS_IMPORT}";`);
  }
  L.push("");
  L.push(`export const ${resource.name} = new ${entry.ctor}(${renderObject(props, 2)});`);
  if (Object.keys(unmapped).length) {
    L.push("");
    L.push("/* Unmapped Terraform attributes (reconcile to native props before building):");
    L.push(JSON.stringify(unmapped, null, 2));
    L.push("*/");
  }

  return {
    fileName: `${resource.name}.ts`,
    content: L.join("\n") + "\n",
    mapped: Object.keys(props).length > 0,
    nativeType: entry.nativeType,
    parameterized,
  };
}

/** Render a JS object literal with stable key order and given indent. */
function renderObject(obj: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  const pad = " ".repeat(indent);
  const body = keys
    .map((k) => `${pad}${k}: ${renderValue(obj[k])},`)
    .join("\n");
  return `{\n${body}\n}`;
}

/** A prop value: a `params.<name>` reference (cast keeps the project tsc-clean) or a literal. */
function renderValue(value: unknown): string {
  return value instanceof ParamRef ? `params.${value.name} as ${value.type}` : JSON.stringify(value);
}
