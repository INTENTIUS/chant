/**
 * Validate the Temporal lexicon dist/ artifacts.
 *
 * Since all resources are hand-written, validation checks that
 * the packaging step produced correct dist/ artifacts: manifest.json,
 * meta.json (with the 4 expected resource types), types/index.d.ts,
 * and integrity.json.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface ValidateResult {
  passed: number;
  failed: number;
  errors: string[];
}

const EXPECTED_RESOURCE_TYPES = [
  "TemporalServer",
  "TemporalNamespace",
  "SearchAttribute",
  "TemporalSchedule",
] as const;

export async function validate(opts?: { verbose?: boolean; basePath?: string }): Promise<ValidateResult> {
  const pkgDir = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(pkgDir, "dist");
  const errors: string[] = [];

  // manifest.json
  const manifestPath = join(distDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    errors.push("dist/manifest.json not found — run npm run bundle");
  } else {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      if (m["name"] !== "temporal") errors.push(`manifest.json: expected name "temporal", got ${JSON.stringify(m["name"])}`);
      if (m["namespace"] !== "Temporal") errors.push(`manifest.json: expected namespace "Temporal", got ${JSON.stringify(m["namespace"])}`);
    } catch (err) {
      errors.push(`manifest.json: parse error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // meta.json (lexicon catalog)
  const metaPath = join(distDir, "meta.json");
  if (!existsSync(metaPath)) {
    errors.push("dist/meta.json not found — run npm run bundle");
  } else {
    try {
      const catalog = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
      for (const name of EXPECTED_RESOURCE_TYPES) {
        if (!(name in catalog)) {
          errors.push(`meta.json: missing resource "${name}"`);
        }
      }
    } catch (err) {
      errors.push(`meta.json: parse error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // types/index.d.ts
  const dtsPath = join(distDir, "types", "index.d.ts");
  if (!existsSync(dtsPath)) {
    errors.push("dist/types/index.d.ts not found — run npm run bundle");
  }

  // integrity.json
  const integrityPath = join(distDir, "integrity.json");
  if (!existsSync(integrityPath)) {
    errors.push("dist/integrity.json not found — run npm run bundle");
  }

  const result: ValidateResult = {
    passed: 4 - errors.length < 0 ? 0 : 4 - errors.length,
    failed: errors.length,
    errors,
  };

  if (opts?.verbose) {
    if (errors.length === 0) {
      console.error(`Validation passed: all dist/ artifacts present and valid`);
    } else {
      for (const err of errors) {
        console.error(`  ✗ ${err}`);
      }
    }
  }

  return result;
}
