/**
 * cfn-lint patch fetcher and applier.
 *
 * Downloads cfn-lint patches from GitHub and applies them to raw schemas
 * before parsing. This enriches the schemas with additional type information,
 * enum values, and constraint fixes.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { rfc6902Apply } from "@intentius/chant/codegen/json-patch";
import { fetchAndExtractTar } from "@intentius/chant/codegen/fetch";
import { cfnLintTarballUrl, PINNED_VERSIONS } from "./versions";

const CFN_LINT_TARBALL_URL = cfnLintTarballUrl();
// Keyed by version: the cache lives for 7 days, so an unkeyed directory would
// keep serving the old release's patches after the pin moves.
const PATCHES_DEST_DIR = join(homedir(), ".chant", `cfn-lint-patches-${PINNED_VERSIONS.cfnLint}`);
const PATCHES_TAR_PREFIX = "src/cfnlint/data/schemas/patches/extensions/all/";
const PATCH_FILES = ["manual.json", "smithy.json", "format.json"] as const;

export interface PatchWarning {
  typeName: string;
  patchFile: string;
  error: Error;
}

/**
 * A patch in the pinned cfn-lint release that is known not to apply to the
 * pinned spec. Its failure is reported as a skip rather than a warning; an
 * entry that applies again, or whose patch file is gone, is reported as
 * retirable so the list cannot go stale.
 */
export interface StalePatch {
  typeName: string;
  patchFile: (typeof PATCH_FILES)[number];
  /** The cfn-lint release the entry was checked against. */
  cfnLint: string;
  reason: string;
}

export const KNOWN_STALE_PATCHES: readonly StalePatch[] = [
  {
    // Adds `format: ipv4-network` to `Cidr`, a constraint only; no generated
    // type changes. Every cfn-lint release from v1.32.4 to v1.51.5 still
    // targets the old name, and v1.52.0 removed the patch tree from cfn-lint
    // (it moved to aws-cloudformation/resource-provider-enhanced-schemas,
    // which has the corrected path but publishes only a rolling `latest`).
    typeName: "AWS::MediaLive::InputSecurityGroup",
    patchFile: "format.json",
    cfnLint: "v1.32.4",
    reason: "the 2026-10-19 spec renamed definition InputWhitelistRuleCidr to InputWhitelistRule (#4144)",
  },
];

export interface PatchSkip {
  stale: StalePatch;
  error: Error;
}

export interface PatchStats {
  patchesApplied: number;
  resourcesFixed: number;
  /** Failures not in `KNOWN_STALE_PATCHES`. */
  warnings: PatchWarning[];
  /** Failures listed in `KNOWN_STALE_PATCHES`. */
  skipped: PatchSkip[];
  /** `KNOWN_STALE_PATCHES` entries that did not fail: applied, or no such schema or patch file. */
  retirable: StalePatch[];
}

/**
 * Fetch cfn-lint patches from GitHub tarball and extract to cache.
 * Returns the path to the extracted patches directory.
 */
export async function fetchCfnLintPatches(force = false): Promise<string> {
  return fetchAndExtractTar(
    { url: CFN_LINT_TARBALL_URL, destDir: PATCHES_DEST_DIR },
    PATCHES_TAR_PREFIX,
    force,
  );
}

/**
 * Apply cfn-lint RFC 6902 patches to raw schema bytes.
 * For each schema, converts type name to directory name and applies
 * manual.json, smithy.json, format.json in order.
 */
export function applyPatches(
  schemas: Map<string, Buffer>,
  patchesDir: string,
  knownStale: readonly StalePatch[] = KNOWN_STALE_PATCHES,
): { schemas: Map<string, Buffer>; stats: PatchStats } {
  const stats: PatchStats = { patchesApplied: 0, resourcesFixed: 0, warnings: [], skipped: [], retirable: [] };
  const staleByKey = new Map(knownStale.map((s) => [`${s.typeName}/${s.patchFile}`, s]));
  const result = new Map<string, Buffer>();

  for (const [typeName, data] of schemas) {
    const dirName = typeNameToPatchDir(typeName);
    const patchPath = join(patchesDir, dirName);

    let patched = data;
    for (const pf of PATCH_FILES) {
      const fullPath = join(patchPath, pf);
      let patchData: Buffer;
      try {
        patchData = readFileSync(fullPath) as unknown as Buffer;
      } catch {
        continue; // Patch file doesn't exist
      }

      try {
        patched = Buffer.from(rfc6902Apply(patched.toString("utf-8"), patchData.toString("utf-8")));
        stats.patchesApplied++;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const stale = staleByKey.get(`${typeName}/${pf}`);
        if (stale) stats.skipped.push({ stale, error });
        else stats.warnings.push({ typeName, patchFile: pf, error });
      }
    }

    if (patched !== data) {
      stats.resourcesFixed++;
    }
    result.set(typeName, patched);
  }

  const skippedStale = new Set(stats.skipped.map((s) => s.stale));
  stats.retirable = knownStale.filter((s) => !skippedStale.has(s));

  return { schemas: result, stats };
}

/**
 * Convert CloudFormation type name to cfn-lint patch directory name.
 * AWS::S3::Bucket → aws_s3_bucket
 */
export function typeNameToPatchDir(typeName: string): string {
  return typeName.replaceAll("::", "_").toLowerCase();
}
