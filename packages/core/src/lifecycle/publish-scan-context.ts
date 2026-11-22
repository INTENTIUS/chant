/**
 * What the scan before the stage scans with (#5446), for the publish and for
 * the cut that runs the same scan before the tag: whether it scans
 * (`release.scan`, else the `supply-chain` group), the scanner (grype or
 * trivy, wrapped by the Wiz image scanner when `release.scan.imageScanner`
 * asks), the project's `vulnPolicy` and VEX files, and the oldest database
 * it takes (`release.scan.dbMaxAgeHours`, or a security profile's bound).
 * One function makes it, so the cut and the publish can't scan differently.
 */

import { resolve } from "node:path";
import type { ChantConfig } from "../config";
import type { SecurityGroup } from "../workspace/security";
import { createRedactor } from "./publish-credentials";
import type { ReleaseScanner, ScanContext } from "./publish-scan";
import { PublishTargetError, type PublishTarget } from "./release-publish";

/** Why a scan can't start, with the code the publish refuses with. */
export interface ScanContextRefusal {
  code: "publish-scan-tool-missing" | "publish-scan-vex-missing";
  message: string;
  fix?: string;
}

/** The fix `publish-scan-tool-missing` prints. */
export const SCAN_TOOL_MISSING_FIX =
  "Install grype (or trivy) and syft in the job, as chant release workflow does, or point CHANT_GRYPE, CHANT_TRIVY and CHANT_SYFT at them; with imageScanner wiz, set WIZ_CLIENT_ID and WIZ_CLIENT_SECRET and put wizcli on PATH; or set release.scan: false.";

/**
 * The scan context for `targets`, or null when nothing is scanned: the scan
 * is off, or no target has anything to scan. A refusal when the scanner (or
 * syft, for an `oci` target) can't run, or a VEX file `vulnPolicy.vexSources`
 * names is not there. `warning` is set when the `supply-chain` group asks for
 * the scan and `release.scan: false` turns it off.
 *
 * `name` is what the refusal says would be scanned, such as the release's
 * label. `scanner` replaces the default, as tests pass a fake.
 */
export async function resolveScanContext(req: {
  cwd: string;
  name: string;
  targets: readonly PublishTarget[];
  config: ChantConfig | null | undefined;
  groups: ReadonlySet<SecurityGroup>;
  declaration: { security?: readonly string[] } | null | undefined;
  env: NodeJS.ProcessEnv;
  scanner?: ReleaseScanner;
}): Promise<{ scan: ScanContext | null; warning: string | null } | { refusal: ScanContextRefusal }> {
  const { resolveScan, toolReleaseScanner, readVexSources } = await import("./publish-scan");
  const config = req.config ?? undefined;
  const setting = resolveScan(config?.release?.scan, req.groups);
  const scanned = req.targets.filter((t) => t.scanSubjects);
  if (!setting.on || scanned.length === 0) return { scan: null, warning: setting.warning };
  const why = setting.from === "config" ? "release.scan in chant.config.ts" : "the supply-chain group";
  const db = setting.db ? resolve(req.cwd, setting.db) : null;
  const { withImageScanner } = await import("./publish-scan-wiz");
  const redactor = createRedactor(req.env);
  const scanner = req.scanner ?? withImageScanner(setting, req.env, toolReleaseScanner(req.env, { tool: config?.vulnPolicy?.scanner ?? "grype", db, redactor }), { redactor });
  const missing = scanner.unavailable({ images: scanned.some((t) => t.kind === "oci") });
  if (missing) {
    return { refusal: { code: "publish-scan-tool-missing", message: `${req.name} would be scanned for known vulnerabilities before anything is pushed, as ${why} asks, and ${missing}`, fix: SCAN_TOOL_MISSING_FIX } };
  }
  let vex: string[];
  try {
    vex = readVexSources(req.cwd, config?.vulnPolicy?.vexSources);
  } catch (err) {
    if (!(err instanceof PublishTargetError)) throw err;
    return { refusal: { code: "publish-scan-vex-missing", message: err.message, ...(err.fix ? { fix: err.fix } : {}) } };
  }
  const { resolveVulnPolicy } = await import("../config");
  // #5464: the oldest database the scan takes, from release.scan.dbMaxAgeHours or a security profile.
  const { profilesOf, scanDatabaseBound } = await import("../workspace/security-profiles");
  const scanConfig = config?.release?.scan;
  const dbAge = scanDatabaseBound(typeof scanConfig === "object" ? scanConfig.dbMaxAgeHours : undefined, profilesOf(req.declaration));
  return { scan: { scanner, policy: config ? resolveVulnPolicy(config) : {}, vex, ...(dbAge ? { dbAge } : {}) }, warning: setting.warning };
}
