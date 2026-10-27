/**
 * chant#4558: the GCS bucket check. One read, the JSON API's bucket resource
 * (storage.buckets.get), then {@link evaluateGcs}, a port of the first four
 * settings of choudoufu's pkg/staterecord/gcscontract.go
 * (CheckGCSBucketContract). The fifth, list_isolation, only ever warns a run
 * and needs an object listing, so it is left to the engines.
 *
 * With an `endpoint`, the target must carry a token (or `token: null` for an
 * anonymous emulator) and every call is pinned to that endpoint;
 * application-default credentials are never used against it.
 */

import { resolveGcpToken, sdkCredentialChains, type CredentialChains } from "../cloud-lister/credentials";
import { jsonBody, type TlsOptions } from "../cloud-lister/transport";
import { isReadError, type BucketFinding, type BucketReport, type ReadError } from "./types";
import { BucketCheckError, namespacePrefix, sendGet, type WireOptions } from "./wire";

export interface GcsBucketTarget {
  store: "gcs";
  bucket: string;
  /** An emulator's JSON API base, e.g. `http://localhost:4443`. Requires `token`. */
  endpoint?: string;
  /** An OAuth access token; `null` sends none (an emulator with IAM enforcement off). */
  token?: string | null;
  tls?: TlsOptions;
}

/** The JSON API's lifecycle condition, as GET /storage/v1/b/{bucket} returns it. */
export interface GcsLifecycleCondition {
  age?: number;
  createdBefore?: string;
  isLive?: boolean;
  matchesPrefix?: string[];
  matchesSuffix?: string[];
  matchesStorageClass?: string[];
  numNewerVersions?: number;
  daysSinceNoncurrentTime?: number;
  noncurrentTimeBefore?: string;
  customTimeBefore?: string;
  daysSinceCustomTime?: number;
}

export interface GcsLifecycleRule {
  action?: { type?: string; storageClass?: string };
  condition?: GcsLifecycleCondition;
}

/** The fields of the bucket resource the check reads, or the read's error. */
export type GcsInput =
  | {
      versioning?: { enabled?: boolean };
      lifecycle?: { rule?: GcsLifecycleRule[] };
      iamConfiguration?: {
        publicAccessPrevention?: string;
        uniformBucketLevelAccess?: { enabled?: boolean };
      };
    }
  | ReadError;

export interface GcsEvaluateOptions {
  bucket: string;
  namespaces?: readonly string[];
  recoveryDays?: number;
}

const DELETE = "Delete";

function noncurrentOnly(c: GcsLifecycleCondition): boolean {
  return c.isLive === false || (c.daysSinceNoncurrentTime ?? 0) > 0 || (c.numNewerVersions ?? 0) > 0 || !!c.noncurrentTimeBefore;
}

function expiryGap(c: GcsLifecycleCondition): string {
  if (!noncurrentOnly(c)) return "also matches live objects";
  if ((c.matchesSuffix?.length ?? 0) > 0 || (c.matchesStorageClass?.length ?? 0) > 0 || !!c.customTimeBefore || (c.daysSinceCustomTime ?? 0) > 0 || !!c.createdBefore) {
    return "is filtered by suffix, storage class, custom time or creation date, which this check does not rely on";
  }
  if ((c.daysSinceNoncurrentTime ?? 0) <= 0 && (c.numNewerVersions ?? 0) <= 0 && (c.age ?? 0) <= 0 && !c.noncurrentTimeBefore) {
    return "does so as soon as they become noncurrent, which leaves no recovery window";
  }
  return "";
}

function covers(c: GcsLifecycleCondition, ns: string): boolean {
  const prefixes = c.matchesPrefix ?? [];
  if (prefixes.length === 0) return true;
  if (ns === "") return false;
  return prefixes.some((p) => namespacePrefix(ns).startsWith(p));
}

function mayReach(c: GcsLifecycleCondition, namespaces: readonly string[]): boolean {
  const prefixes = c.matchesPrefix ?? [];
  if (prefixes.length === 0 || namespaces.length === 0) return true;
  return prefixes.some((p) =>
    namespaces.some((ns) => {
      const n = namespacePrefix(ns);
      return n.startsWith(p) || p.startsWith(n);
    }),
  );
}

function describe(c: GcsLifecycleCondition): string {
  const parts: string[] = [];
  if ((c.age ?? 0) > 0) parts.push(`${c.age} day(s) after creation`);
  if ((c.daysSinceNoncurrentTime ?? 0) > 0) parts.push(`${c.daysSinceNoncurrentTime} day(s) after becoming noncurrent`);
  if ((c.numNewerVersions ?? 0) > 0) parts.push(`once ${c.numNewerVersions} newer version(s) exist`);
  if (c.createdBefore) parts.push(`if created before ${c.createdBefore.slice(0, 10)}`);
  if (c.noncurrentTimeBefore) parts.push(`if noncurrent before ${c.noncurrentTimeBefore.slice(0, 10)}`);
  return parts.length === 0 ? "" : " " + parts.join(" and ");
}

export function gcsLifecycleFix(bucket: string, namespaces: readonly string[], recoveryDays: number): string {
  const condition: GcsLifecycleCondition = { isLive: false, daysSinceNoncurrentTime: recoveryDays };
  if (namespaces.length > 0) condition.matchesPrefix = namespaces.map(namespacePrefix);
  const doc = JSON.stringify({ rule: [{ action: { type: DELETE }, condition }] });
  return (
    `Write ${doc} to lifecycle.json, then: gcloud storage buckets update gs://${bucket} --lifecycle-file=lifecycle.json ` +
    `(this replaces the bucket's lifecycle rules, so add this rule to any it already has; ${recoveryDays} days is how long a deleted or overwritten record stays recoverable)`
  );
}

export function evaluateGcs(input: GcsInput, options: GcsEvaluateOptions): BucketFinding[] {
  const { bucket } = options;
  const namespaces = options.namespaces ?? [];
  const recoveryDays = options.recoveryDays ?? 30;
  if (isReadError(input)) {
    if (input.error.status !== 403) {
      throw new BucketCheckError(`gcs: reading bucket ${bucket}'s settings failed: ${input.error.code ?? `HTTP ${input.error.status ?? "?"}`}`);
    }
    const fix = "Grant the identity storage.buckets.get on the bucket, or have someone who holds it confirm the setting.";
    return (["object_versioning", "noncurrent_lifecycle", "public_access_prevention", "uniform_bucket_level_access"] as const).map((setting) => ({
      setting,
      verdict: "unreadable" as const,
      found: "storage.buckets.get was denied",
      unwaivable: false,
      fix,
    }));
  }

  const versioning: BucketFinding = input.versioning?.enabled
    ? { setting: "object_versioning", verdict: "ok", found: "Object Versioning is enabled", unwaivable: false }
    : { setting: "object_versioning", verdict: "fail", found: "Object Versioning is not enabled", unwaivable: false, fix: `gcloud storage buckets update gs://${bucket} --versioning` };

  const pap = input.iamConfiguration?.publicAccessPrevention ?? "";
  const papFix = `gcloud storage buckets update gs://${bucket} --public-access-prevention`;
  const publicAccess: BucketFinding =
    pap === "enforced"
      ? { setting: "public_access_prevention", verdict: "ok", found: "public access prevention is enforced", unwaivable: false }
      : {
          setting: "public_access_prevention",
          verdict: "fail",
          found: pap === "inherited" ? "public access prevention is inherited, not enforced on the bucket" : `public access prevention is ${pap || "unspecified"}, not enforced`,
          unwaivable: false,
          fix: papFix,
        };

  const ubla: BucketFinding = input.iamConfiguration?.uniformBucketLevelAccess?.enabled
    ? { setting: "uniform_bucket_level_access", verdict: "ok", found: "uniform bucket-level access is enabled", unwaivable: false }
    : {
        setting: "uniform_bucket_level_access",
        verdict: "fail",
        found: "uniform bucket-level access is off, so object ACLs grant access beside IAM",
        unwaivable: false,
        fix: `gcloud storage buckets update gs://${bucket} --uniform-bucket-level-access`,
      };

  return [versioning, lifecycle(input.lifecycle?.rule ?? [], bucket, namespaces, recoveryDays), publicAccess, ubla];
}

function lifecycle(rules: GcsLifecycleRule[], bucket: string, namespaces: readonly string[], recoveryDays: number): BucketFinding {
  const fail = (found: string): BucketFinding => ({ setting: "noncurrent_lifecycle", verdict: "fail", found, unwaivable: false, fix: gcsLifecycleFix(bucket, namespaces, recoveryDays) });
  const cond = (r: GcsLifecycleRule): GcsLifecycleCondition => r.condition ?? {};

  const deleting: string[] = [];
  rules.forEach((r, i) => {
    if (r.action?.type !== DELETE || noncurrentOnly(cond(r)) || !mayReach(cond(r), namespaces)) return;
    deleting.push(`rule ${i + 1} deletes live objects${describe(cond(r))}, and a record is a live object`);
  });
  if (deleting.length > 0) {
    return {
      setting: "noncurrent_lifecycle",
      verdict: "fail",
      found: deleting.join("; "),
      unwaivable: true,
      fix: "Give the rule a noncurrent-only condition (isLive: false, daysSinceNoncurrentTime or numNewerVersions), or limit it with matchesPrefix to objects outside these keys.",
    };
  }

  const near: string[] = [];
  const covering: number[] = [];
  rules.forEach((r, i) => {
    if (r.action?.type !== DELETE) return;
    const why = expiryGap(cond(r));
    if (why !== "") {
      near.push(`rule ${i + 1} deletes noncurrent versions but ${why}`);
      return;
    }
    covering.push(i);
  });
  const targets = namespaces.length === 0 ? [""] : namespaces;
  const used: string[] = [];
  const uncovered: string[] = [];
  for (const ns of targets) {
    const i = covering.find((j) => covers(cond(rules[j]!), ns));
    if (i !== undefined) {
      const d = `rule ${i + 1} deletes noncurrent versions${describe(cond(rules[i]!))}`;
      if (!used.includes(d)) used.push(d);
    } else {
      uncovered.push(ns);
    }
  }
  if (uncovered.length === 0 && covering.length > 0) return { setting: "noncurrent_lifecycle", verdict: "ok", found: used.join("; "), unwaivable: false };
  for (const i of covering) {
    const prefixes = (cond(rules[i]!).matchesPrefix ?? []).join(", ");
    if (namespaces.length === 0) {
      near.push(`rule ${i + 1} deletes noncurrent versions but only under the prefixes ${prefixes}, and this check was not told which objects the store writes`);
      continue;
    }
    for (const ns of uncovered) near.push(`rule ${i + 1} deletes noncurrent versions but only under the prefixes ${prefixes}, none of which contains "${namespacePrefix(ns)}"`);
  }
  if (near.length > 0) return fail(near.join("; "));
  if (rules.length === 0) return fail("the bucket has no lifecycle rules");
  return fail(`none of the bucket's ${rules.length} lifecycle rule(s) deletes noncurrent versions`);
}

export interface GcsReadOptions extends WireOptions {
  chains?: CredentialChains;
}

export function gcsUrl(target: GcsBucketTarget): string {
  const base = (target.endpoint ?? "https://storage.googleapis.com").replace(/\/+$/, "");
  return `${base}/storage/v1/b/${encodeURIComponent(target.bucket)}?projection=noAcl`;
}

export async function readGcs(target: GcsBucketTarget, options: GcsReadOptions = {}): Promise<GcsInput> {
  const token = await resolveGcpToken(target, options.chains ?? sdkCredentialChains);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await sendGet("gcp", gcsUrl(target), headers, target.endpoint, { ...options, ...(target.tls ? { tls: target.tls } : {}) });
  if (res.status === 404) throw new BucketCheckError(`gcs: bucket ${target.bucket} does not exist; the check creates no bucket`);
  if (res.status < 200 || res.status >= 300) {
    const body = jsonBody(res) as { error?: { status?: string } } | undefined;
    return { error: { status: res.status, ...(body?.error?.status ? { code: body.error.status } : {}) } };
  }
  const body = jsonBody(res);
  if (typeof body !== "object" || body === null) throw new BucketCheckError(`gcs: bucket ${target.bucket}: the answer was not JSON`);
  return body as GcsInput;
}

export async function checkGcsBucket(target: GcsBucketTarget, options: GcsReadOptions & { namespaces?: readonly string[]; recoveryDays?: number } = {}): Promise<BucketReport> {
  const input = await readGcs(target, options);
  const settings = evaluateGcs(input, {
    bucket: target.bucket,
    namespaces: options.namespaces ?? [],
    ...(options.recoveryDays !== undefined ? { recoveryDays: options.recoveryDays } : {}),
  });
  return { store: "gcs", bucket: target.bucket, namespaces: [...(options.namespaces ?? [])], correct: settings.every((f) => f.verdict === "ok"), settings };
}
