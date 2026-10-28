/**
 * Drift attribution (#4632, moved from terragucci's respond/attribute.ts):
 * who changed each drifted attribute, read off the drift document chant
 * already writes for terraform and pulumi members (`../drift-record.ts`).
 * The evidence is asked for in a fixed order, and the first step that
 * answers ends the question for that attribute:
 *
 *   1. {@link KNOWN_WRITES}: attributes a controller or the cloud service
 *      writes by design, for Terraform's and Pulumi's AWS types.
 *   2. The member's audit log (`./audit-log.ts`), which names the principal
 *      that last wrote the object outside the engine. An unreadable log is
 *      noted once and skipped.
 *   3. A model, when the caller passes one, for an attribute neither step
 *      answered, used only at or above its threshold.
 *
 * The answer routes a response and nothing more ({@link routeAttributions}):
 * a controller write suggests ignoring the attribute in code, a human edit
 * keeps the default response with the actor named, a provider default
 * suggests pinning or setting the value. No route applies, merges or edits
 * state.
 */

import type { DriftDocument, DriftEngine, DriftRecord } from "../drift-record";
import { auditLogFor, auditLogOf, type AuditAnswer, type AuditLog, type AuditLogSettings } from "./audit-log";

export type DriftActor = "controller" | "human" | "provider-default";
export type AttributionSource = "table" | "audit" | "model" | "unattributed";

export interface Attribution {
  member: string;
  engine: DriftEngine;
  address: string;
  path: string;
  /** Absent only when the source is `unattributed`. */
  actor?: DriftActor;
  source: AttributionSource;
  /** What the evidence says, in a sentence. */
  detail: string;
  /** The model's probability, when the model answered. */
  probability?: number;
}

type Value = { before: unknown; live: unknown };

export interface KnownWrite {
  /** The resource type, as the engine names it: `aws_ecs_service`, `aws:ecs/service:Service`, or `*`. */
  type: string;
  /** The top-level attribute. */
  path: string;
  actor: DriftActor;
  why: string;
  /** Narrows the entry to drift of the kind the writer produces. Default: any change. */
  when?: (v: Value) => boolean;
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number";

const SERVICE_TAG = /^(aws:|eks:|elasticbeanstalk:|kubernetes\.io\/|k8s\.io\/|karpenter\.sh\/)/;

/** True when the two tag maps differ only in keys a service adds, changes or removes. */
export function onlyServiceTags(v: Value): boolean {
  const before = isMap(v.before) ? v.before : {};
  const live = isMap(v.live) ? v.live : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(live)])].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(live[k] ?? null));
  return keys.length > 0 && keys.every((k) => SERVICE_TAG.test(k));
}

const onlyInner =
  (inner: string) =>
  (v: Value): boolean => {
    const b = Array.isArray(v.before) ? v.before[0] : v.before;
    const l = Array.isArray(v.live) ? v.live[0] : v.live;
    if (!isMap(b) || !isMap(l)) return false;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(l)])].filter((k) => JSON.stringify(b[k] ?? null) !== JSON.stringify(l[k] ?? null));
    return keys.length > 0 && keys.every((k) => k === inner);
  };

/** One write by design, under its Terraform type and its Pulumi type. */
function both(tf: string, pulumi: string, tfPath: string, pulumiPath: string, rest: Omit<KnownWrite, "type" | "path">): KnownWrite[] {
  return [{ type: tf, path: tfPath, ...rest }, { type: pulumi, path: pulumiPath, ...rest }];
}

export const KNOWN_WRITES: KnownWrite[] = [
  ...both("aws_ecs_service", "aws:ecs/service:Service", "desired_count", "desiredCount", { actor: "controller", why: "Application Auto Scaling sets an ECS service's task count", when: (v) => num(v.live) }),
  ...both("aws_autoscaling_group", "aws:autoscaling/group:Group", "desired_capacity", "desiredCapacity", { actor: "controller", why: "the group's scaling policies and scheduled actions set its desired capacity", when: (v) => num(v.live) }),
  { type: "aws_eks_node_group", path: "scaling_config", actor: "controller", why: "Cluster Autoscaler or Karpenter sets a node group's desired size", when: onlyInner("desired_size") },
  { type: "aws:eks/nodeGroup:NodeGroup", path: "scalingConfig", actor: "controller", why: "Cluster Autoscaler or Karpenter sets a node group's desired size", when: onlyInner("desiredSize") },
  ...both("aws_dynamodb_table", "aws:dynamodb/table:Table", "read_capacity", "readCapacity", { actor: "controller", why: "Application Auto Scaling adjusts a provisioned table's read capacity", when: (v) => num(v.live) }),
  ...both("aws_dynamodb_table", "aws:dynamodb/table:Table", "write_capacity", "writeCapacity", { actor: "controller", why: "Application Auto Scaling adjusts a provisioned table's write capacity", when: (v) => num(v.live) }),
  ...both("aws_appautoscaling_target", "aws:appautoscaling/target:Target", "min_capacity", "minCapacity", { actor: "controller", why: "a scheduled action on the scalable target moves its minimum", when: (v) => num(v.live) }),
  ...both("aws_appautoscaling_target", "aws:appautoscaling/target:Target", "max_capacity", "maxCapacity", { actor: "controller", why: "a scheduled action on the scalable target moves its maximum", when: (v) => num(v.live) }),
  ...both("aws_db_instance", "aws:rds/instance:Instance", "engine_version", "engineVersion", { actor: "controller", why: "RDS applies minor engine upgrades itself when auto minor version upgrade is on", when: (v) => typeof v.live === "string" && typeof v.before === "string" }),
  ...both("aws_launch_template", "aws:ec2/launchTemplate:LaunchTemplate", "latest_version", "latestVersion", { actor: "controller", why: "a service that publishes a launch template version (EC2 Image Builder, Karpenter) moves its latest version", when: (v) => num(v.live) }),
  ...both("aws_elasticache_replication_group", "aws:elasticache/replicationGroup:ReplicationGroup", "engine_version_actual", "engineVersionActual", { actor: "controller", why: "ElastiCache applies minor engine upgrades itself" }),
  ...["tags", "tags_all", "tagsAll"].map((path): KnownWrite => ({ type: "*", path, actor: "controller", why: "a service adds tags in its own namespace (aws:, eks:, karpenter.sh/ and the like)", when: onlyServiceTags })),
];

/** The table's entry for a drifted attribute, if it has one. */
export function knownWrite(type: string, path: string, v: Value): KnownWrite | undefined {
  const top = path.split(/[.[]/)[0]!;
  return KNOWN_WRITES.find((k) => (k.type === type || k.type === "*") && k.path === top && (k.when?.(v) ?? true));
}

/** A value as a model may read it: its shape, never a raw string. */
export function shownValue(value: unknown, sensitive?: boolean): unknown {
  if (sensitive) return "(sensitive)";
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return `(a string of ${value.length} characters)`;
  if (Array.isArray(value)) return `(a list of ${value.length})`;
  if (isMap(value)) return `(a map with keys ${Object.keys(value).slice(0, 12).join(", ")})`;
  return "(a value)";
}

/** The model step: the actor for one attribute, with its probability. */
export type ActorAsk = (state: { resource_type: string; attribute: string; value_in_code: unknown; live_value: unknown }) => Promise<{ actor: DriftActor; probability: number; model: string }>;

export interface AttributeOptions {
  /** Each member's audit log setting; a member with none reads no log. */
  auditLogs?: AuditLogSettings;
  /** The log for a setting. Default {@link auditLogOf}; a test passes a fake. */
  logFor?: (member: string) => AuditLog | undefined;
  /**
   * The object's real name or id, which the log is searched by. Default:
   * the `arn`, `id` or `name` attribute the record carries, else the last
   * segment of a Pulumi URN.
   */
  refOf?: (record: DriftRecord) => string | undefined;
  ask?: ActorAsk;
  /** The probability a model's answer needs. Default 0.8. */
  threshold?: number;
}

export interface Attributed {
  attributions: Attribution[];
  /** Notes for the report: an unreadable log, an answer below the threshold. */
  notes: string[];
}

function defaultRef(r: DriftRecord): string | undefined {
  for (const key of ["arn", "id", "name"]) {
    const a = r.attributes?.find((x) => x.path === key);
    const v = a?.after ?? a?.before;
    if (typeof v === "string" && v !== "") return v;
  }
  if (r.address.startsWith("urn:pulumi:")) return r.address.split("::").at(-1);
  return undefined;
}

/**
 * Attribute every drifted attribute of the document, in the order above.
 * The model is asked only for what neither the table nor the log answered,
 * and never without `ask`.
 */
export async function attributeDrift(doc: Pick<DriftDocument, "records">, o: AttributeOptions = {}): Promise<Attributed> {
  const attributions: Attribution[] = [];
  const notes: string[] = [];
  const cache = new Map<string, AuditAnswer>();
  const unavailable = new Map<string, string>();
  const logs = new Map<string, AuditLog | undefined>();
  const logFor = (member: string): AuditLog | undefined => {
    if (!logs.has(member)) {
      const setting = auditLogFor(o.auditLogs, member);
      logs.set(member, o.logFor ? o.logFor(member) : setting ? auditLogOf(setting) : undefined);
    }
    return logs.get(member);
  };
  for (const r of doc.records) {
    if (r.status !== "drifted") continue;
    const type = r.resourceType ?? "";
    for (const a of r.attributes ?? []) {
      const at = { member: r.member, engine: r.engine, address: r.address, path: a.path };
      const hit = a.sensitive ? undefined : knownWrite(type, a.path, { before: a.before, live: a.after });
      if (hit) {
        attributions.push({ ...at, actor: hit.actor, source: "table", detail: hit.why });
        continue;
      }
      const log = logFor(r.member);
      const ref = (o.refOf ?? defaultRef)(r);
      if (log && ref && !unavailable.has(r.member)) {
        const key = `${r.member}\0${type}\0${ref}`;
        let ans = cache.get(key);
        if (!ans) {
          ans = await log.lookup({ type, address: r.address, ref });
          cache.set(key, ans);
        }
        if (ans.status === "found") {
          attributions.push({ ...at, actor: ans.actor, source: "audit", detail: `${ans.event} by ${ans.who}${ans.at ? ` at ${ans.at}` : ""}` });
          continue;
        }
        if (ans.status === "unavailable") {
          unavailable.set(r.member, ans.reason);
          notes.push(`${r.member}: the audit log is unavailable: ${ans.reason}`);
        }
      }
      if (o.ask) {
        try {
          const answer = await o.ask({ resource_type: type, attribute: a.path, value_in_code: shownValue(a.before, a.sensitive), live_value: shownValue(a.after, a.sensitive) });
          if (answer.probability >= (o.threshold ?? 0.8)) {
            attributions.push({ ...at, actor: answer.actor, source: "model", detail: `${answer.model} answered ${answer.actor} with probability ${answer.probability.toFixed(2)}`, probability: answer.probability });
            continue;
          }
          notes.push(`${r.address} ${a.path}: ${answer.model} answered ${answer.actor} with probability ${answer.probability.toFixed(2)}, below the threshold`);
        } catch (err) {
          notes.push(`${r.address} ${a.path}: the model did not answer: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      attributions.push({ ...at, source: "unattributed", detail: `neither the known-writes table nor the audit log answered${o.ask ? ", and no model answer was used" : ""}` });
    }
  }
  return { attributions, notes };
}

const SOURCE = { table: "known write", audit: "audit log", model: "model", unattributed: "unattributed" } as const;

export interface Routed {
  /** Address to the attributes a codify response leaves alone. */
  leave: Map<string, Set<string>>;
  /** One line per attribute, for the report or the issue. */
  lines: string[];
}

/** How a member's code ignores an attribute, in its engine's own words. */
function ignoreLine(engine: DriftEngine, path: string): string {
  return engine === "terraform" || engine === "tofu" || engine === "choudoufu"
    ? `add \`lifecycle { ignore_changes = [${path}] }\` to the resource`
    : engine === "pulumi" || engine === "plunge"
      ? `add \`ignoreChanges: ["${path}"]\` to the resource's options`
      : `leave \`${path}\` out of the declaration`;
}

/**
 * The deterministic response each actor takes. A controller write and a
 * provider default are suggestions, so a codify response leaves those
 * attributes out; a human edit and an unattributed attribute keep the
 * default response, which the owner reviews.
 */
export function routeAttributions(attributions: readonly Attribution[]): Routed {
  const leave = new Map<string, Set<string>>();
  const lines: string[] = [];
  for (const a of attributions) {
    const where = `\`${a.address}\` \`${a.path}\``;
    if (a.source === "unattributed") {
      lines.push(`- unattributed: ${where}: ${a.detail}; the default response runs`);
      continue;
    }
    const how = `${SOURCE[a.source]}: ${a.detail}`;
    if (a.actor === "human") {
      lines.push(`- human edit: ${where} (${how}); the default response runs, for the owner to accept or revert`);
      continue;
    }
    const set = leave.get(a.address) ?? new Set<string>();
    set.add(a.path);
    leave.set(a.address, set);
    if (a.actor === "controller") lines.push(`- controller write: ${where} (${how}); ${ignoreLine(a.engine, a.path)}`);
    else lines.push(`- provider default change: ${where} (${how}); pin the provider version that kept the old value, or set \`${a.path}\` to the value you want`);
  }
  return { leave, lines };
}
