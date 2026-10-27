/**
 * chant#4558: the shared bucket check's vocabulary.
 *
 * Setting names are the ones plunge and choudoufu already use in
 * `allow_insecure` (plunge site/src/content/docs/use/setup.md, choudoufu
 * pkg/staterecord/{bucketcontract,gcscontract,azurecontract}.go), so a
 * product can map a waiver it reads onto a finding here by name.
 *
 * Verdicts are choudoufu `live-bucket -json`'s: "ok", "fail", "unreadable".
 * A denied read is never a pass. GCS's `list_isolation`, which only ever
 * warns a run, is not checked here.
 */

export type BucketStore = "s3" | "gcs" | "azblob";

export type BucketVerdict = "ok" | "fail" | "unreadable";

export const BUCKET_SETTINGS = {
  s3: ["versioning", "lifecycle", "public_access_block"],
  gcs: ["object_versioning", "noncurrent_lifecycle", "public_access_prevention", "uniform_bucket_level_access"],
  azblob: ["blob_versioning", "lifecycle_management", "public_access"],
} as const satisfies Record<BucketStore, readonly string[]>;

export type BucketSetting = (typeof BUCKET_SETTINGS)[BucketStore][number];

export interface BucketFinding {
  setting: BucketSetting;
  verdict: BucketVerdict;
  /** One clause quoting what the store has: "versioning is Suspended". */
  found: string;
  /**
   * A lifecycle rule that deletes current records. No `allow_insecure`
   * reaches it, in plunge or choudoufu, so a product must not offer one.
   */
  unwaivable: boolean;
  /** The command or change that fixes this setting; absent when it passed. */
  fix?: string;
}

export interface BucketReport {
  store: BucketStore;
  /** The bucket, or `account/container` for azblob. */
  bucket: string;
  /**
   * The key prefixes the lifecycle rule was checked against. Empty means
   * only a rule with no prefix filter is credited, the stricter answer that
   * holds for every estate sharing the bucket.
   */
  namespaces: string[];
  /** Every setting passed. */
  correct: boolean;
  /** One finding per setting, always all of them, in BUCKET_SETTINGS order. */
  settings: BucketFinding[];
}

/** An API read that failed, recorded in the fixture shape: `{ "error": { "code": "AccessDenied", "status": 403 } }`. */
export interface ReadError {
  error: { code?: string; status?: number };
}

export function isReadError(v: unknown): v is ReadError {
  return typeof v === "object" && v !== null && "error" in v && typeof (v as ReadError).error === "object";
}

/**
 * The findings a run refuses on once `waived` (the product's
 * `allow_insecure` list) is applied: every finding that did not pass and is
 * neither waived nor waivable. An unwaivable finding is refused whatever
 * the list says. Init asks whether the bucket is correct and reads
 * {@link BucketReport.correct}; this is for a product that also honours a
 * waiver the way plunge and choudoufu do on open.
 */
export function refusedFindings(report: BucketReport, waived: readonly string[]): BucketFinding[] {
  return report.settings.filter((f) => f.verdict !== "ok" && (f.unwaivable || !waived.includes(f.setting)));
}
