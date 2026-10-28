/**
 * A cloud's audit log, as CI core reads it (#4632, moved from terragucci's
 * respond/attribute.ts and state-writers.ts): who last wrote an object, and
 * every write in a window. CloudTrail is the first reader; the cloud is
 * named per workspace member ({@link AuditLogSettings}), so a member on
 * another cloud reads as `unavailable` with the reason, never as silence.
 *
 * The reader runs the `aws` CLI with the credentials the job already holds
 * (a drift job's preview identity, #4631). Tests pass `run` and read
 * recorded CloudTrail output; nothing here reaches a cloud by itself.
 */

import { spawnSync } from "node:child_process";

/** The clouds an audit log is read for. */
export type AuditCloud = "aws";

/** The audit log a member's writes are read from: `{ cloud: "aws", region? }`. */
export interface AuditLogSetting {
  cloud: AuditCloud;
  /** The region the log is read in. Default: the CLI's. */
  region?: string;
  /** How far back a lookup reads. Default 14 days. */
  days?: number;
}

/** Each member's audit log, by member name; `*` for every member not named. */
export type AuditLogSettings = Record<string, AuditLogSetting>;

/** `aws`, `aws:us-east-1`, as `--audit-log` takes it. */
export function parseAuditLogSetting(text: string): AuditLogSetting | { error: string } {
  const [cloud, region, ...rest] = text.split(":");
  if (cloud !== "aws") return { error: `--audit-log reads aws's CloudTrail, not ${JSON.stringify(cloud)}: --audit-log aws[:<region>]` };
  if (rest.length > 0) return { error: `--audit-log takes aws[:<region>], not ${JSON.stringify(text)}` };
  return { cloud, ...(region ? { region } : {}) };
}

/** The setting for `member`: its own, else `*`'s. */
export function auditLogFor(settings: AuditLogSettings | undefined, member: string): AuditLogSetting | undefined {
  return settings?.[member] ?? settings?.["*"];
}

/** What a lookup asks: the object by its type and its real name or id. */
export interface AuditQuery {
  type: string;
  address: string;
  ref: string;
}

/** Who last wrote an object outside the engine. */
export type AuditAnswer =
  | { status: "found"; actor: "controller" | "human"; who: string; event: string; at: string }
  /** The log was read and holds no write outside the engine that tells a person from a controller. */
  | { status: "silent" }
  | { status: "unavailable"; reason: string };

/** One write the log holds. */
export interface AuditWrite {
  at: string;
  event: string;
  /** The principal, as the log names it. */
  who: string;
  /** A person or a controller, when the record says. */
  actor?: "controller" | "human";
  /** The objects it wrote, by name or ARN. */
  resources: string[];
  /** The engine wrote it (its user agent says Terraform, OpenTofu or Pulumi). */
  engine?: boolean;
  id?: string;
}

/** Every write in a window. */
export type AuditWrites = { status: "read"; writes: AuditWrite[] } | { status: "unavailable"; reason: string };

/** What attribution and the unrecorded writer audit need from a log. */
export interface AuditLog {
  lookup(q: AuditQuery): Promise<AuditAnswer>;
  writes(q: { since: string; until: string }): Promise<AuditWrites>;
}

/** A CloudTrail record, cut to what is read. */
export interface TrailEvent {
  eventID?: string;
  eventName?: string;
  eventTime?: string;
  readOnly?: boolean | string;
  userAgent?: string;
  invokedBy?: string;
  userIdentity?: { type?: string; userName?: string; arn?: string; invokedBy?: string; sessionContext?: { sessionIssuer?: { userName?: string } } };
  resources?: Array<{ ARN?: string; resourceName?: string; ResourceName?: string }>;
}

const ENGINE_AGENT = /terraform|opentofu|tofu|pulumi/i;

/**
 * A CloudTrail record read as a person or a controller, or neither. A write
 * by an AWS service principal is a controller; an IAM user, the root user,
 * an Identity Center session and a role session named for an email address
 * are people. A role session with a machine name could be a pipeline or a
 * controller, so it answers nothing.
 */
export function classifyEvent(e: TrailEvent): { actor: "controller" | "human"; who: string } | undefined {
  const id = e.userIdentity ?? {};
  const by = id.invokedBy ?? e.invokedBy;
  if (id.type === "AWSService" || (by && /\.amazonaws\.com$/.test(by))) return { actor: "controller", who: by ?? "an AWS service" };
  const arn = id.arn ?? "";
  const session = arn.split("/").at(-1) ?? "";
  if (id.type === "IAMUser") return { actor: "human", who: id.userName ?? session };
  if (id.type === "Root") return { actor: "human", who: "the root user" };
  if (id.type === "IdentityCenterUser" || id.type === "FederatedUser") return { actor: "human", who: id.userName ?? session };
  if (id.type === "AssumedRole") {
    const issuer = id.sessionContext?.sessionIssuer?.userName ?? "";
    if (/^AWSReservedSSO_/.test(issuer) || session.includes("@")) return { actor: "human", who: session || issuer };
  }
  return undefined;
}

const isWrite = (e: TrailEvent): boolean => e.readOnly !== true && e.readOnly !== "true";

/** The newest write outside the engine that classifies. An older write by someone else is not who last changed it. */
export function newestActor(events: readonly TrailEvent[]): AuditAnswer {
  const writes = events.filter((e) => isWrite(e) && !ENGINE_AGENT.test(e.userAgent ?? "")).sort((a, b) => String(b.eventTime ?? "").localeCompare(String(a.eventTime ?? "")));
  const e = writes[0];
  const c = e && classifyEvent(e);
  return e && c ? { status: "found", ...c, event: e.eventName ?? "an event", at: e.eventTime ?? "" } : { status: "silent" };
}

/** A CloudTrail record as a write, or undefined for a read. */
export function trailWrite(e: TrailEvent): AuditWrite | undefined {
  if (!isWrite(e)) return undefined;
  const c = classifyEvent(e);
  const who = c?.who ?? e.userIdentity?.arn ?? e.userIdentity?.userName ?? "an unnamed principal";
  const resources = (e.resources ?? []).map((r) => r.ARN ?? r.resourceName ?? r.ResourceName).filter((r): r is string => typeof r === "string" && r !== "");
  return {
    at: e.eventTime ?? "",
    event: e.eventName ?? "an event",
    who,
    ...(c ? { actor: c.actor } : {}),
    resources,
    ...(ENGINE_AGENT.test(e.userAgent ?? "") ? { engine: true } : {}),
    ...(e.eventID ? { id: e.eventID } : {}),
  };
}

/** Runs the `aws` CLI with its arguments. */
export type AwsRun = (args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };

/** The `aws` CLI on the job's PATH, with the credentials it already has. */
export const spawnAws: AwsRun = (args) => {
  const p = spawnSync("aws", args, { encoding: "utf-8", maxBuffer: 1 << 26 });
  return { status: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? "", ...(p.error ? { error: p.error } : {}) };
};

/** CloudTrail's `lookup-events` output: each record's own JSON in `CloudTrailEvent`. */
export function parseLookupEvents(stdout: string): TrailEvent[] | undefined {
  let doc: { Events?: Array<{ CloudTrailEvent?: string; EventName?: string; EventTime?: string; EventId?: string; Resources?: Array<{ ResourceName?: string }> }> };
  try {
    doc = JSON.parse(stdout) as typeof doc;
  } catch {
    return undefined;
  }
  const events: TrailEvent[] = [];
  for (const e of doc.Events ?? []) {
    try {
      const inner = JSON.parse(e.CloudTrailEvent ?? "{}") as TrailEvent;
      events.push({
        ...(e.EventName ? { eventName: e.EventName } : {}),
        ...(e.EventTime ? { eventTime: String(e.EventTime) } : {}),
        ...(e.EventId ? { eventID: e.EventId } : {}),
        ...(e.Resources ? { resources: e.Resources.map((r) => ({ ...(r.ResourceName ? { ResourceName: r.ResourceName } : {}) })) } : {}),
        ...inner,
      });
    } catch {
      // A record that does not parse says nothing.
    }
  }
  return events;
}

const why = (p: ReturnType<AwsRun>): string => {
  if ((p.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "the aws CLI is not installed";
  return (p.error?.message ?? (p.stderr.trim() || `aws exited ${p.status}`)).split("\n")[0]!;
};

export interface AwsAuditOptions extends Omit<AuditLogSetting, "cloud"> {
  run?: AwsRun;
  now?: () => Date;
}

/**
 * CloudTrail through the `aws` CLI: `lookup-events` by resource name for a
 * lookup, by `ReadOnly=false` over the window for the writes. Only an
 * `aws_` (Terraform) or `aws:` (Pulumi) resource is looked up.
 */
export function awsAuditLog(o: AwsAuditOptions = {}): AuditLog {
  const run = o.run ?? spawnAws;
  const region = o.region ? ["--region", o.region] : [];
  return {
    async lookup(q) {
      if (!q.type.startsWith("aws_") && !q.type.startsWith("aws:")) return { status: "unavailable", reason: `CloudTrail holds no writes of ${q.type}` };
      const start = new Date((o.now?.() ?? new Date()).getTime() - (o.days ?? 14) * 86_400_000).toISOString();
      const p = run(["cloudtrail", "lookup-events", "--output", "json", "--max-results", "50", "--start-time", start, "--lookup-attributes", `AttributeKey=ResourceName,AttributeValue=${q.ref}`, ...region]);
      if (p.error || p.status !== 0) return { status: "unavailable", reason: why(p) };
      const events = parseLookupEvents(p.stdout);
      return events ? newestActor(events) : { status: "unavailable", reason: "aws printed no JSON" };
    },
    async writes(q) {
      const p = run(["cloudtrail", "lookup-events", "--output", "json", "--start-time", q.since, "--end-time", q.until, "--lookup-attributes", "AttributeKey=ReadOnly,AttributeValue=false", ...region]);
      if (p.error || p.status !== 0) return { status: "unavailable", reason: why(p) };
      const events = parseLookupEvents(p.stdout);
      if (!events) return { status: "unavailable", reason: "aws printed no JSON" };
      return { status: "read", writes: events.map(trailWrite).filter((w): w is AuditWrite => w !== undefined) };
    },
  };
}

/** The reader for a setting. */
export function auditLogOf(setting: AuditLogSetting, o: Omit<AwsAuditOptions, keyof Omit<AuditLogSetting, "cloud">> = {}): AuditLog {
  return awsAuditLog({ ...o, ...(setting.region ? { region: setting.region } : {}), ...(setting.days !== undefined ? { days: setting.days } : {}) });
}
