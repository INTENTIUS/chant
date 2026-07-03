/**
 * Hermetic lockfile/manifest-derived `SbomGenerator` (#613, epic #551 closes
 * the "HERMETIC-generator half of #610" per #613's scope note). Pure
 * TypeScript: reads a declared-dependency manifest already on disk (Node
 * `package-lock.json`, JVM `pom.xml`) and emits a real SPDX/CycloneDX
 * document via ./bom-writer.ts. No `syft`, no `docker buildx`, no
 * `cyclonedx-maven`, no network — every package in the resulting BOM comes
 * from parsing bytes chant already has locally.
 *
 * **What this backend is, and isn't.** A lockfile enumerates every declared
 * (transitive-resolved) dependency at the versions actually installed, so
 * the resulting SBOM is complete for **declared** dependencies — accurate
 * package identity and version for everything npm/Maven resolved. It is
 * **not** a container-layer scan: it cannot see OS packages baked into a base
 * image, binaries copied in by a Dockerfile `COPY`/`RUN`, or anything not
 * expressed as a lockfile entry. That deeper, image-layer-aware scan is
 * `syft`'s job (or BuildKit's native `--sbom` attestation) and stays exactly
 * where #610 already scoped it: the optional *deep* path, layered on top of
 * (never replacing) this hermetic baseline. See
 * docs/components/build-archive.mdx's SBOM section, updated alongside this
 * change, for the customer-facing version of this distinction.
 *
 * Registered as `forDir`/`forZip`/`forJar` implementations (the artifact
 * shapes a source-tree or packaged-but-uninspected artifact naturally maps
 * to); `forImage` still throws `SbomGeneratorNotImplementedError` — an image
 * SBOM needs either BuildKit's attestation or a container-layer scan, neither
 * of which a lockfile read can substitute for, so this backend deliberately
 * does not claim to cover it (mirrors how ./sbom-generator.ts's own
 * `notImplementedSbomGenerator` prefers a loud, specific failure over a
 * silently wrong answer).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeBom, type BomPackage } from "./bom-writer";
import { DEFAULT_SBOM_FORMAT } from "./sbom-generator";
import type {
  GenerateDirSbomInput,
  GenerateImageSbomInput,
  GenerateJarSbomInput,
  GenerateZipSbomInput,
  SbomDocument,
  SbomGenerator,
} from "./sbom-generator";
import { SbomGeneratorNotImplementedError } from "./sbom-generator";

// ── package-lock.json (npm, lockfile v2/v3) ─────────────────────────────────

/** Shape of the subset of `package-lock.json` this parser reads (lockfile v2/v3 — npm >= 7). */
interface NpmPackageLock {
  name?: string;
  version?: string;
  /** Lockfile v2/v3: every resolved package, keyed by its node_modules path (""=root). */
  packages?: Record<string, { name?: string; version?: string; resolved?: string; dev?: boolean; dependencies?: Record<string, string> }>;
  /** Lockfile v1 fallback: nested `dependencies` tree keyed by package name. */
  dependencies?: Record<string, { version?: string; resolved?: string; dev?: boolean; requires?: Record<string, string> }>;
}

/**
 * Parse a `package-lock.json` (v1, v2, or v3) into a flat `BomPackage[]`.
 * Prefers the v2/v3 `packages` map (flat, one entry per resolved install
 * location) since that's what `npm` >= 7 writes; falls back to the v1
 * `dependencies` tree for older lockfiles. De-duplicates by `name@version`
 * so a package appearing at multiple install paths (npm's dedup/hoisting)
 * contributes one BOM entry, matching how a real scanner reports installed
 * packages rather than filesystem paths.
 */
export function parseNpmPackageLock(content: string): BomPackage[] {
  const lock: NpmPackageLock = JSON.parse(content);
  const seen = new Map<string, BomPackage>();

  const add = (name: string, version: string | undefined, deps?: string[]) => {
    if (!name) return;
    const key = `${name}@${version ?? ""}`;
    const existing = seen.get(key);
    if (existing) {
      if (deps?.length) existing.dependsOn = [...new Set([...(existing.dependsOn ?? []), ...deps])];
      return;
    }
    seen.set(key, {
      name,
      version,
      type: "npm",
      purl: version ? `pkg:npm/${encodeURIComponent(name)}@${version}` : undefined,
      dependsOn: deps?.length ? deps : undefined,
    });
  };

  if (lock.packages) {
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (path === "") continue; // the root project itself, not a dependency
      const name = pkg.name ?? path.replace(/^.*node_modules\//, "");
      add(name, pkg.version, pkg.dependencies ? Object.keys(pkg.dependencies) : undefined);
    }
  } else if (lock.dependencies) {
    for (const [name, pkg] of Object.entries(lock.dependencies)) {
      add(name, pkg.version, pkg.requires ? Object.keys(pkg.requires) : undefined);
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── pom.xml (Maven — cheap, declared <dependencies> only) ───────────────────

/**
 * Parse the `<dependencies>` block of a `pom.xml` into a flat `BomPackage[]`.
 * Deliberately minimal (#613 calls this out as "add JVM pom.xml if cheap"):
 * a small tag-scoped regex walk over `<dependency>...</dependency>` blocks
 * extracting `groupId`/`artifactId`/`version`, no XML DOM dependency, no
 * property (`${...}`) resolution, no transitive resolution (Maven's own
 * dependency-mediation graph isn't reproducible without invoking `mvn`,
 * which would break the hermetic requirement). This is deliberately narrower
 * than the npm parser above: it covers the common case (a flat, literal
 * `<dependencies>` list) and documents its own limits rather than silently
 * mis-resolving a `${property}` version or a `<dependencyManagement>`
 * inheritance chain.
 */
export function parsePomXml(content: string): BomPackage[] {
  const packages: BomPackage[] = [];
  // Strip <dependencyManagement>...</dependencyManagement> first — it
  // declares version *policy*, not necessarily artifacts actually used, and
  // (like the real <dependencies> block) can itself contain a nested
  // <dependencies> block, which a naive non-nesting-aware regex would match
  // in its place. Removing it up front guarantees the subsequent
  // <dependencies> match is the real, top-level one.
  const withoutManagement = content.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, "");
  const depsBlockMatch = withoutManagement.match(/<dependencies>([\s\S]*?)<\/dependencies>/);
  if (!depsBlockMatch) return packages;

  const depBlock = depsBlockMatch[1]!;
  const depRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match: RegExpExecArray | null;
  while ((match = depRegex.exec(depBlock)) !== null) {
    const entry = match[1]!;
    const groupId = entry.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
    const artifactId = entry.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    const version = entry.match(/<version>([^<]+)<\/version>/)?.[1]?.trim();
    if (!groupId || !artifactId) continue;
    const name = `${groupId}:${artifactId}`;
    packages.push({
      name,
      version,
      type: "maven",
      purl: version ? `pkg:maven/${encodeURIComponent(groupId)}/${encodeURIComponent(artifactId)}@${version}` : undefined,
    });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

// ── hermetic SbomGenerator backend ───────────────────────────────────────────

export interface LockfileSbomGeneratorOptions {
  /** Where generated SBOM documents are written on disk, as a sibling of the scanned path (see `sbomOutputPath`). Default: alongside the scanned manifest, named `sbom.<format>.json`. */
  outDir?: string;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

/** Locate the first readable lockfile/manifest under `dir` this generator knows how to parse, in preference order (npm before Maven — most chant components are Node-first). Returns `undefined` if none is found. */
function findManifest(dir: string): { kind: "npm" | "maven"; path: string } | undefined {
  for (const [kind, filename] of [["npm", "package-lock.json"], ["maven", "pom.xml"]] as const) {
    const candidate = join(dir, filename);
    try {
      readFileSync(candidate, "utf-8");
      return { kind, path: candidate };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Default on-disk path for a generated SBOM: `<dir>/sbom.<format>.json`, matching #613's `sbom.<format>.json` naming convention. */
export function sbomOutputPath(dir: string, format: string): string {
  return join(dir, `sbom.${format}.json`);
}

/**
 * Build a hermetic `SbomGenerator` backed by lockfile parsing. `forDir` scans
 * `input.path` for a known manifest (`package-lock.json`, then `pom.xml`),
 * parses it into a `BomPackage[]`, and writes both the SBOM document (via
 * ./bom-writer.ts) to disk and returns it as an `SbomDocument`. `forZip`/
 * `forJar` reuse the same scan against the artifact's source directory
 * (the directory the archive was built from is the natural place a lockfile
 * lives — the packaged bytes themselves are not re-inspected, matching this
 * backend's "declared deps, not a binary scan" scope). `forImage` is not
 * implemented here: an image's dependency surface includes its base layers,
 * which no lockfile enumerates — see this module's doc comment.
 */
export function createLockfileSbomGenerator(options: LockfileSbomGeneratorOptions = {}): SbomGenerator {
  const now = options.now ?? (() => new Date());

  function generateFromDir(dir: string, subjectName: string, digest?: string, format = DEFAULT_SBOM_FORMAT): SbomDocument {
    const manifest = findManifest(dir);
    if (!manifest) {
      throw new Error(
        `no supported lockfile/manifest found under "${dir}" (looked for package-lock.json, pom.xml) — ` +
          `the hermetic lockfile SBOM backend requires a lockfile on disk; use the deep-scan path (#610) for images with no lockfile`,
      );
    }
    const content = readFileSync(manifest.path, "utf-8");
    const packages = manifest.kind === "npm" ? parseNpmPackageLock(content) : parsePomXml(content);
    const generatorName = manifest.kind === "npm" ? "chant-lockfile-sbom/package-lock.json" : "chant-lockfile-sbom/pom.xml";

    const doc = writeBom(
      format,
      { subjectName, subjectId: digest ?? manifest.path, packages, generator: generatorName },
      now,
    );

    const outDir = options.outDir ?? dir;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(sbomOutputPath(outDir, format), doc.bytes);

    return { ...doc, packageCount: packages.length, generator: generatorName };
  }

  return {
    async forImage(_input: GenerateImageSbomInput): Promise<SbomDocument> {
      throw new SbomGeneratorNotImplementedError("forImage");
    },
    async forJar(input: GenerateJarSbomInput): Promise<SbomDocument> {
      return generateFromDir(dirname(input.jarPath), input.jarPath, input.digest, input.format);
    },
    async forZip(input: GenerateZipSbomInput): Promise<SbomDocument> {
      return generateFromDir(dirname(input.zipPath), input.zipPath, input.digest, input.format);
    },
    async forDir(input: GenerateDirSbomInput): Promise<SbomDocument> {
      return generateFromDir(input.path, input.path, undefined, input.format);
    },
  };
}

/** Process-wide hermetic lockfile-backed `SbomGenerator`, ready to inject wherever ./sbom-generator.ts's `notImplementedSbomGenerator` default previously required an explicit real backend. */
export const lockfileSbomGenerator: SbomGenerator = createLockfileSbomGenerator();
