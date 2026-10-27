/**
 * chant#4558: the S3 bucket check. Three reads (GetBucketVersioning,
 * GetBucketLifecycleConfiguration, GetPublicAccessBlock), signed with the
 * cloud lister's SigV4 (packages/core/src/cloud-lister/sigv4.ts), then
 * {@link evaluateS3}, which is a port of choudoufu's
 * pkg/staterecord/bucketcontract.go (CheckBucketContract) so init passes
 * exactly the buckets plunge and choudoufu open.
 *
 * With an `endpoint`, the target must carry static credentials and every
 * call is pinned to that endpoint; the default provider chain is never used
 * against it (cloud-lister/credentials.ts resolveAwsCredentials).
 */

import { createHash } from "node:crypto";
import { resolveAwsCredentials, sdkCredentialChains, type AwsStaticCredentials, type CredentialChains } from "../cloud-lister/credentials";
import { signV4 } from "../cloud-lister/sigv4";
import type { TlsOptions, WireResponse } from "../cloud-lister/transport";
import { isReadError, type BucketFinding, type BucketReport, type ReadError } from "./types";
import { BucketCheckError, namespacePrefix, sendGet, type WireOptions } from "./wire";

export interface S3BucketTarget {
  store: "s3";
  bucket: string;
  region: string;
  /** An emulator's S3 base, e.g. `http://localhost:4566`. Requires `credentials`. */
  endpoint?: string;
  credentials?: AwsStaticCredentials;
  /** Twelve-digit account that must own the bucket, sent as x-amz-expected-bucket-owner. */
  expectedOwner?: string;
  tls?: TlsOptions;
}

// ---------------------------------------------------------------------------
// The fixture shape: the S3 API's own field names, as aws-sdk-go-v2's output
// types and the REST XML documents spell them.

export interface S3LifecycleRule {
  ID?: string;
  Status?: string;
  Prefix?: string;
  Filter?: {
    Prefix?: string;
    Tag?: { Key?: string; Value?: string };
    ObjectSizeGreaterThan?: number;
    ObjectSizeLessThan?: number;
    And?: { Prefix?: string; Tags?: Array<{ Key?: string; Value?: string }>; ObjectSizeGreaterThan?: number; ObjectSizeLessThan?: number };
  };
  Expiration?: { Days?: number; Date?: string; ExpiredObjectDeleteMarker?: boolean };
  NoncurrentVersionExpiration?: { NoncurrentDays?: number; NewerNoncurrentVersions?: number };
}

export interface S3PublicAccessBlockConfiguration {
  BlockPublicAcls?: boolean;
  IgnorePublicAcls?: boolean;
  BlockPublicPolicy?: boolean;
  RestrictPublicBuckets?: boolean;
}

export interface S3Input {
  versioning: { Status?: string } | ReadError;
  lifecycle: { Rules?: S3LifecycleRule[] } | ReadError;
  publicAccessBlock: { PublicAccessBlockConfiguration?: S3PublicAccessBlockConfiguration } | ReadError;
}

// ---------------------------------------------------------------------------
// Evaluation.

export interface S3EvaluateOptions {
  bucket: string;
  namespaces?: readonly string[];
  expectedOwner?: string;
  /** Days a noncurrent version is kept in the suggested lifecycle rule; the recovery window. Default 30. */
  recoveryDays?: number;
}

function denied(e: ReadError): boolean {
  return e.error.status === 403 || e.error.code === "AccessDenied" || e.error.code === "AllAccessDisabled";
}

function readFailure(setting: BucketFinding["setting"], permission: string, e: ReadError, expectedOwner: string | undefined): BucketFinding {
  if (!denied(e)) {
    throw new BucketCheckError(`s3: reading the bucket's ${setting} setting failed: ${e.error.code ?? `HTTP ${e.error.status ?? "?"}`}`);
  }
  let found = `${permission} was denied`;
  if (expectedOwner) found += `, which is also what S3 answers when the bucket is owned by an account other than ${expectedOwner}`;
  return { setting, verdict: "unreadable", found, unwaivable: false, fix: `Grant the identity ${permission} on the bucket, or have someone who holds it confirm the setting.` };
}

const ruleId = (r: S3LifecycleRule): string => (r.ID ? r.ID : "(unnamed rule)");

function rulePrefix(r: S3LifecycleRule): string {
  let prefix = r.Prefix ?? "";
  if (r.Filter) {
    if (r.Filter.And?.Prefix) prefix = r.Filter.And.Prefix;
    if (r.Filter.Prefix) prefix = r.Filter.Prefix;
  }
  return prefix;
}

function filteredBeyondPrefix(r: S3LifecycleRule): string {
  const why = "is filtered by tag or object size, which this check does not rely on";
  const f = r.Filter;
  if (!f) return "";
  if (f.Tag !== undefined || f.ObjectSizeGreaterThan !== undefined || f.ObjectSizeLessThan !== undefined) return why;
  if (f.And && ((f.And.Tags?.length ?? 0) > 0 || f.And.ObjectSizeGreaterThan !== undefined || f.And.ObjectSizeLessThan !== undefined)) return why;
  return "";
}

function expiresCurrent(r: S3LifecycleRule): string {
  const e = r.Expiration;
  if (!e) return "";
  if ((e.Days ?? 0) > 0) return `after ${e.Days} day(s)`;
  if (e.Date) {
    const d = new Date(e.Date);
    if (!Number.isNaN(d.getTime()) && d.getTime() > 0) return `on ${d.toISOString().slice(0, 10)}`;
  }
  return "";
}

function mayReach(r: S3LifecycleRule, namespaces: readonly string[]): boolean {
  const prefix = rulePrefix(r);
  if (prefix === "" || namespaces.length === 0) return true;
  return namespaces.some((ns) => {
    const n = namespacePrefix(ns);
    return n.startsWith(prefix) || prefix.startsWith(n);
  });
}

function describeNoncurrent(r: S3LifecycleRule): string {
  const nve = r.NoncurrentVersionExpiration ?? {};
  let d = `rule "${ruleId(r)}" expires noncurrent versions after ${nve.NoncurrentDays ?? 0} day(s)`;
  if ((nve.NewerNoncurrentVersions ?? 0) > 0) d += `, keeping the newest ${nve.NewerNoncurrentVersions} whatever their age`;
  return d;
}

/** The lifecycle configuration the fix suggests: one noncurrent-expiry rule per namespace, or one with no filter. */
export function s3LifecycleFix(bucket: string, namespaces: readonly string[], recoveryDays: number): string {
  const rules = (namespaces.length === 0 ? [""] : namespaces).map((ns, i) => ({
    ID: namespaces.length <= 1 ? "expire-noncurrent" : `expire-noncurrent-${i + 1}`,
    Status: "Enabled",
    Filter: ns === "" ? {} : { Prefix: namespacePrefix(ns) },
    NoncurrentVersionExpiration: { NoncurrentDays: recoveryDays },
  }));
  return (
    `aws s3api put-bucket-lifecycle-configuration --bucket ${bucket} --lifecycle-configuration '${JSON.stringify({ Rules: rules })}' ` +
    `(this replaces the bucket's lifecycle configuration, so add these rules to any it already has; ${recoveryDays} days is how long a deleted or overwritten record stays recoverable)`
  );
}

export function evaluateS3(input: S3Input, options: S3EvaluateOptions): BucketFinding[] {
  const { bucket, expectedOwner } = options;
  const namespaces = options.namespaces ?? [];
  const recoveryDays = options.recoveryDays ?? 30;
  return [versioning(input, bucket, expectedOwner), lifecycle(input, bucket, namespaces, expectedOwner, recoveryDays), publicAccessBlock(input, bucket, expectedOwner)];
}

function versioning(input: S3Input, bucket: string, expectedOwner: string | undefined): BucketFinding {
  const v = input.versioning;
  if (isReadError(v)) return readFailure("versioning", "s3:GetBucketVersioning", v, expectedOwner);
  if (v.Status === "Enabled") return { setting: "versioning", verdict: "ok", found: "versioning is Enabled", unwaivable: false };
  return {
    setting: "versioning",
    verdict: "fail",
    found: v.Status === "Suspended" ? "versioning is Suspended" : "versioning has never been enabled",
    unwaivable: false,
    fix: `aws s3api put-bucket-versioning --bucket ${bucket} --versioning-configuration Status=Enabled`,
  };
}

function lifecycle(input: S3Input, bucket: string, namespaces: readonly string[], expectedOwner: string | undefined, recoveryDays: number): BucketFinding {
  const fail = (found: string): BucketFinding => ({ setting: "lifecycle", verdict: "fail", found, unwaivable: false, fix: s3LifecycleFix(bucket, namespaces, recoveryDays) });
  const l = input.lifecycle;
  if (isReadError(l)) {
    if (l.error.code === "NoSuchLifecycleConfiguration") return fail("the bucket has no lifecycle configuration");
    return readFailure("lifecycle", "s3:GetLifecycleConfiguration", l, expectedOwner);
  }
  const rules = l.Rules ?? [];

  const deleting: string[] = [];
  for (const r of rules) {
    if (r.Status !== "Enabled") continue;
    const when = expiresCurrent(r);
    if (when === "" || !mayReach(r, namespaces)) continue;
    deleting.push(`rule "${ruleId(r)}" expires current objects ${when}, and a record is a current object`);
  }
  if (deleting.length > 0) {
    return {
      setting: "lifecycle",
      verdict: "fail",
      found: deleting.join("; "),
      unwaivable: true,
      fix: "Remove the Expiration action from that rule, or limit the rule to a prefix outside these keys. Only NoncurrentVersionExpiration belongs on a rule that reaches them.",
    };
  }

  const near: string[] = [];
  const covering: S3LifecycleRule[] = [];
  for (const r of rules) {
    if (!r.NoncurrentVersionExpiration || (r.NoncurrentVersionExpiration.NoncurrentDays ?? 0) <= 0) continue;
    if (r.Status !== "Enabled") {
      near.push(`rule "${ruleId(r)}" expires noncurrent versions but is ${r.Status ?? ""}`);
      continue;
    }
    const why = filteredBeyondPrefix(r);
    if (why !== "") {
      near.push(`rule "${ruleId(r)}" expires noncurrent versions but ${why}`);
      continue;
    }
    covering.push(r);
  }
  const used: string[] = [];
  const uncovered: string[] = [];
  const targets = namespaces.length === 0 ? [""] : namespaces;
  for (const ns of targets) {
    const hit = covering.find((r) => {
      const p = rulePrefix(r);
      return p === "" || (ns !== "" && namespacePrefix(ns).startsWith(p));
    });
    if (hit) {
      const d = describeNoncurrent(hit);
      if (!used.includes(d)) used.push(d);
    } else {
      uncovered.push(ns);
    }
  }
  if (uncovered.length === 0 && covering.length > 0) return { setting: "lifecycle", verdict: "ok", found: used.join("; "), unwaivable: false };
  for (const r of covering) {
    if (namespaces.length === 0) {
      near.push(`rule "${ruleId(r)}" expires noncurrent versions but only under the prefix "${rulePrefix(r)}", and this check was not told which keys the store writes`);
      continue;
    }
    for (const ns of uncovered) {
      near.push(`rule "${ruleId(r)}" expires noncurrent versions but only under the prefix "${rulePrefix(r)}", which does not contain "${namespacePrefix(ns)}"`);
    }
  }
  if (near.length > 0) return fail(near.join("; "));
  if (rules.length === 0) return fail("the lifecycle configuration has no rules");
  return fail(`none of the lifecycle configuration's ${rules.length} rule(s) expires noncurrent versions`);
}

function publicAccessBlock(input: S3Input, bucket: string, expectedOwner: string | undefined): BucketFinding {
  const fix = `aws s3api put-public-access-block --bucket ${bucket} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`;
  const p = input.publicAccessBlock;
  const none: BucketFinding = { setting: "public_access_block", verdict: "fail", found: "the bucket has no public-access block configuration", unwaivable: false, fix };
  if (isReadError(p)) {
    if (p.error.code === "NoSuchPublicAccessBlockConfiguration") return none;
    return readFailure("public_access_block", "s3:GetBucketPublicAccessBlock", p, expectedOwner);
  }
  const cfg = p.PublicAccessBlockConfiguration;
  if (!cfg) return none;
  const off = (["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"] as const).filter((k) => cfg[k] !== true);
  if (off.length > 0) return { setting: "public_access_block", verdict: "fail", found: `public-access block has ${off.join(", ")} off`, unwaivable: false, fix };
  return { setting: "public_access_block", verdict: "ok", found: "all four public-access block settings are on", unwaivable: false };
}

// ---------------------------------------------------------------------------
// The S3 REST XML documents, read into the fixture shape. Only what the three
// responses carry: elements and text, no attributes, no namespaces kept.

interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

/** A tolerant parser for the small documents S3 returns. Exported for tests. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", children: [], text: "" };
  const stack: XmlNode[] = [root];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1]!;
    if (m[4] !== undefined) {
      top.text += decode(m[4]);
      continue;
    }
    if (m[2] === undefined) continue;
    const name = m[2].replace(/^.*:/, "");
    if (m[1] === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node: XmlNode = { name, children: [], text: "" };
    top.children.push(node);
    if (m[3] !== "/") stack.push(node);
  }
  return root;
}

const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
const kids = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
const text = (n: XmlNode | undefined, name: string): string | undefined => {
  const c = child(n, name);
  return c === undefined ? undefined : c.text.trim();
};
const num = (n: XmlNode | undefined, name: string): number | undefined => {
  const t = text(n, name);
  return t === undefined || t === "" ? undefined : Number(t);
};
const bool = (n: XmlNode | undefined, name: string): boolean | undefined => {
  const t = text(n, name);
  return t === undefined ? undefined : t.toLowerCase() === "true";
};

function defined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

export function parseVersioning(xml: string): { Status?: string } {
  const doc = child(parseXml(xml), "VersioningConfiguration");
  return defined({ Status: text(doc, "Status") || undefined });
}

export function parsePublicAccessBlock(xml: string): { PublicAccessBlockConfiguration?: S3PublicAccessBlockConfiguration } {
  const doc = child(parseXml(xml), "PublicAccessBlockConfiguration");
  if (!doc) return {};
  return {
    PublicAccessBlockConfiguration: defined({
      BlockPublicAcls: bool(doc, "BlockPublicAcls"),
      IgnorePublicAcls: bool(doc, "IgnorePublicAcls"),
      BlockPublicPolicy: bool(doc, "BlockPublicPolicy"),
      RestrictPublicBuckets: bool(doc, "RestrictPublicBuckets"),
    }),
  };
}

export function parseLifecycle(xml: string): { Rules: S3LifecycleRule[] } {
  const doc = child(parseXml(xml), "LifecycleConfiguration");
  const rules = kids(doc, "Rule").map((r) => {
    const f = child(r, "Filter");
    const and = child(f, "And");
    const tag = (t: XmlNode) => defined({ Key: text(t, "Key"), Value: text(t, "Value") });
    const e = child(r, "Expiration");
    const nve = child(r, "NoncurrentVersionExpiration");
    return defined<S3LifecycleRule>({
      ID: text(r, "ID"),
      Status: text(r, "Status"),
      Prefix: text(r, "Prefix"),
      Filter: f
        ? defined({
            Prefix: text(f, "Prefix"),
            Tag: child(f, "Tag") ? tag(child(f, "Tag")!) : undefined,
            ObjectSizeGreaterThan: num(f, "ObjectSizeGreaterThan"),
            ObjectSizeLessThan: num(f, "ObjectSizeLessThan"),
            And: and
              ? defined({
                  Prefix: text(and, "Prefix"),
                  Tags: kids(and, "Tag").length > 0 ? kids(and, "Tag").map(tag) : undefined,
                  ObjectSizeGreaterThan: num(and, "ObjectSizeGreaterThan"),
                  ObjectSizeLessThan: num(and, "ObjectSizeLessThan"),
                })
              : undefined,
          })
        : undefined,
      Expiration: e ? defined({ Days: num(e, "Days"), Date: text(e, "Date"), ExpiredObjectDeleteMarker: bool(e, "ExpiredObjectDeleteMarker") }) : undefined,
      NoncurrentVersionExpiration: nve ? defined({ NoncurrentDays: num(nve, "NoncurrentDays"), NewerNoncurrentVersions: num(nve, "NewerNoncurrentVersions") }) : undefined,
    });
  });
  return { Rules: rules };
}

/** A non-2xx S3 answer as a {@link ReadError}. */
export function parseS3Error(res: WireResponse): ReadError {
  const code = text(child(parseXml(res.body), "Error"), "Code");
  return { error: defined({ code, status: res.status }) };
}

// ---------------------------------------------------------------------------
// Reading a live bucket.

export interface S3ReadOptions extends WireOptions {
  chains?: CredentialChains;
  now?: () => Date;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

export function s3Url(target: S3BucketTarget, subresource: string): string {
  if (target.endpoint !== undefined) {
    return `${target.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(target.bucket)}?${subresource}`;
  }
  // Virtual-hosted unless the name has a dot, which breaks the wildcard certificate.
  if (target.bucket.includes(".")) return `https://s3.${target.region}.amazonaws.com/${encodeURIComponent(target.bucket)}?${subresource}`;
  return `https://${target.bucket}.s3.${target.region}.amazonaws.com/?${subresource}`;
}

export async function readS3(target: S3BucketTarget, options: S3ReadOptions = {}): Promise<S3Input> {
  const credentials = await resolveAwsCredentials(target, options.chains ?? sdkCredentialChains);
  const now = options.now ?? (() => new Date());
  const wire: WireOptions = { ...options, ...(target.tls ? { tls: target.tls } : {}) };
  const get = async (subresource: string): Promise<WireResponse> => {
    const url = s3Url(target, subresource);
    const base: Record<string, string> = { "x-amz-content-sha256": EMPTY_SHA256 };
    if (target.expectedOwner) base["x-amz-expected-bucket-owner"] = target.expectedOwner;
    const headers = signV4({ method: "GET", url, headers: base, body: "", region: target.region, service: "s3", credentials, now: now() });
    const res = await sendGet("aws", url, headers, target.endpoint, wire);
    if (res.status === 404 && parseS3Error(res).error.code === "NoSuchBucket") {
      throw new BucketCheckError(`s3: bucket ${target.bucket} does not exist; the check creates no bucket`);
    }
    return res;
  };
  const ok = (r: WireResponse) => r.status >= 200 && r.status < 300;
  const v = await get("versioning");
  const l = await get("lifecycle");
  const p = await get("publicAccessBlock");
  return {
    versioning: ok(v) ? parseVersioning(v.body) : parseS3Error(v),
    lifecycle: ok(l) ? parseLifecycle(l.body) : parseS3Error(l),
    publicAccessBlock: ok(p) ? parsePublicAccessBlock(p.body) : parseS3Error(p),
  };
}

export async function checkS3Bucket(target: S3BucketTarget, options: S3ReadOptions & { namespaces?: readonly string[]; recoveryDays?: number } = {}): Promise<BucketReport> {
  const input = await readS3(target, options);
  const settings = evaluateS3(input, {
    bucket: target.bucket,
    namespaces: options.namespaces ?? [],
    ...(target.expectedOwner ? { expectedOwner: target.expectedOwner } : {}),
    ...(options.recoveryDays !== undefined ? { recoveryDays: options.recoveryDays } : {}),
  });
  return { store: "s3", bucket: target.bucket, namespaces: [...(options.namespaces ?? [])], correct: settings.every((f) => f.verdict === "ok"), settings };
}
