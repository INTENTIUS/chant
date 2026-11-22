/**
 * The vulnerability scan before the stage (#5446).
 *
 * `chant release publish` stages every target before it reveals any (#4048),
 * but the stage is not private: an `oci` target pushes the layers, the
 * manifest and its referrers by digest, and a signed image can be pulled by
 * digest from then on. So the scan runs before the stage, and before
 * anything is signed, on what each target would put out:
 *
 * - an `oci` target: its local OCI archive, which `chant release images`
 *   already checked against the release's digests, scanned through an SBOM
 *   syft makes from the image's layers, so the OS packages are in it; and
 *   the SBOM the target attaches;
 * - a `forge` target: the SBOM it attaches beside its assets (goreleaser and
 *   nfpm files among them);
 * - an `npm` target: the SBOM each package carries, or, for a package that
 *   carries none, one written from the member's lockfile.
 *
 * Each SBOM goes through the same gate a component's `vuln-gate` step runs
 * (../components/verbs/vuln-gate.ts), with the project's `vulnPolicy`:
 * `failSeverity`, `fixableOnly`, `failOnKev`, the EPSS thresholds, and the
 * VEX files `vulnPolicy.vexSources` names. A finding the policy blocks stops
 * the publish with `publish-scan-failed` before any target stages, so
 * nothing reaches a registry: no layer, manifest or referrer.
 *
 * The scan is on under the `supply-chain` group and can be turned on alone
 * with `release.scan` in `chant.config.ts`; `release.scan: false` turns it
 * off under the group, with a warning. The scanner is grype (or trivy, from
 * `vulnPolicy.scanner`), and syft makes the image SBOM. A run finds them in
 * `CHANT_GRYPE`, `CHANT_TRIVY` and `CHANT_SYFT`, which the steps `chant
 * release workflow` renders set to the binaries ../tool-pins.ts pins, else on
 * `PATH`. The scanner downloads its database over the network on first use;
 * `release.scan.db` names a directory that already holds one, which the
 * scan then reads without updating it.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SecurityGroup } from "../workspace/security";
import type { SbomDocument } from "../components/verbs/sbom-generator";
import { SBOM_MEDIA_TYPES } from "../components/verbs/sbom-generator";
import { parseGrypeOutput, parseTrivyOutput, type ScannerTool, type VulnFinding } from "../components/verbs/vuln-scan";
import { createVulnGateCapability, VulnGateFailedError, type BlockingFinding, type VulnPolicy } from "../components/verbs/vuln-gate";
import type { SuppressedFinding } from "../components/verbs/vex";
import type { Redactor } from "./publish-credentials";
import { PublishTargetError, type PublishContext, type PublishTarget } from "./release-publish";

/** `release.scan` in `chant.config.ts`: `true`, `false`, or `{ db }` to scan with a database already on disk. */
export type ReleaseScanConfig = boolean | { db?: string };

/** Whether a publish scans, and why. */
export interface ScanSetting {
  on: boolean;
  /** `config` (release.scan), `supply-chain` (the group), or `off`. */
  from: "config" | "supply-chain" | "off";
  /** Set when the group asks for the scan and `scan: false` turns it off. */
  warning: string | null;
  /** The scanner database directory `release.scan.db` names, as written. */
  db?: string;
}

/** Whether a publish scans: `release.scan` first, then the `supply-chain` group. */
export function resolveScan(config: ReleaseScanConfig | undefined, groups: ReadonlySet<SecurityGroup>): ScanSetting {
  if (config === false) {
    return {
      on: false,
      from: "off",
      warning: groups.has("supply-chain") ? "the workspace opts into supply-chain, and release.scan: false publishes without scanning what the targets put out for known vulnerabilities" : null,
    };
  }
  const db = typeof config === "object" && config.db ? { db: config.db } : {};
  if (config !== undefined) return { on: true, from: "config", warning: null, ...db };
  return groups.has("supply-chain") ? { on: true, from: "supply-chain", warning: null } : { on: false, from: "off", warning: null };
}

/**
 * One thing a target would put out, as the scan sees it: an OCI archive,
 * scanned through an SBOM of its layers, or an SBOM the target attaches or a
 * package carries.
 */
export interface ScanSubject {
  /** The target it belongs to, for messages. */
  target: string;
  /** What it is, such as `ghcr.io/acme/api@sha256:...` or `sbom.spdx.json of @acme/core@1.4.0`. */
  name: string;
  /** The OCI archive (a layout directory or a tar file of one) whose layers are scanned. */
  image?: string;
  /** The SBOM scanned. */
  sbom?: SbomDocument;
  /** The digest of what it describes, when known. */
  digest?: string;
}

/**
 * What scans (#5446). The default runs syft and grype or trivy
 * ({@link toolReleaseScanner}); tests pass a fake through
 * `PublishDeps.releaseScanner`.
 */
export interface ReleaseScanner {
  /** For messages, such as `grype v0.121.1`. */
  readonly name: string;
  /** Null when the scanner (and syft, when `images`) can run, else why not. */
  unavailable(opts: { images: boolean }): string | null;
  /** An SBOM of the image in `archive`, made from its layers. */
  imageSbom(archive: string): Promise<SbomDocument>;
  /** Every known vulnerability `sbom` lists. */
  scan(sbom: SbomDocument): Promise<VulnFinding[]>;
}

/** What the publish scans with: the scanner, the gate's policy and the VEX documents it applies. */
export interface ScanContext {
  scanner: ReleaseScanner;
  policy: Partial<VulnPolicy>;
  /** The VEX documents `vulnPolicy.vexSources` names, read. */
  vex: string[];
}

/** What the scan of one subject found. */
export interface SubjectScan {
  target: string;
  name: string;
  digest?: string;
  /** How many packages the SBOM lists, when known. */
  packages?: number;
  findings: VulnFinding[];
  blocking: BlockingFinding[];
  warnings: VulnFinding[];
  suppressed: SuppressedFinding[];
}

/** What the scan before the stage found. */
export interface ScanReport {
  scanner: string;
  subjects: SubjectScan[];
}

/** `vulnPolicy.scanner`'s default. */
export const DEFAULT_RELEASE_SCANNER: ScannerTool = "grype";

/** The binary a tool runs as: `CHANT_<TOOL>` when set, else the tool's name on `PATH`. */
export function scanToolPath(tool: "grype" | "trivy" | "syft", env: NodeJS.ProcessEnv): string {
  const v = env[`CHANT_${tool.toUpperCase()}`];
  return v && v !== "" ? v : tool;
}

/** The version a tool prints, or why it can't be run. */
function toolVersion(bin: string, tool: string, env: NodeJS.ProcessEnv): { version: string | null; reason: string | null } {
  let out: string;
  try {
    out = execFileSync(bin, tool === "trivy" ? ["--version"] : ["version"], { encoding: "utf-8", env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { version: null, reason: `${bin} is not there: install ${tool} on PATH, or set CHANT_${tool.toUpperCase()} to it` };
    return { version: null, reason: `${bin} ${tool === "trivy" ? "--version" : "version"} failed: ${e.message}` };
  }
  const v = /(?:^|\n)\s*Version:\s*v?(\d+\.\d+\.\d+)/i.exec(out);
  return { version: v ? `v${v[1]}` : null, reason: null };
}

const run = promisify(execFile);

/** The environment a scanner runs with: with `db`, its database there and never updated. */
export function scannerEnv(tool: ScannerTool, env: NodeJS.ProcessEnv, db: string | null): NodeJS.ProcessEnv {
  if (db === null || tool !== "grype") return env;
  return { ...env, GRYPE_DB_CACHE_DIR: db, GRYPE_DB_AUTO_UPDATE: "false", GRYPE_DB_VALIDATE_AGE: "false" };
}

/** The arguments the scanner runs with on an SBOM file. */
export function scannerArgs(tool: ScannerTool, file: string, db: string | null): string[] {
  if (tool === "trivy") return ["sbom", "--quiet", "--format", "json", ...(db !== null ? ["--cache-dir", db, "--skip-db-update"] : []), file];
  return [`sbom:${file}`, "-o", "json"];
}

/** The arguments syft runs with on an OCI archive: a layout directory or a tar file of one. */
export function syftArgs(archive: string, out: string): string[] {
  const source = existsSync(archive) && statSync(archive).isDirectory() ? `oci-dir:${archive}` : `oci-archive:${archive}`;
  return ["scan", source, "-o", `spdx-json=${out}`, "-q"];
}

/**
 * A {@link ReleaseScanner} that runs syft for an image's SBOM and grype or
 * trivy for the findings, with `db` as the scanner's database directory when
 * set. A missing tool is a refusal before anything runs, never an empty scan.
 */
export function toolReleaseScanner(env: NodeJS.ProcessEnv, opts: { tool?: ScannerTool; db?: string | null; redactor?: Redactor } = {}): ReleaseScanner {
  const tool = opts.tool ?? DEFAULT_RELEASE_SCANNER;
  const db = opts.db ?? null;
  const bin = scanToolPath(tool, env);
  const syft = scanToolPath("syft", env);
  let checked: ReturnType<typeof toolVersion> | null = null;
  const check = () => (checked ??= toolVersion(bin, tool, env));
  const tail = (err: unknown) => {
    const e = err as Error & { stderr?: string };
    const t = String(e.stderr ?? e.message).trim().split("\n").filter(Boolean).slice(-3).join("; ");
    return opts.redactor ? opts.redactor.redact(t) : t;
  };
  return {
    get name() {
      return `${tool}${check().version ? ` ${check().version}` : ""}`;
    },
    unavailable({ images }) {
      const own = check().reason;
      if (own) return own;
      if (db !== null && !existsSync(db)) return `release.scan.db names ${db}, which is not there`;
      return images ? toolVersion(syft, "syft", env).reason : null;
    },
    async imageSbom(archive) {
      const dir = mkdtempSync(join(tmpdir(), "chant-scan-"));
      try {
        const out = join(dir, "image.spdx.json");
        try {
          await run(syft, syftArgs(archive, out), { env, maxBuffer: 64 * 1024 * 1024 });
        } catch (err) {
          throw new PublishTargetError("publish-scan-tool-failed", `syft could not read the image in ${archive}: ${tail(err)}`, "Check that the archive is an OCI image layout, as chant release images writes it.");
        }
        const bytes = readFileSync(out, "utf-8");
        let count: number | undefined;
        try {
          const doc = JSON.parse(bytes) as { packages?: unknown[] };
          count = Array.isArray(doc.packages) ? doc.packages.length : undefined;
        } catch {
          throw new PublishTargetError("publish-scan-tool-failed", `syft wrote an SBOM for ${archive} that is not JSON`);
        }
        return { format: "spdx", mediaType: SBOM_MEDIA_TYPES.spdx, bytes, ...(count !== undefined ? { packageCount: count } : {}), generator: "syft" };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async scan(sbom) {
      const dir = mkdtempSync(join(tmpdir(), "chant-scan-"));
      try {
        const file = join(dir, sbom.format === "cyclonedx" ? "sbom.cdx.json" : "sbom.spdx.json");
        writeFileSync(file, sbom.bytes);
        let stdout: string;
        try {
          ({ stdout } = await run(bin, scannerArgs(tool, file, db), { env: scannerEnv(tool, env, db), maxBuffer: 64 * 1024 * 1024 }));
        } catch (err) {
          throw new PublishTargetError("publish-scan-tool-failed", `${tool} could not scan the SBOM: ${tail(err)}`, db === null ? `${tool} downloads its database on first use: let the job reach it, or set release.scan.db to a directory that holds one.` : `Check that ${db} holds a ${tool} database.`);
        }
        return tool === "trivy" ? parseTrivyOutput(stdout) : parseGrypeOutput(stdout);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The SBOM document of `bytes`, an SPDX or CycloneDX JSON file. */
export function sbomDocumentOf(bytes: Uint8Array | string, generator: string): SbomDocument {
  const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf-8");
  let doc: { bomFormat?: unknown; packages?: unknown[]; components?: unknown[] } = {};
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    doc = {};
  }
  const cyclonedx = doc.bomFormat === "CycloneDX";
  const list = cyclonedx ? doc.components : doc.packages;
  return {
    format: cyclonedx ? "cyclonedx" : "spdx",
    mediaType: cyclonedx ? SBOM_MEDIA_TYPES.cyclonedx : SBOM_MEDIA_TYPES.spdx,
    bytes: text,
    ...(Array.isArray(list) ? { packageCount: list.length } : {}),
    generator,
  };
}

/**
 * The VEX documents `sources` names, relative to `cwd`. A file that is not
 * there is refused, since a missing VEX file would block what it was meant
 * to clear without saying why.
 */
export function readVexSources(cwd: string, sources: readonly string[] | undefined): string[] {
  return (sources ?? []).map((s) => {
    const abs = isAbsolute(s) ? s : resolve(cwd, s);
    if (!existsSync(abs)) throw new PublishTargetError("publish-scan-vex-missing", `vulnPolicy.vexSources names ${s}, which is not there`, "Point vexSources at the OpenVEX or CycloneDX files in the member, or remove the entry.");
    return readFileSync(abs, "utf-8");
  });
}

/** One line per blocking finding, for the refusal. */
function blockingLines(subject: SubjectScan): string[] {
  return subject.blocking.map((b) => `${subject.name}: ${b.finding.cveId} (${b.finding.severity}) in ${b.finding.package} ${b.finding.installedVersion}${b.finding.fixedVersion ? `, fixed in ${b.finding.fixedVersion}` : ""} [${b.reason}]`);
}

/** Thrown when the scan blocks the publish: what it found, so a record can keep it. */
export class PublishScanError extends PublishTargetError {
  constructor(
    message: string,
    fix: string,
    readonly report: ScanReport,
  ) {
    super("publish-scan-failed", message, fix);
    this.name = "PublishScanError";
  }
}

/**
 * Scan what `targets` would put out, before any of them stages. Each
 * target's {@link PublishTarget.scanSubjects} names its subjects; an image is
 * scanned through the SBOM `scan.scanner` makes of its layers. Every subject
 * is scanned before the gate decides, so the refusal lists every blocking
 * finding at once. Throws {@link PublishScanError} (`publish-scan-failed`)
 * when the policy blocks one; returns the report otherwise.
 */
export async function scanBeforeStage(req: { targets: readonly PublishTarget[]; ctx: PublishContext; scan: ScanContext; say?: (line: string) => void }): Promise<ScanReport> {
  const { targets, ctx, scan } = req;
  const say = req.say ?? (() => undefined);
  const gate = createVulnGateCapability({ scan: async () => [] });
  const subjects: SubjectScan[] = [];
  for (const target of targets) {
    if (!target.scanSubjects) continue;
    for (const s of await target.scanSubjects(ctx)) {
      const sbom = s.sbom ?? (s.image ? await scan.scanner.imageSbom(s.image) : null);
      if (!sbom) continue;
      const findings = await scan.scanner.scan(sbom);
      const base = { target: s.target, name: s.name, ...(s.digest ? { digest: s.digest } : {}), ...(sbom.packageCount !== undefined ? { packages: sbom.packageCount } : {}), findings };
      try {
        const out = await gate.run({ env: "release", component: s.target } as unknown as Parameters<typeof gate.run>[0], { sbom, findings, vex: scan.vex, policy: scan.policy, ...(s.digest ? { digest: s.digest } : {}) });
        subjects.push({ ...base, blocking: [], warnings: out.warnings, suppressed: out.suppressed });
        say(`  scanned ${s.name}: ${findings.length} finding(s), none blocks${out.warnings.length > 0 ? `; ${out.warnings.length} warning(s)` : ""}`);
      } catch (err) {
        if (!(err instanceof VulnGateFailedError)) throw err;
        subjects.push({ ...base, blocking: err.blocking, warnings: [], suppressed: [] });
        say(`  scanned ${s.name}: ${err.blocking.length} finding(s) block the publish`);
      }
    }
  }
  const report: ScanReport = { scanner: scan.scanner.name, subjects };
  const blocked = subjects.filter((s) => s.blocking.length > 0);
  if (blocked.length > 0) {
    const lines = blocked.flatMap(blockingLines);
    throw new PublishScanError(
      `${scan.scanner.name} found ${lines.length} finding(s) the vulnerability policy blocks, so nothing was staged or pushed:\n    ${lines.join("\n    ")}`,
      "Fix the dependency or the base image and build the release again, or record a VEX statement in a file vulnPolicy.vexSources names when it is not exploitable. vulnPolicy in chant.config.ts sets what blocks.",
      report,
    );
  }
  return report;
}
