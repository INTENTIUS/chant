/**
 * Which roots are choudoufu live roots, their estates, and the setup
 * choudoufu resolves for each (chant#4910).
 *
 * - {@link liveRoots}: the roots that keep their resources under choudoufu's
 *   live markers, a `live` block in a `terraform` block or an
 *   `estate.chdf.hcl` sidecar.
 * - {@link estateOf}: a root's estate as its files name it, and the estates
 *   whose recorded outputs it reads through `data "terraform_estate_outputs"`.
 * - {@link readLiveSetup}: the record store and estate choudoufu resolves
 *   for a root, from `choudoufu live-check -json` (its `estate`,
 *   `estate_source` and `record_store` fields), remembered for the process,
 *   and {@link resolvedEstate}, which prefers it to the files' own name. A
 *   choudoufu release that prints no `estate_source` gives no setup, and the
 *   readers fall back to the files.
 * - {@link setupLine}, {@link storePhrase}, {@link bucketTarget},
 *   {@link checkStoreBucket} and {@link bucketLines}: the setup as a log line,
 *   and core's bucket check (`@intentius/chant/bucket-check`, chant#4558) on
 *   the resolved store.
 *
 * Text reads, as `./op/activities/live-detect.ts` does them: no HCL parser
 * is loaded. Lifted from terragucci's `detect.ts` (`liveRoots`, `estateOf`)
 * and `live-setup.ts`, so terragucci deletes its copies.
 */
import { join, resolve } from "node:path";
import { checkBucket, type BucketReport, type BucketTarget } from "@intentius/chant/bucket-check";
import { declaresLive, detectLiveEstate, estateOutputReads } from "./op/activities/live-detect";
import { runBinary, type BinaryExec } from "./state/exec";

export { declaresLive, detectLiveEstate, estateOutputReads } from "./op/activities/live-detect";

/** The roots of `roots` (paths under `repo`) that keep their resources under choudoufu's live markers, in the order given. */
export function liveRoots(repo: string, roots: readonly string[], binary = "choudoufu"): string[] {
  return roots.filter((r) => declaresLive(join(repo, r), binary));
}

/** A root's estate, as its sidecar or `live` block names it, and the estates whose recorded outputs it reads. */
export function estateOf(dir: string, binary = "choudoufu"): { estate?: string; reads: string[] } {
  const estate = detectLiveEstate(dir, binary);
  return { ...(estate ? { estate } : {}), reads: estateOutputReads(dir, binary).map((r) => r.estate) };
}

/** Where choudoufu's estate name came from: the live block, the configuration's tags, the backend key, or the root's path. */
export type EstateSource = "explicit" | "tags" | "backend_key" | "root_path" | "none";

/** The record store choudoufu resolved, as `live-check -json` prints it. */
export interface LiveStore {
  /** `local`, `s3`, `gcs`, `azurerm` or `kubernetes`. */
  kind: string;
  /** The s3 or gcs bucket, `<account>/<container>` for azurerm, the namespace for kubernetes, the directory for local. */
  bucket: string;
  /** Where this estate's records go, with one trailing slash. */
  prefix: string;
  /** `record_store` (written by the author), `backend` (derived from the backend block) or `implied` (the local store). */
  source: string;
  /** `file:line` of the block that decided it. */
  declaredAt?: string;
  /** Why a backend that was there was not used. */
  note?: string;
}

/** What choudoufu resolves for one root. */
export interface LiveSetup {
  estate?: string;
  estateSource: string;
  store?: LiveStore;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The setup in a `live-check -json` document, or undefined when the document is not JSON or comes from a choudoufu that does not print `estate_source`. */
export function parseLiveSetup(stdout: string): LiveSetup | undefined {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object" || typeof doc.estate_source !== "string") return undefined;
  const rs = doc.record_store && typeof doc.record_store === "object" ? (doc.record_store as Record<string, unknown>) : undefined;
  const kind = str(rs?.kind);
  const store: LiveStore | undefined =
    rs && kind
      ? {
          kind,
          bucket: str(rs.bucket) ?? "",
          prefix: str(rs.prefix) ?? "",
          source: str(rs.source) ?? "",
          ...(str(rs.declared_at) ? { declaredAt: str(rs.declared_at) } : {}),
          ...(str(rs.note) ? { note: str(rs.note) } : {}),
        }
      : undefined;
  const estate = str(doc.estate);
  return { ...(estate ? { estate } : {}), estateSource: doc.estate_source, ...(store ? { store } : {}) };
}

const known = new Map<string, LiveSetup>();

/** Keep what choudoufu resolved for a root's directory, for the readers below. */
export function rememberLiveSetup(dir: string, setup: LiveSetup): void {
  known.set(resolve(dir), setup);
}

/** What choudoufu resolved for a root's directory in this process, if it was read. */
export function knownLiveSetup(dir: string): LiveSetup | undefined {
  return known.get(resolve(dir));
}

/** For tests: forget every setup read so far. */
export function forgetLiveSetups(): void {
  known.clear();
}

/**
 * `choudoufu live-check -json <dir>` for one root, run in the directory, and
 * the setup it prints, remembered for the process. Undefined when the binary
 * prints none (an older release, a root it cannot read, or no binary at
 * all); the caller then reads the files. A root that live-check blocks still
 * prints its setup, so the exit code is not read.
 */
export async function readLiveSetup(dir: string, options: { binary?: string; exec?: BinaryExec; env?: NodeJS.ProcessEnv } = {}): Promise<LiveSetup | undefined> {
  const at = resolve(dir);
  const had = known.get(at);
  if (had) return had;
  const exec = options.exec ?? runBinary;
  let stdout: string;
  try {
    stdout = (await exec(options.binary ?? "choudoufu", ["live-check", "-json", at], at, options.env ?? process.env)).stdout;
  } catch {
    return undefined;
  }
  const setup = parseLiveSetup(stdout);
  if (setup) known.set(at, setup);
  return setup;
}

/** A live root's estate: choudoufu's resolved name when it was read, else the name its files write. */
export function resolvedEstate(dir: string, binary = "choudoufu"): string | undefined {
  return knownLiveSetup(dir)?.estate ?? estateOf(dir, binary).estate;
}

const STORE_FROM: Record<string, string> = {
  record_store: "from its record_store block",
  backend: "derived from its backend block",
  implied: "the local store, since no backend block gives one",
};

const ESTATE_FROM: Record<EstateSource, string> = {
  explicit: "named by its live block",
  tags: "from its tofu-estate tags",
  backend_key: "from the backend key",
  root_path: "from the root's path",
  none: "none resolves",
};

/** The store as one phrase: `s3 bucket "acme" under tofu-records/prod/`. */
export function storePhrase(s: LiveStore): string {
  if (s.kind === "local") return `the local directory ${s.bucket || ".tofu-records"} under ${s.prefix}`;
  if (s.kind === "azurerm") return `azurerm container ${s.bucket} under ${s.prefix}`;
  if (s.kind === "kubernetes") return `kubernetes namespace ${s.bucket} under ${s.prefix}`;
  return `${s.kind} bucket "${s.bucket}" under ${s.prefix}`;
}

/** A root's setup on one line: where its records go, where that came from, and its estate. */
export function setupLine(root: string, setup: LiveSetup): string {
  const s = setup.store;
  const where = s ? `records in ${storePhrase(s)} (${STORE_FROM[s.source] ?? s.source}${s.declaredAt ? ` at ${s.declaredAt}` : ""})` : "no record store resolved";
  const estate = setup.estate ? `estate "${setup.estate}" (${ESTATE_FROM[setup.estateSource as EstateSource] ?? setup.estateSource})` : "no estate resolves";
  return `${root}: ${where}; ${estate}${s?.note ? `; ${s.note}` : ""}`;
}

/** The setup's store is the local directory, which is empty on every CI run. */
export const onLocalStore = (setup: LiveSetup): boolean => setup.store?.kind === "local";

/**
 * The bucket core's check reads for a resolved store, or why there is none.
 * `backend` is the root's backend block's string attributes, for the s3
 * region and the azurerm subscription and resource group. s3 takes the
 * region from there or the job, and an emulator's endpoint and keys from the
 * job; gcs an emulator from `STORAGE_EMULATOR_HOST`; azurerm needs the
 * subscription and resource group, from the backend block or
 * `ARM_SUBSCRIPTION_ID`.
 */
export function bucketTarget(s: LiveStore, backend: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env): { target: BucketTarget } | { skip: string } {
  if (s.kind === "s3") {
    const region = backend.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (!region) return { skip: "no region: set region in the backend block or AWS_REGION" };
    const endpoint = env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
    const keys =
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) }
        : undefined;
    if (endpoint && !keys) return { skip: "AWS_ENDPOINT_URL is set with no AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY" };
    return { target: { store: "s3", bucket: s.bucket, region, ...(endpoint ? { endpoint, credentials: keys } : {}) } as BucketTarget };
  }
  if (s.kind === "gcs") {
    const emulator = env.STORAGE_EMULATOR_HOST;
    return { target: { store: "gcs", bucket: s.bucket, ...(emulator ? { endpoint: /^https?:\/\//.test(emulator) ? emulator : `http://${emulator}`, token: null } : {}) } as BucketTarget };
  }
  if (s.kind === "azurerm") {
    const [account, container] = s.bucket.split("/");
    const subscriptionId = backend.subscription_id ?? env.ARM_SUBSCRIPTION_ID;
    const resourceGroup = backend.resource_group_name;
    if (!account || !container) return { skip: "the store names no storage account and container" };
    if (!subscriptionId || !resourceGroup) return { skip: "the bucket check needs the subscription and resource group: set resource_group_name in the backend block, and subscription_id there or ARM_SUBSCRIPTION_ID" };
    return { target: { store: "azblob", subscriptionId, resourceGroup, account, container } as BucketTarget };
  }
  return { skip: `a ${s.kind} store has no bucket to check` };
}

/** What the bucket check said about one root's store. */
export type BucketOutcome = { checked: BucketReport } | { skipped: string };

/**
 * Core's bucket check on a root's resolved store: the settings choudoufu
 * refuses to open the bucket without. It reads only. A store with no bucket,
 * or a check that cannot run, is skipped with the reason; nothing here throws.
 * `check` is injectable for tests.
 */
export async function checkStoreBucket(
  s: LiveStore,
  backend: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
  check: (target: BucketTarget, options: { namespaces: string[] }) => Promise<BucketReport> = checkBucket,
): Promise<BucketOutcome> {
  if (s.kind === "local") return { skipped: "the local store has no bucket" };
  const t = bucketTarget(s, backend, env);
  if ("skip" in t) return { skipped: t.skip };
  try {
    return { checked: await check(t.target, { namespaces: s.prefix ? [s.prefix] : [] }) };
  } catch (e) {
    return { skipped: `the bucket could not be checked: ${(e as Error).message}` };
  }
}

/** The bucket check's outcome as lines: one for a correct bucket, else one per setting that did not pass, with its fix. */
export function bucketLines(root: string, outcome: BucketOutcome): string[] {
  if ("skipped" in outcome) return [`${root}: bucket not checked: ${outcome.skipped}`];
  const r = outcome.checked;
  if (r.correct) return [`${root}: bucket ${r.bucket} has every setting choudoufu needs (${r.settings.map((f) => f.setting).join(", ")})`];
  return r.settings
    .filter((f) => f.verdict !== "ok")
    .map((f) => `${root}: bucket ${r.bucket}: ${f.setting} ${f.verdict === "unreadable" ? "could not be read" : "fails"}: ${f.found}${f.unwaivable ? " (no allow_insecure reaches this one)" : ""}${f.fix ? `; fix: ${f.fix}` : ""}`);
}
