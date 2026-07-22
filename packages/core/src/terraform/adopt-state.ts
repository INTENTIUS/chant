/**
 * Adopt a Terraform-managed resource into chant source from its `.tfstate`
 * (#1009). This is the correct adoption source for carving OUT of Terraform:
 * a TF resource is created through the provider API, not CloudFormation, so it
 * is not in any CFN stack — but its resolved attributes ARE in the state file.
 *
 * chant AWS constructors take CloudFormation PascalCase properties (e.g.
 * `new Bucket({ BucketName })`), while Terraform state uses the provider's
 * snake_case attributes (`bucket`, `tags`). The per-type mappers below translate
 * the common fields; everything unmapped is preserved in a reference comment so
 * nothing is lost and the user can reconcile it. Mappers are a curated seed,
 * like the tier map — honest coverage of the leaves people carve first.
 */

import type { StateResource } from "./state";

interface NativeCtor {
  /** chant lexicon constructor, e.g. `Bucket`. */
  ctor: string;
  /** Import specifier for the constructor. */
  importPath: string;
  /** Native spec type, for the header. */
  nativeType: string;
}

const NATIVE_CTOR: Record<string, NativeCtor> = {
  aws_s3_bucket: { ctor: "Bucket", importPath: "@intentius/chant-lexicon-aws", nativeType: "AWS::S3::Bucket" },
  aws_cloudwatch_log_group: { ctor: "LogsLogGroup", importPath: "@intentius/chant-lexicon-aws", nativeType: "AWS::Logs::LogGroup" },
  aws_sns_topic: { ctor: "Topic", importPath: "@intentius/chant-lexicon-aws", nativeType: "AWS::SNS::Topic" },
  aws_sqs_queue: { ctor: "Queue", importPath: "@intentius/chant-lexicon-aws", nativeType: "AWS::SQS::Queue" },
};

/** TF `tags` (a map) → CloudFormation `Tags` (a list of {Key, Value}). */
function tagsToCfn(tags: unknown): Array<{ Key: string; Value: unknown }> | undefined {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return undefined;
  const entries = Object.entries(tags as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  return entries.map(([Key, Value]) => ({ Key, Value }));
}

type AttrMapper = (attrs: Record<string, unknown>) => { props: Record<string, unknown>; mappedKeys: string[] };

const ATTR_MAP: Record<string, AttrMapper> = {
  aws_s3_bucket: (a) => {
    const props: Record<string, unknown> = {};
    if (typeof a.bucket === "string") props.BucketName = a.bucket;
    const tags = tagsToCfn(a.tags);
    if (tags) props.Tags = tags;
    return { props, mappedKeys: ["bucket", "tags", "id", "arn"] };
  },
  aws_cloudwatch_log_group: (a) => {
    const props: Record<string, unknown> = {};
    if (typeof a.name === "string") props.LogGroupName = a.name;
    if (typeof a.retention_in_days === "number") props.RetentionInDays = a.retention_in_days;
    const tags = tagsToCfn(a.tags);
    if (tags) props.Tags = tags;
    return { props, mappedKeys: ["name", "retention_in_days", "tags", "id", "arn"] };
  },
  aws_sns_topic: (a) => {
    const props: Record<string, unknown> = {};
    if (typeof a.name === "string") props.TopicName = a.name;
    return { props, mappedKeys: ["name", "id", "arn"] };
  },
  aws_sqs_queue: (a) => {
    const props: Record<string, unknown> = {};
    if (typeof a.name === "string") props.QueueName = a.name;
    return { props, mappedKeys: ["name", "id", "arn", "url"] };
  },
};

export interface AdoptedSource {
  fileName: string;
  content: string;
  /** True when a real per-type attribute mapping was applied (vs raw passthrough). */
  mapped: boolean;
  nativeType: string;
}

/** Is this Terraform type adoptable from state (has a native constructor)? */
export function canAdoptFromState(tfType: string): boolean {
  return tfType in NATIVE_CTOR;
}

/**
 * Render chant source for a state-adopted resource. Emits the native
 * constructor with mapped properties, plus a reference comment listing the
 * Terraform attributes that were not mapped so nothing is silently dropped.
 */
export function adoptFromState(resource: StateResource): AdoptedSource | null {
  const native = NATIVE_CTOR[resource.type];
  if (!native) return null;

  const mapper = ATTR_MAP[resource.type];
  const { props, mappedKeys } = mapper ? mapper(resource.attributes) : { props: {}, mappedKeys: [] };

  const unmapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(resource.attributes)) {
    if (!mappedKeys.includes(k)) unmapped[k] = v;
  }

  const propsLiteral = renderObject(props, 2);
  const L: string[] = [];
  L.push(`// Adopted from Terraform state: ${resource.type}.${resource.name} -> ${native.nativeType}`);
  L.push(`// Properties mapped from Terraform attributes (CloudFormation PascalCase).`);
  if (!mapper) L.push(`// NOTE: no attribute mapper for ${resource.type} yet — see the reference block below.`);
  L.push(`import { ${native.ctor} } from "${native.importPath}";`);
  L.push("");
  L.push(`export const ${resource.name} = new ${native.ctor}(${propsLiteral});`);
  if (Object.keys(unmapped).length) {
    L.push("");
    L.push("/* Unmapped Terraform attributes (reconcile to native props before building):");
    L.push(JSON.stringify(unmapped, null, 2));
    L.push("*/");
  }

  return {
    fileName: `${resource.name}.ts`,
    content: L.join("\n") + "\n",
    mapped: !!mapper,
    nativeType: native.nativeType,
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
