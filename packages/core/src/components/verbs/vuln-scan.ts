/**
 * Vulnerability scanning of an already-generated SBOM (#626, epic #551
 * supply-chain follow-up to the SBOM stack #606/#613/#614/#609/#610). An SBOM
 * says *what's in* an artifact; a scanner says *which of those have known
 * CVEs*. This module produces findings; ./vex.ts suppresses the ones that
 * don't matter and ./vuln-gate.ts fails the deploy on the ones that do.
 *
 * Prefer scanning the **SBOM** (already generated + persisted, keyed by
 * digest) over re-scanning the image: deterministic (same SBOM -> same
 * findings), fast, and reuses work already done. Real backends shell out to
 * `grype`/`trivy` through the injectable `ProcessRunner` (./process-runner.ts),
 * exactly like ./tool-sbom-generator.ts's deep-scan backend — tests inject an
 * inline fake `VulnScanner` (an object literal with a canned `scan()`, see
 * ./vuln-gate.test.ts) and never invoke a real scanner, network, or vuln DB.
 * The scanner's vuln DB currency is the tool's job, not chant's.
 *
 * `createDatabaseVulnScanner` (ws-056, INTENTIUS/chant#2735) is the one
 * hermetic exception: a `VulnScanner` matched against a local, offline
 * advisory-database file instead of a real scanner binary — no `grype`/
 * `trivy` required, deterministic, at the cost of covering only the
 * advisories the database names. Ported from chud's `supply-chain.mjs`
 * (`scanWithDatabase`/`sbomPackages`/`compareVersions`), which built its own
 * copy of this because `scan-vulnerabilities` had no offline backend.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Capability } from "../capability";
import type { SbomDocument } from "./sbom-generator";
import { defaultProcessRunner, q, requireTool, ToolNotAvailableError, type ProcessRunner } from "./process-runner";

// ── findings ─────────────────────────────────────────────────────────────────

/** CVE severity, highest to lowest. `unknown` sorts lowest so it never trips a threshold gate by accident. */
export type Severity = "critical" | "high" | "medium" | "low" | "negligible" | "unknown";

/** Severity rank (higher = more severe) so a gate can ask "severity >= critical". */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  negligible: 1,
  unknown: 0,
};

/** Normalize a scanner's free-form severity string ("High", "CRITICAL", "Negligible", …) to a `Severity`. Unrecognized -> `unknown`. */
export function normalizeSeverity(raw: string | undefined): Severity {
  const s = (raw ?? "").toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low" || s === "negligible") return s;
  return "unknown";
}

/** One known vulnerability affecting one package in the scanned artifact. */
export interface VulnFinding {
  /** Advisory id, e.g. `"CVE-2024-12345"` or `"GHSA-…"` — the join key with VEX statements (./vex.ts). */
  cveId: string;
  severity: Severity;
  /** Affected package name. */
  package: string;
  installedVersion: string;
  /** First version that fixes it, when the scanner reports one. */
  fixedVersion?: string;
  /** True when a fix exists (upgradeable) — the beginner-safe default gate blocks only fixable findings, since an unfixable one can't be actioned by bumping. */
  fixable: boolean;
  /** EPSS score (0.0–1.0): probability of exploitation in the next 30 days. Absent when the scanner did not report one. */
  epss?: number;
  /** EPSS percentile (0.0–1.0) — rank against all scored CVEs. */
  epssPercentile?: number;
  /** Present in CISA's Known Exploited Vulnerabilities catalog. `undefined` means the scanner did not report KEV membership at all — NOT the same conclusion as a reported `false`. Never default this. */
  inKev?: boolean;
  /** When the CVE entered the KEV catalog (ISO date, as the source reports it). */
  kevDateAdded?: string;
  /** KEV remediation due date (ISO date). */
  kevDueDate?: string;
  /** Known use in a ransomware campaign, per KEV. */
  kevRansomware?: boolean;
}

// ── injectable scanner boundary ──────────────────────────────────────────────

export interface ScanInput {
  /** The SBOM to scan (the artifact's already-generated SPDX/CycloneDX doc). */
  sbom: SbomDocument;
  /** Artifact digest the SBOM belongs to — informational, for logging/keying. */
  digest?: string;
}

/**
 * Injectable vulnerability-scan boundary — the scan-side analogue of
 * `SbomGenerator` (./sbom-generator.ts) and `CloudExecutor`
 * (./cloud-executor.ts). A real implementation shells out to `grype`/`trivy`;
 * tests substitute an inline fake (an object literal with a canned `scan()`)
 * and never touch a real tool, network, or vuln DB.
 */
export interface VulnScanner {
  /** Scan an SBOM, returning every known vulnerability it surfaces. */
  scan(input: ScanInput): Promise<VulnFinding[]>;
}

/** Which real CLI scanner a `ProcessRunner`-backed scanner shells out to. */
export type ScannerTool = "grype" | "trivy";

/** grype `-o json` output shape (the subset we read). `epss` and `knownExploited` are omitted (not empty) for a vuln grype has no data on, so absence maps to `undefined`, never `false`/`0`. grype's composite `risk` score is deliberately not read — policy gates on the inputs (EPSS, KEV), not one tool's weighting of them. */
interface GrypeOutput {
  matches?: Array<{
    vulnerability?: {
      id?: string;
      severity?: string;
      fix?: { versions?: string[]; state?: string };
      epss?: Array<{ cve?: string; epss?: number; percentile?: number; date?: string }>;
      knownExploited?: Array<{
        cve?: string;
        dateAdded?: string;
        dueDate?: string;
        knownRansomwareCampaignUse?: string;
      }>;
    };
    artifact?: { name?: string; version?: string };
  }>;
}

/** trivy `--format json` output shape (the subset we read). Trivy (v0.73, __fixtures__/trivy-with-kev-epss.json) reports no KEV/EPSS data in its JSON output, so a trivy-backed finding carries every exploitability field as `undefined` — the honest "not reported" state, not `false`. */
interface TrivyOutput {
  Results?: Array<{
    Vulnerabilities?: Array<{
      VulnerabilityID?: string;
      Severity?: string;
      PkgName?: string;
      InstalledVersion?: string;
      FixedVersion?: string;
    }>;
  }>;
}

/** Parse `grype -o json` stdout into findings. Exported for tests to assert parsing without a live tool. */
export function parseGrypeOutput(stdout: string): VulnFinding[] {
  const doc = JSON.parse(stdout) as GrypeOutput;
  return (doc.matches ?? []).map((m) => {
    const fixVersions = m.vulnerability?.fix?.versions ?? [];
    const epss = m.vulnerability?.epss?.[0];
    const kev = m.vulnerability?.knownExploited?.[0];
    return {
      cveId: m.vulnerability?.id ?? "UNKNOWN",
      severity: normalizeSeverity(m.vulnerability?.severity),
      package: m.artifact?.name ?? "unknown",
      installedVersion: m.artifact?.version ?? "",
      fixedVersion: fixVersions[0],
      fixable: m.vulnerability?.fix?.state === "fixed" || fixVersions.length > 0,
      epss: epss?.epss,
      epssPercentile: epss?.percentile,
      // grype omits `knownExploited` for a non-KEV vuln, so `undefined` here
      // means "no KEV annotation reported" — never coerced to `false`.
      inKev: kev ? true : undefined,
      kevDateAdded: kev?.dateAdded,
      kevDueDate: kev?.dueDate,
      // KEV's ransomware field is "known"/"unknown" — "unknown" is not "no",
      // so only an explicit "known" becomes `true`; everything else stays unset.
      kevRansomware: kev?.knownRansomwareCampaignUse?.toLowerCase() === "known" ? true : undefined,
    } satisfies VulnFinding;
  });
}

/** Parse `trivy sbom --format json` stdout into findings. */
export function parseTrivyOutput(stdout: string): VulnFinding[] {
  const doc = JSON.parse(stdout) as TrivyOutput;
  const out: VulnFinding[] = [];
  for (const r of doc.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      out.push({
        cveId: v.VulnerabilityID ?? "UNKNOWN",
        severity: normalizeSeverity(v.Severity),
        package: v.PkgName ?? "unknown",
        installedVersion: v.InstalledVersion ?? "",
        fixedVersion: v.FixedVersion || undefined,
        fixable: Boolean(v.FixedVersion),
      });
    }
  }
  return out;
}

// ── offline advisory database ────────────────────────────────────────────────

/** One package an SBOM names, by purl: the ecosystem, its name and its installed version. */
export interface SbomPackage {
  ecosystem: string;
  name: string;
  version: string;
}

/**
 * The packages an SPDX or CycloneDX document lists, by purl (SPDX's
 * `externalRefs` with `referenceType: "purl"`, CycloneDX's `components[].purl`),
 * deduplicated by ecosystem/name/version. Parses `doc.bytes` (a string, as
 * every `SbomDocument` carries it) rather than requiring a pre-parsed object,
 * so a caller can pass a `scan-vulnerabilities` input's `sbom` straight
 * through.
 */
export function sbomPackages(doc: Pick<SbomDocument, "bytes">): SbomPackage[] {
  const parsed = JSON.parse(doc.bytes) as {
    packages?: Array<{ externalRefs?: Array<{ referenceType?: string; referenceLocator?: string }> }>;
    components?: Array<{ purl?: string }>;
  };
  const purls = [
    ...(parsed.packages ?? []).flatMap((p) =>
      (p.externalRefs ?? []).filter((r) => r.referenceType === "purl").map((r) => r.referenceLocator ?? ""),
    ),
    ...(parsed.components ?? []).map((c) => c.purl).filter((p): p is string => Boolean(p)),
  ];
  const seen = new Map<string, SbomPackage>();
  for (const purl of purls) {
    const m = /^pkg:([^/]+)\/(.+)@([^?#]+)/.exec(purl);
    if (!m) continue;
    const pkg: SbomPackage = { ecosystem: m[1], name: decodeURIComponent(m[2]), version: decodeURIComponent(m[3]) };
    seen.set(`${pkg.ecosystem}:${pkg.name}@${pkg.version}`, pkg);
  }
  return [...seen.values()];
}

/**
 * Compare two dotted version strings numerically, a pre-release sorting
 * before its release (`1.2.0-rc.1` < `1.2.0`). Not full semver (no build
 * metadata, no ordering between differing pre-release labels beyond "a
 * pre-release exists") — just enough to place an installed version between
 * an advisory's `introduced` and `fixed`.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => {
    const [core, pre] = String(v).replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d) as -1 | 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  if (x.pre === y.pre) return 0;
  return x.pre! < y.pre! ? -1 : 1;
}

/** One advisory in a local, offline advisory database (`AdvisoryDatabase.advisories`). */
export interface Advisory {
  /** Advisory id, e.g. `"CVE-2024-12345"` or `"GHSA-…"`. */
  id: string;
  /** Ecosystem the advisory applies to (npm, pypi, …). Default: `"npm"`. */
  ecosystem?: string;
  /** Affected package name, matched against the SBOM's purl-derived package name. */
  package: string;
  severity?: string;
  /** First affected version. Default: `"0"` (affects every version up to `fixed`). */
  introduced?: string;
  /** First version that fixes it. Omitted for a vulnerability with no fix yet. */
  fixed?: string;
  summary?: string;
}

/** A local, offline advisory database: `{ "advisories": [...] }` (or a bare array, for convenience). */
export interface AdvisoryDatabase {
  advisories: Advisory[];
}

/**
 * Match an SBOM's packages against a local, offline advisory database —
 * no scanner binary, no network, deterministic. A package is affected when
 * `introduced <= installedVersion < fixed` (or unconditionally affected when
 * the advisory names no `fixed`). Findings are `VulnFinding`-shaped, so they
 * feed `vuln-gate` exactly like `grype`/`trivy` output does; every
 * exploitability field (`epss`, `inKev`, …) an offline database can't supply
 * is left `undefined`, never defaulted to a false negative.
 */
export function scanWithDatabase(doc: Pick<SbomDocument, "bytes">, db: AdvisoryDatabase | Advisory[]): VulnFinding[] {
  const advisories = Array.isArray(db) ? db : (db.advisories ?? []);
  const findings: VulnFinding[] = [];
  for (const pkg of sbomPackages(doc)) {
    for (const a of advisories) {
      if ((a.ecosystem ?? "npm") !== pkg.ecosystem || a.package !== pkg.name) continue;
      if (compareVersions(pkg.version, a.introduced ?? "0") < 0) continue;
      if (a.fixed && compareVersions(pkg.version, a.fixed) >= 0) continue;
      findings.push({
        cveId: a.id,
        severity: normalizeSeverity(a.severity),
        package: pkg.name,
        installedVersion: pkg.version,
        ...(a.fixed ? { fixedVersion: a.fixed } : {}),
        fixable: Boolean(a.fixed),
      });
    }
  }
  return findings;
}

/**
 * A `VulnScanner` backed by a local, offline advisory database file (JSON:
 * `{ "advisories": [...] }`, see `AdvisoryDatabase`) instead of a real
 * scanner binary — the hermetic fallback `autoDetectVulnScanner`'s doc
 * comment says a scan doesn't have ("there is no hermetic fallback, a scan
 * needs a real vuln DB"): deterministic, offline, no `grype`/`trivy`
 * install required, at the cost of covering only the advisories the
 * database names. Reads the file once per call (a database pinned in the
 * repo changes rarely; callers that scan repeatedly should cache the parsed
 * `AdvisoryDatabase` and call `scanWithDatabase` directly instead).
 */
export function createDatabaseVulnScanner(dbFile: string): VulnScanner {
  return {
    async scan(input) {
      const db = JSON.parse(readFileSync(dbFile, "utf8")) as AdvisoryDatabase | Advisory[];
      return scanWithDatabase(input.sbom, db);
    },
  };
}

/**
 * A real `VulnScanner` that writes the SBOM to a temp file and scans it with
 * `grype` (default) or `trivy`, through the injectable `ProcessRunner`.
 * `requireTool` throws `ToolNotAvailableError` if the scanner is absent — a
 * missing scanner is a hard stop (like ./verify.ts's missing `cosign`), never
 * a silent "no vulns found," because that would let an unscanned artifact
 * through a gate. Never used in tests.
 */
export function createToolVulnScanner(
  tool: ScannerTool = "grype",
  processRunner: ProcessRunner = defaultProcessRunner(),
): VulnScanner {
  return {
    async scan(input) {
      await requireTool(processRunner, tool, `scan the SBOM for known vulnerabilities`);
      // Content-address the temp file so concurrent scans never collide and we
      // avoid Date.now()/Math.random() (blocked in some chant runtimes).
      const hash = createHash("sha256").update(input.sbom.bytes).digest("hex").slice(0, 16);
      const ext = input.sbom.format === "cyclonedx" ? "cdx.json" : "spdx.json";
      const path = join(tmpdir(), `chant-scan-${hash}.${ext}`);
      writeFileSync(path, input.sbom.bytes);
      if (tool === "trivy") {
        const { stdout } = await processRunner.run(`trivy sbom --quiet --format json ${q(path)}`);
        return parseTrivyOutput(stdout);
      }
      const { stdout } = await processRunner.run(`grype sbom:${q(path)} -o json`);
      return parseGrypeOutput(stdout);
    },
  };
}

/**
 * Thrown by `notImplementedVulnScanner` — the "no real scanner wired yet"
 * signal, mirroring `SbomGeneratorNotImplementedError` (./sbom-generator.ts).
 * The default is loud-and-specific rather than a silent empty scan, so a
 * caller that forgets to inject a scanner (or a mock in tests) fails obviously
 * instead of appearing to find zero vulnerabilities.
 */
export class VulnScannerNotImplementedError extends Error {
  constructor() {
    super(
      `VulnScanner has no real scanner configured — inject a real scanner ` +
        `(createToolVulnScanner("grype"|"trivy")) or a mock in tests`,
    );
    this.name = "VulnScannerNotImplementedError";
  }
}

/** Kept for tests and for a caller that wants the old loud "no scanner wired" behavior; no longer the registered default (#634). */
export const notImplementedVulnScanner: VulnScanner = {
  async scan() {
    throw new VulnScannerNotImplementedError();
  },
};

/**
 * A `VulnScanner` that picks a real backend at scan time — `grype` if present,
 * else `trivy`. Unlike SBOM generation there is no hermetic fallback (a scan
 * needs a real vuln DB), so when neither tool is on `PATH` this throws a
 * `ToolNotAvailableError` naming what to install — an error a config-only user
 * can act on — rather than `VulnScannerNotImplementedError`, which told them to
 * edit code. This is the vuln-side analog of #630's hermetic-by-default SBOM
 * generator: the registered `scan-vulnerabilities`/`vuln-gate` capabilities now
 * work the moment a scanner is installed, with no code wiring.
 */
export function autoDetectVulnScanner(processRunner: ProcessRunner = defaultProcessRunner()): VulnScanner {
  return {
    async scan(input) {
      const tool: ScannerTool | undefined = (await processRunner.available("grype"))
        ? "grype"
        : (await processRunner.available("trivy"))
          ? "trivy"
          : undefined;
      if (!tool) {
        throw new ToolNotAvailableError("grype or trivy", "scan the SBOM for known vulnerabilities");
      }
      return createToolVulnScanner(tool, processRunner).scan(input);
    },
  };
}

let defaultScanner: VulnScanner | undefined;

/** The default `VulnScanner` the `scan-vulnerabilities`/`vuln-gate` capabilities fall back to when none is supplied: auto-detects `grype`/`trivy` and throws `ToolNotAvailableError` if neither is installed (#634). */
export function defaultVulnScanner(): VulnScanner {
  if (!defaultScanner) defaultScanner = autoDetectVulnScanner();
  return defaultScanner;
}

// ── scan-vulnerabilities capability ──────────────────────────────────────────

export interface ScanVulnerabilitiesInput {
  /** The SBOM to scan. */
  sbom: SbomDocument;
  /** Artifact digest the SBOM belongs to (recorded on the output). */
  digest?: string;
}

export interface ScanVulnerabilitiesOutput {
  findings: VulnFinding[];
  /** Echoed back so a downstream `vuln-gate` step can key results to the artifact. */
  digest?: string;
}

/**
 * `scan-vulnerabilities` capability — scan an SBOM for known CVEs via the
 * injectable `VulnScanner`. Produces findings only; suppression (VEX) and the
 * pass/fail decision live in ./vuln-gate.ts, so a composition can scan once
 * and reuse the findings, or run the gate directly (which scans for you).
 */
export function createScanVulnerabilitiesCapability(
  scanner: VulnScanner = defaultVulnScanner(),
): Capability<ScanVulnerabilitiesInput, ScanVulnerabilitiesOutput> {
  return {
    kind: "scan-vulnerabilities",
    async run(_ctx, input) {
      const findings = await scanner.scan({ sbom: input.sbom, digest: input.digest });
      return { findings, digest: input.digest };
    },
  };
}

/** Default `scan-vulnerabilities` capability, backed by the not-implemented scanner (inject a real/mock one). */
export const scanVulnerabilitiesCapability: Capability<ScanVulnerabilitiesInput, ScanVulnerabilitiesOutput> =
  createScanVulnerabilitiesCapability();
