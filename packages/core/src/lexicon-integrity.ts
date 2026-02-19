/**
 * Content hashing and integrity verification for lexicon artifacts.
 */
import type { BundleSpec } from "./lexicon";

export interface ArtifactIntegrity {
  algorithm: "xxhash64";
  artifacts: Record<string, string>;
  composite: string;
}

/**
 * Hash a single artifact's content using xxhash64.
 */
export function hashArtifact(content: string): string {
  return Bun.hash(content).toString(16);
}

/**
 * Compute integrity for all artifacts in a BundleSpec.
 */
export function computeIntegrity(spec: BundleSpec): ArtifactIntegrity {
  const artifacts: Record<string, string> = {};

  // Hash each artifact
  artifacts["manifest.json"] = hashArtifact(JSON.stringify(spec.manifest, null, 2));
  artifacts["meta.json"] = hashArtifact(spec.registry);
  artifacts["types/index.d.ts"] = hashArtifact(spec.typesDTS);

  for (const [name, content] of spec.rules) {
    artifacts[`rules/${name}`] = hashArtifact(content);
  }
  for (const [name, content] of spec.skills) {
    artifacts[`skills/${name}`] = hashArtifact(content);
  }

  // Composite hash: sorted key:hash pairs
  const sorted = Object.entries(artifacts).sort(([a], [b]) => a.localeCompare(b));
  const compositeInput = sorted.map(([k, v]) => `${k}:${v}`).join("\n");
  const composite = hashArtifact(compositeInput);

  return { algorithm: "xxhash64", artifacts, composite };
}

/**
 * Verify integrity of a BundleSpec against expected hashes.
 */
export function verifyIntegrity(
  spec: BundleSpec,
  expected: ArtifactIntegrity,
): { ok: boolean; mismatches: string[] } {
  const actual = computeIntegrity(spec);
  const mismatches: string[] = [];

  for (const [key, expectedHash] of Object.entries(expected.artifacts)) {
    if (actual.artifacts[key] !== expectedHash) {
      mismatches.push(key);
    }
  }

  // Check for artifacts in actual but not in expected
  for (const key of Object.keys(actual.artifacts)) {
    if (!(key in expected.artifacts)) {
      mismatches.push(key);
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}
