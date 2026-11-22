/**
 * `chant release scan` (#5466): a published or deployed release scanned again
 * against today's vulnerability database, and the result recorded beside the
 * scan the publish made.
 *
 * The publish scans before the stage (./publish-scan.ts) and records a
 * `scanned` line. A release keeps running after that, and the database
 * moves, so a scan made once can't show that a high finding was fixed in
 * time or that a new one went unseen. A rescan:
 *
 * - reads the SBOMs the publish recorded for the release from
 *   `_releases/publishes.jsonl`, and fetches each by its digest: an image's
 *   SBOM is an OCI referrer, whose manifest and layer are read from the
 *   registry and checked against the digests the record holds. An SBOM
 *   beside a forge release, or inside an npm package, is not fetched; the
 *   record says so for each (`skipped`), so the gap is on the page and not a
 *   pass;
 * - scans them with the scanner and `vulnPolicy` the publish uses (grype or
 *   trivy, and the VEX files `vulnPolicy.vexSources` names). Wiz scans an
 *   image archive, which a rescan does not have, so with `imageScanner:
 *   "wiz"` the SBOM goes to the wrapped scanner, as a package's does at the
 *   publish;
 * - appends a `rescanned` line to the publish record with the scanner, the
 *   database's version and build time, and every finding with what the
 *   policy made of it. The record is append-only, so a reader lists a
 *   release's scans in order ({@link scanLines}).
 *
 * Nothing is pushed to a registry. `chant release scan --deployed` rescans
 * every release the latest deploy record of each environment names.
 */

import { resolve as resolvePath } from "node:path";
import { createRedactor, type Redactor } from "./publish-credentials";
import { appendPublishRecord, readPublishRecords, type PublishRecord } from "./publish-record";
import { ociCredential, parseRepository, Registry } from "./publish-oci";
import { readVexSources, sbomDocumentOf, scanRecord, scanRecordBlocks, scanSubjects, SCAN_RECORD_TARGET, toolReleaseScanner, type ReleaseScanner, type ScanContext, type ScanRecord, type ScanSubject } from "./publish-scan";
import { bytesDigest } from "./publish-targets";
import { PublishTargetError, type PublishFetch } from "./release-publish";

/** One scan line of a release's publish record, in order: what the publish scanned, and each rescan. */
export interface ScanLine {
  step: "scanned" | "scan-failed" | "rescanned";
  timestamp: string;
  scan: ScanRecord | undefined;
  /** True when the line holds a finding the policy blocks, or is a `scan-failed` line. */
  blocked: boolean;
}

/** Every scan line of `records`, oldest first. */
export function scanLines(records: readonly Pick<PublishRecord, "kind" | "step" | "timestamp" | "scan">[]): ScanLine[] {
  return records
    .filter((r) => r.kind === "scan" && (r.step === "scanned" || r.step === "scan-failed" || r.step === "rescanned"))
    .map((r) => ({ step: r.step as ScanLine["step"], timestamp: r.timestamp, scan: r.scan, blocked: r.step === "scan-failed" || (r.scan !== undefined && scanRecordBlocks(r.scan)) }));
}

/** The newest scan line of a release, as `chant release list --json` shows it (#5466). */
export interface NewestScan {
  step: ScanLine["step"];
  at: string;
  scanner: string | null;
  database: ScanRecord["database"];
  /** How many findings the scan recorded, in all its subjects. */
  findings: number;
  /** True when the policy blocks a finding, or the publish's scan was stopped by it. */
  blocked: boolean;
}

/** The newest scan line of each release in the member's publish record, by release digest. */
export async function newestScans(loc: { cwd?: string }): Promise<Map<string, NewestScan>> {
  const { readBlobFromPath } = await import("./git");
  const { RELEASES_DIR } = await import("./release-store");
  const { parsePublishRecords, PUBLISHES_FILE } = await import("./publish-record");
  const { records } = parsePublishRecords(await readBlobFromPath(RELEASES_DIR, PUBLISHES_FILE, loc).catch(() => null));
  const byRelease = new Map<string, PublishRecord[]>();
  for (const r of records) byRelease.set(r.releaseDigest, [...(byRelease.get(r.releaseDigest) ?? []), r]);
  const out = new Map<string, NewestScan>();
  for (const [digest, list] of byRelease) {
    const line = scanLines(list).at(-1);
    if (!line) continue;
    out.set(digest, { step: line.step, at: line.timestamp, scanner: line.scan?.scanner ?? null, database: line.scan?.database ?? null, findings: line.scan?.subjects.reduce((n, s) => n + s.findings.length, 0) ?? 0, blocked: line.blocked });
  }
  return out;
}

/** The SBOMs a release's publish recorded, fetched, and what could not be. */
export interface RecordedSboms {
  subjects: ScanSubject[];
  skipped: Array<{ name: string; reason: string }>;
}

/** The newest `revealed` line of each target of `records`. */
function revealedByTarget(records: readonly PublishRecord[]): PublishRecord[] {
  const newest = new Map<string, PublishRecord>();
  for (const r of records) if (r.step === "revealed") newest.set(r.target, r);
  return [...newest.values()];
}

/**
 * Fetch the SBOMs `releaseDigest`'s publish recorded. An image's is read from
 * its registry by the referrer's digest, with the credentials the publish
 * would use (`OCI_USERNAME` and `OCI_PASSWORD`, else the docker config).
 */
export async function recordedSboms(req: { cwd: string; releaseDigest: string; env: NodeJS.ProcessEnv; redactor: Redactor; fetch?: PublishFetch; records?: readonly PublishRecord[] }): Promise<RecordedSboms> {
  const records = req.records ?? (await readPublishRecords(req.releaseDigest, { cwd: req.cwd }));
  const fetchImpl: PublishFetch = req.fetch ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<PublishFetch>);
  const out: RecordedSboms = { subjects: [], skipped: [] };
  for (const r of revealedByTarget(records)) {
    const sboms = r.items.filter((i) => i.attachment === "sbom");
    if (r.kind !== "oci") {
      if (r.kind === "forge" || r.kind === "npm") {
        out.skipped.push({ name: r.name, reason: `the SBOM of ${r.kind === "forge" ? "a forge release's assets" : "an npm package"} is not fetched by a rescan; the publish scanned it` });
      }
      continue;
    }
    const image = r.items.find((i) => i.attachment === undefined && i.digest);
    if (!image?.digest) continue;
    const name = `${image.destination.split("@")[0]}@${image.digest}`;
    if (sboms.length === 0) {
      out.skipped.push({ name, reason: "the publish recorded no SBOM for the image" });
      continue;
    }
    const repository = image.destination.split("@")[0]!;
    const repo = parseRepository(repository);
    const cred = ociCredential({}, repo, { env: req.env, redactor: req.redactor });
    const registry = new Registry(repo, fetchImpl, cred, { cwd: req.cwd, env: req.env, redactor: req.redactor, log: () => undefined, provenance: { oidc: false, ci: null, reason: "" }, tag: null });
    registry.actions = "pull";
    for (const sbom of sboms) {
      const why = (reason: string) => out.skipped.push({ name: `${sbom.name} of ${name}`, reason });
      if (!sbom.digest) {
        why("the publish record names no digest for it");
        continue;
      }
      try {
        const manifest = await registry.getManifest(sbom.digest);
        if (!manifest) {
          why(`${repository} holds no manifest ${sbom.digest}`);
          continue;
        }
        if (bytesDigest(manifest.bytes) !== sbom.digest) {
          why(`${repository} served a manifest that is not ${sbom.digest}`);
          continue;
        }
        const parsed = JSON.parse(Buffer.from(manifest.bytes).toString("utf-8")) as { subject?: { digest?: string }; layers?: Array<{ digest: string }> };
        if (parsed.subject?.digest !== image.digest) {
          why(`${sbom.digest} is not a referrer of ${image.digest}`);
          continue;
        }
        const layer = parsed.layers?.[0];
        const bytes = layer ? await registry.getBlob(layer.digest) : null;
        if (!bytes) {
          why(`${repository} holds no SBOM blob for ${sbom.digest}`);
          continue;
        }
        out.subjects.push({ target: r.name, name, sbom: sbomDocumentOf(bytes, "recorded"), digest: image.digest });
      } catch (err) {
        why(redact(req.redactor, err));
      }
    }
  }
  return out;
}

const redact = (redactor: Redactor, err: unknown): string => redactor.redact(err instanceof Error ? err.message : String(err));

/** What a rescan of one release found. */
export interface RescanResult {
  releaseDigest: string;
  label: string | null;
  record: ScanRecord;
  /** True when the policy blocks a finding. */
  blocked: boolean;
  /** True when nothing was scanned, which is not a pass. */
  nothingScanned: boolean;
  /** Why the record was not written or pushed, when it wasn't. */
  recordWarning: string | null;
}

/** The scanner, policy and VEX documents a rescan uses, from the member's `chant.config.ts`, as the publish takes them. */
export async function prepareRescan(req: { cwd: string; env: NodeJS.ProcessEnv; scanner?: ReleaseScanner }): Promise<{ scan: ScanContext } | { refusal: { code: string; message: string; fix?: string } }> {
  const { loadChantConfig, resolveVulnPolicy } = await import("../config");
  const loaded = await loadChantConfig(req.cwd).catch(() => null);
  const config = loaded?.config;
  const setting = config?.release?.scan;
  const db = typeof setting === "object" && setting.db ? resolvePath(req.cwd, setting.db) : null;
  const scanner = req.scanner ?? toolReleaseScanner(req.env, { tool: config?.vulnPolicy?.scanner ?? "grype", db, redactor: createRedactor(req.env) });
  const missing = scanner.unavailable({ images: false });
  if (missing) {
    return { refusal: { code: "publish-scan-tool-missing", message: `the release can't be scanned: ${missing}`, fix: "Install grype (or trivy), or point CHANT_GRYPE or CHANT_TRIVY at it; release.scan.db names a directory that holds a database already." } };
  }
  let vex: string[];
  try {
    vex = readVexSources(req.cwd, config?.vulnPolicy?.vexSources);
  } catch (err) {
    const e = err as PublishTargetError;
    return { refusal: { code: "publish-scan-vex-missing", message: e.message, ...(e.fix ? { fix: e.fix } : {}) } };
  }
  return { scan: { scanner, policy: config ? resolveVulnPolicy(config) : {}, vex } };
}

/**
 * Scan again the SBOMs `releaseDigest`'s publish recorded, and append a
 * `rescanned` line to its publish record. `record: false` writes nothing.
 * `deployed` names the environments that run the release, when this is a
 * `--deployed` rescan.
 */
export async function rescanRelease(req: {
  cwd: string;
  releaseDigest: string;
  label: string | null;
  env: NodeJS.ProcessEnv;
  scan: ScanContext;
  fetch?: PublishFetch;
  record?: boolean;
  deployed?: readonly string[];
  say?: (line: string) => void;
  now?: () => Date;
}): Promise<RescanResult> {
  const redactor = createRedactor(req.env);
  const found = await recordedSboms({ cwd: req.cwd, releaseDigest: req.releaseDigest, env: req.env, redactor, ...(req.fetch ? { fetch: req.fetch } : {}) });
  const report = await scanSubjects(found.subjects, req.scan, req.say);
  const record: ScanRecord = { ...scanRecord(report), ...(found.skipped.length > 0 ? { skipped: found.skipped } : {}) };
  let recordWarning: string | null = null;
  if (req.record !== false) {
    try {
      await appendPublishRecord(
        {
          version: 1,
          releaseDigest: req.releaseDigest,
          label: req.label,
          target: SCAN_RECORD_TARGET.key,
          kind: SCAN_RECORD_TARGET.kind,
          name: SCAN_RECORD_TARGET.name,
          step: "rescanned",
          items: [],
          scan: record,
          state: req.deployed && req.deployed.length > 0 ? { deployed: [...req.deployed].sort().join(",") } : {},
          runId: req.env.GITHUB_RUN_ID ?? req.env.CI_PIPELINE_ID ?? `rescan-${(req.now ?? (() => new Date()))().getTime()}`,
          timestamp: (req.now ?? (() => new Date()))().toISOString(),
        },
        redactor,
        { cwd: req.cwd },
      );
      const { pushLifecycleReport } = await import("./git");
      const push = await pushLifecycleReport({ cwd: req.cwd });
      recordWarning = push.pushWarning ?? null;
    } catch (err) {
      recordWarning = `the rescan was not recorded: ${redact(redactor, err)}`;
    }
  }
  return { releaseDigest: req.releaseDigest, label: req.label, record, blocked: scanRecordBlocks(record), nothingScanned: report.subjects.length === 0, recordWarning };
}

/**
 * The releases an environment's latest deploy records name (#5466): the
 * `releaseDigest` of each component's newest record in `<env>/releases.jsonl`,
 * distinct, with the environments that run each. `env` limits it to one.
 */
export async function deployedReleases(req: { cwd: string; env?: string }): Promise<Map<string, string[]>> {
  const { listReleaseEnvironments, readReleaseLedger, latestPerComponent } = await import("./release-ledger");
  const envs = req.env ? [req.env] : await listReleaseEnvironments({ cwd: req.cwd });
  const out = new Map<string, string[]>();
  for (const env of envs) {
    const { records } = await readReleaseLedger(env, { cwd: req.cwd });
    for (const r of latestPerComponent(records).values()) {
      if (!r.releaseDigest) continue;
      out.set(r.releaseDigest, [...new Set([...(out.get(r.releaseDigest) ?? []), env])]);
    }
  }
  return out;
}
