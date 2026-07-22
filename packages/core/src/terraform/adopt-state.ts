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
 */

import { AWS_CARVE_TYPES, AWS_LEXICON_IMPORT, awsCarveType, applyAwsMapper } from "./aws-resources";
import type { StateResource } from "./state";

export interface AdoptedSource {
  fileName: string;
  content: string;
  /** True when at least one attribute was mapped to a native prop. */
  mapped: boolean;
  nativeType: string;
}

/** Is this Terraform type adoptable from state (has a native constructor)? */
export function canAdoptFromState(tfType: string): boolean {
  return awsCarveType(tfType) !== undefined;
}

/** Terraform types that can currently be adopted from state, for user-facing hints. */
export function supportedStateAdoptionTypes(): string[] {
  return AWS_CARVE_TYPES.map((t) => t.tfType).sort();
}

/**
 * Render chant source for a state-adopted resource. Emits the native
 * constructor with mapped properties, plus a reference comment listing the
 * Terraform attributes that were not mapped so nothing is silently dropped.
 */
export function adoptFromState(resource: StateResource): AdoptedSource | null {
  const entry = awsCarveType(resource.type);
  if (!entry) return null;

  const { props, mappedKeys } = applyAwsMapper(entry, resource.attributes);
  const unmapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(resource.attributes)) {
    if (!mappedKeys.includes(k)) unmapped[k] = v;
  }

  const L: string[] = [];
  L.push(`// Adopted from Terraform state: ${resource.type}.${resource.name} -> ${entry.nativeType}`);
  L.push(`// Properties mapped from Terraform attributes (CloudFormation PascalCase).`);
  L.push(`import { ${entry.ctor} } from "${AWS_LEXICON_IMPORT}";`);
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
  };
}

/** Render a JS object literal with stable key order and given indent. */
function renderObject(obj: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  const pad = " ".repeat(indent);
  const body = keys.map((k) => `${pad}${k}: ${JSON.stringify(obj[k])},`).join("\n");
  return `{\n${body}\n}`;
}
