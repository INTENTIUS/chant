/**
 * WAW059: Wildcard Resource where the declared graph enumerates the touched set
 *
 * An identity policy that allows resource-scopable actions on `Resource: "*"`
 * (or a service-wide ARN pattern) when every consumer of the attached role
 * only touches resources declared in the same template. In that case the
 * declared graph already enumerates the touched set, so the statement can be
 * tightened to the `Fn::GetAtt` Arn list of those declared entities.
 *
 * Deliberately narrow (#1225). Fires only when ALL of these hold:
 * - the statement is an `Effect: Allow` identity-policy statement (role inline
 *   policy, IAM::Policy, IAM::ManagedPolicy) — trust policies carry a
 *   Principal and are skipped, resource policies live on other types;
 * - no Condition/NotAction/NotResource and no intrinsics in Action/Resource;
 * - `Resource` is `"*"` or a service-wide ARN pattern;
 * - every Action is in the curated resource-scopable table (s3, dynamodb,
 *   sqs) — actions that genuinely need `"*"` (s3:ListAllMyBuckets,
 *   dynamodb:ListTables, sqs:ListQueues) are not in the table;
 * - the attached principal resolves to declared roles only, those roles have
 *   consumers in the template, and no consumer carries a foreign edge (a
 *   literal ARN of the service) or an intrinsic edge (Fn::ImportValue) that
 *   would put resources outside the declared graph in reach.
 *
 * Anything the static graph cannot prove stays quiet.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import {
  parseCFTemplate,
  walkPolicyStatements,
  findResourceRefs,
  buildReverseRefIndex,
  isIntrinsic,
  type CFTemplate,
  type CFResource,
} from "./cf-refs";

/**
 * Curated table of actions that support resource-level permissions, per
 * service. Lower-cased (IAM action matching is case-insensitive). An action
 * outside this table gates the whole statement off — it may legitimately
 * require `Resource: "*"`.
 */
export const RESOURCE_SCOPABLE_ACTIONS: Record<string, ReadonlySet<string>> = {
  s3: new Set([
    "getobject",
    "getobjectversion",
    "getobjectacl",
    "getobjecttagging",
    "putobject",
    "putobjectacl",
    "putobjecttagging",
    "deleteobject",
    "deleteobjectversion",
    "listbucket",
    "listbucketversions",
    "listbucketmultipartuploads",
    "listmultipartuploadparts",
    "abortmultipartupload",
    "getbucketlocation",
  ]),
  dynamodb: new Set([
    "getitem",
    "batchgetitem",
    "query",
    "scan",
    "putitem",
    "updateitem",
    "deleteitem",
    "batchwriteitem",
    "conditioncheckitem",
    "describetable",
    "getrecords",
    "getsharditerator",
    "describestream",
  ]),
  sqs: new Set([
    "sendmessage",
    "sendmessagebatch",
    "receivemessage",
    "deletemessage",
    "deletemessagebatch",
    "changemessagevisibility",
    "changemessagevisibilitybatch",
    "getqueueattributes",
    "getqueueurl",
    "purgequeue",
  ]),
};

/** CloudFormation types that declare an entity of each curated service. */
const SERVICE_RESOURCE_TYPES: Record<string, ReadonlySet<string>> = {
  s3: new Set(["AWS::S3::Bucket"]),
  dynamodb: new Set(["AWS::DynamoDB::Table", "AWS::DynamoDB::GlobalTable"]),
  sqs: new Set(["AWS::SQS::Queue"]),
};

/**
 * ARN resource segments that make an ARN service-wide rather than
 * entity-scoped. `arn:aws:s3:::my-bucket/*` is bucket-scoped and NOT here.
 */
const SERVICE_WIDE_REST: Record<string, ReadonlySet<string>> = {
  s3: new Set(["*"]),
  dynamodb: new Set(["*", "table/*"]),
  sqs: new Set(["*"]),
};

const IAM_TYPES = new Set(["AWS::IAM::Policy", "AWS::IAM::Role", "AWS::IAM::ManagedPolicy"]);

const ARN_SERVICE_RE = /arn:[^:\s]*:([a-z0-9-]+):/g;

function asStringArray(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return null;
}

/** `"*"`, or an ARN whose service is in `services` and whose resource segment is service-wide. */
function isServiceWideResource(value: string, services: Set<string>): boolean {
  if (value === "*") return true;
  const m = /^arn:[^:]*:([^:]*):[^:]*:[^:]*:(.+)$/.exec(value);
  if (!m) return false;
  const [, service, rest] = m;
  if (!services.has(service)) return false;
  return SERVICE_WIDE_REST[service]?.has(rest) ?? false;
}

/**
 * The services an Allow statement touches, if every action lands in the
 * curated resource-scopable table. Null when any action is outside it
 * (or malformed / an action-name wildcard).
 */
function curatedServices(actions: string[]): Set<string> | null {
  const services = new Set<string>();
  for (const action of actions) {
    const m = /^([a-z0-9-]+):([A-Za-z0-9]+)$/.exec(action);
    if (!m) return null;
    const [, service, name] = m;
    const table = RESOURCE_SCOPABLE_ACTIONS[service];
    if (!table || !table.has(name.toLowerCase())) return null;
    services.add(service);
  }
  return services.size > 0 ? services : null;
}

/**
 * Resolve which declared roles a policy resource is attached to. Null means
 * "cannot prove" (users/groups, literal role names, no roles at all).
 */
function attachedRoles(logicalId: string, resource: CFResource, template: CFTemplate): Set<string> | null {
  const resources = template.Resources ?? {};
  if (resource.Type === "AWS::IAM::Role") return new Set([logicalId]);

  const props = resource.Properties ?? {};
  // Users/groups have no consumers in the resource graph — untraceable.
  if (Array.isArray(props.Users) && props.Users.length > 0) return null;
  if (Array.isArray(props.Groups) && props.Groups.length > 0) return null;

  const roles = new Set<string>();
  if (props.Roles !== undefined) {
    if (!Array.isArray(props.Roles)) return null;
    for (const entry of props.Roles) {
      // A literal role name points outside the declared graph.
      if (typeof entry === "string") return null;
      const refs = findResourceRefs(entry);
      if (refs.size !== 1) return null;
      const [id] = refs;
      if (resources[id]?.Type !== "AWS::IAM::Role") return null;
      roles.add(id);
    }
  }

  // A managed policy can also be attached from the role side (ManagedPolicyArns).
  if (resource.Type === "AWS::IAM::ManagedPolicy") {
    for (const [roleId, candidate] of Object.entries(resources)) {
      if (candidate.Type !== "AWS::IAM::Role") continue;
      if (findResourceRefs(candidate.Properties?.ManagedPolicyArns).has(logicalId)) {
        roles.add(roleId);
      }
    }
  }

  return roles.size > 0 ? roles : null;
}

/**
 * The non-IAM resources that reference any of the roles (the role's
 * consumers). An IAM::InstanceProfile is a pass-through hop: its own
 * consumers count instead.
 */
function consumersOf(
  roleIds: Set<string>,
  reverseIndex: Map<string, Set<string>>,
  template: CFTemplate,
): Array<[string, CFResource]> {
  const resources = template.Resources ?? {};
  const seen = new Set<string>();
  const queue = [...roleIds].flatMap((id) => [...(reverseIndex.get(id) ?? [])]);
  const consumers: Array<[string, CFResource]> = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const resource = resources[id];
    if (!resource) continue;
    if (resource.Type === "AWS::IAM::InstanceProfile") {
      queue.push(...(reverseIndex.get(id) ?? []));
      continue;
    }
    if (resource.Type.startsWith("AWS::IAM::")) continue; // attachment, not consumption
    consumers.push([id, resource]);
  }

  return consumers;
}

/**
 * A consumer edge the declared graph cannot enumerate: a literal ARN of one
 * of the statement's services (a foreign, undeclared entity) or an
 * Fn::ImportValue anywhere in the consumer (a cross-stack edge).
 */
function hasForeignOrIntrinsicEdge(value: unknown, services: Set<string>): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    for (const m of value.matchAll(ARN_SERVICE_RE)) {
      if (services.has(m[1])) return true;
    }
    return false;
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasForeignOrIntrinsicEdge(item, services));
  }
  const obj = value as Record<string, unknown>;
  if ("Fn::ImportValue" in obj) return true;
  return Object.values(obj).some((v) => hasForeignOrIntrinsicEdge(v, services));
}

const S3_OBJECT_ACTIONS = new Set([
  "getobject",
  "getobjectversion",
  "getobjectacl",
  "getobjecttagging",
  "putobject",
  "putobjectacl",
  "putobjecttagging",
  "deleteobject",
  "deleteobjectversion",
  "listmultipartuploadparts",
  "abortmultipartupload",
]);

function policyKind(type: string): string {
  if (type === "AWS::IAM::Role") return "role";
  if (type === "AWS::IAM::ManagedPolicy") return "managed policy";
  return "policy";
}

export function checkWildcardResourceEnumerable(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    const reverseIndex = buildReverseRefIndex(template);

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (!IAM_TYPES.has(resource.Type)) continue;

      // walkPolicyStatements also yields a role's AssumeRolePolicyDocument
      // statements; those always carry a Principal and are gated off below.
      for (const stmt of walkPolicyStatements(resource)) {
        if (stmt.Effect !== "Allow") continue;
        if ("Condition" in stmt || "NotAction" in stmt || "NotResource" in stmt) continue;
        if ("Principal" in stmt || "NotPrincipal" in stmt) continue;
        if (isIntrinsic(stmt.Action) || isIntrinsic(stmt.Resource)) continue;

        const actions = asStringArray(stmt.Action);
        const resources = asStringArray(stmt.Resource);
        if (!actions || !resources || actions.length === 0 || resources.length === 0) continue;

        const services = curatedServices(actions);
        if (!services) continue;
        if (!resources.every((r) => isServiceWideResource(r, services))) continue;

        const roles = attachedRoles(logicalId, resource, template);
        if (!roles) continue;

        const consumers = consumersOf(roles, reverseIndex, template);
        if (consumers.length === 0) continue;

        // Every consumer edge must stay inside the declared graph.
        if (consumers.some(([, c]) => hasForeignOrIntrinsicEdge(c.Properties, services))) continue;

        // The declared entities of each granted service the consumers touch.
        const touched = new Set<string>();
        let enumerable = true;
        for (const service of services) {
          const types = SERVICE_RESOURCE_TYPES[service];
          const serviceTouched = new Set<string>();
          for (const [, consumer] of consumers) {
            for (const ref of findResourceRefs(consumer.Properties)) {
              if (types.has(template.Resources[ref]?.Type ?? "")) serviceTouched.add(ref);
            }
          }
          if (serviceTouched.size === 0) {
            enumerable = false;
            break;
          }
          for (const id of serviceTouched) touched.add(id);
        }
        if (!enumerable) continue;

        const suggestion = JSON.stringify(
          [...touched].sort().map((id) => ({ "Fn::GetAtt": [id, "Arn"] })),
        );
        const objectHint = actions.some((a) => {
          const [service, name] = a.split(":");
          return service === "s3" && S3_OBJECT_ACTIONS.has(name.toLowerCase());
        })
          ? ' (s3 object-level actions also need the "/*" object suffix on the bucket Arn)'
          : "";

        diagnostics.push({
          checkId: "WAW059",
          severity: "warning",
          message:
            `IAM ${policyKind(resource.Type)} "${logicalId}" allows ${actions.join(", ")} on ` +
            `Resource ${JSON.stringify(stmt.Resource)}, but the declared graph enumerates the touched set — ` +
            `tighten Resource to ${suggestion}${objectHint}`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw059: PostSynthCheck = {
  id: "WAW059",
  description:
    "Wildcard Resource where the declared graph enumerates the touched set — tighten to the consumers' declared Arns",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkWildcardResourceEnumerable(ctx);
  },
};
