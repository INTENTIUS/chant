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
import { cfnLintTarballUrl } from "./versions";

const CFN_LINT_TARBALL_URL = cfnLintTarballUrl();
const PATCHES_DEST_DIR = join(homedir(), ".chant", "cfn-lint-patches");
const PATCHES_TAR_PREFIX = "src/cfnlint/data/schemas/patches/extensions/all/";
const PATCH_FILES = ["manual.json", "smithy.json", "format.json"] as const;

export interface PatchWarning {
  typeName: string;
  patchFile: string;
  error: Error;
}

export interface PatchStats {
  patchesApplied: number;
  resourcesFixed: number;
  warnings: PatchWarning[];
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
  patchesDir: string
): { schemas: Map<string, Buffer>; stats: PatchStats } {
  const stats: PatchStats = { patchesApplied: 0, resourcesFixed: 0, warnings: [] };
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
        stats.warnings.push({
          typeName,
          patchFile: pf,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    if (patched !== data) {
      stats.resourcesFixed++;
    }
    result.set(typeName, patched);
  }

  return { schemas: result, stats };
}

/**
 * Convert CloudFormation type name to cfn-lint patch directory name.
 * AWS::S3::Bucket → aws_s3_bucket
 */
export function typeNameToPatchDir(typeName: string): string {
  return typeName.replaceAll("::", "_").toLowerCase();
}
