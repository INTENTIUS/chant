/**
 * Real, deep-scan `SbomGenerator` backend (#610, epic #551's "deep external
 * tool" half of the SBOM story — the counterpart to ./lockfile-sbom-generator.ts's
 * hermetic, zero-dependency default from #613). Shells out to whichever
 * external scanner fits the artifact type, through the injectable
 * `ProcessRunner` (./process-runner.ts, itself mirroring
 * ./cloud-executor.ts's `CloudExecutor` pattern):
 *
 *  - `image` -> `docker buildx build --sbom=true` (BuildKit's native SPDX
 *    attestation) when a Dockerfile build context is available, otherwise a
 *    `syft <tarball>` scan of the already-built OCI-layout tarball;
 *  - `jar`   -> `syft`, or `cyclonedx-maven` when the jar's project directory
 *    carries a `pom.xml` (a more Maven-native scan than a bytecode-level jar
 *    scan);
 *  - `zip`   -> `syft <zip>`;
 *  - `dir`   -> `syft <dir>`, falling back to `cdxgen <dir>` when `syft` is
 *    unavailable (`cdxgen`'s "wnat's on disk" mode covers ecosystems syft
 *    might not have detected).
 *
 * Every method resolves the specific tool it needs, checks availability via
 * `ProcessRunner.available` first, and throws `ToolNotAvailableError`
 * (./process-runner.ts) with an actionable install hint if the tool is
 * missing — never a silent empty SBOM. Tests inject `MockProcessRunner`
 * (./__tests__/mock-process-runner.ts) and assert on the constructed command
 * line + parsed output; nothing here ever spawns a real process.
 *
 * This backend is **not** the process-wide default (see
 * ./sbom-generator.ts's `notImplementedSbomGenerator` and
 * ./lockfile-sbom-generator.ts's `lockfileSbomGenerator` module docs for why):
 * a project opts in explicitly by constructing
 * `createGenerateSbomCapability(createToolSbomGenerator())` when it wants the
 * deeper, external-tool-backed scan (e.g. to see an image's base-layer OS
 * packages, which no lockfile read can see).
 */

import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import {
  DEFAULT_SBOM_FORMAT,
  SBOM_MEDIA_TYPES,
  type GenerateDirSbomInput,
  type GenerateImageSbomInput,
  type GenerateJarSbomInput,
  type GenerateZipSbomInput,
  type SbomDocument,
  type SbomFormat,
  type SbomGenerator,
} from "./sbom-generator";
import { defaultProcessRunner, q, requireTool, type ProcessRunner } from "./process-runner";

/** `syft`'s CycloneDX/SPDX JSON output format flags, keyed by `SbomFormat`. */
const SYFT_FORMAT: Record<SbomFormat, string> = {
  spdx: "spdx-json",
  cyclonedx: "cyclonedx-json",
};

/** `cdxgen` only emits CycloneDX; SPDX is not one of its output formats. */
const CDXGEN_FORMAT: SbomFormat = "cyclonedx";

export interface ToolSbomGeneratorOptions {
  /** Injected process boundary. Defaults to the real, `child_process`-backed runner. */
  runner?: ProcessRunner;
  /** Directory `syft`/`cdxgen`/`cyclonedx-maven` write their output file into before this backend reads it back. Defaults to `node:os`'s tmpdir via each call's own scratch path — see `scratchPath`. */
  workDir?: string;
}

/** Parse a package count out of a CycloneDX or SPDX JSON document, without requiring a full schema-aware parse — mirrors how ./lockfile-sbom-generator.ts's callers only need a count, not full re-validation. */
function countPackages(format: SbomFormat, bytes: string): number | undefined {
  try {
    const doc = JSON.parse(bytes) as Record<string, unknown>;
    if (format === "cyclonedx" && Array.isArray(doc.components)) return doc.components.length;
    if (format === "spdx" && Array.isArray(doc.packages)) return doc.packages.length;
  } catch {
    // Malformed/unexpected output — report no count rather than throwing;
    // the SBOM bytes themselves are still returned to the caller as-is.
  }
  return undefined;
}

/** Build a per-call scratch output path so concurrent scans never collide. */
function scratchPath(workDir: string | undefined, subject: string, format: SbomFormat): string {
  const dir = workDir ?? "/tmp/chant-sbom";
  const safeName = basename(subject).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(dir, `${safeName}.${Date.now()}.${format}.json`);
}

/**
 * Build a real, deep-scan `SbomGenerator` backend. Every method shells out
 * through `options.runner` (default: the real `ProcessRunner`); tests should
 * always pass a `MockProcessRunner` instead.
 */
export function createToolSbomGenerator(options: ToolSbomGeneratorOptions = {}): SbomGenerator {
  const runner = options.runner ?? defaultProcessRunner();

  async function runSyft(target: string, format: SbomFormat): Promise<{ bytes: string; generator: string }> {
    await requireTool(runner, "syft", `scan ${target} for a software bill of materials`);
    const out = scratchPath(options.workDir, target, format);
    await runner.run(`syft ${q(target)} -o ${SYFT_FORMAT[format]}=${q(out)}`);
    const { stdout } = await runner.run(`cat ${q(out)}`);
    return { bytes: stdout, generator: "syft" };
  }

  return {
    async forImage(input: GenerateImageSbomInput): Promise<SbomDocument> {
      const format = input.format ?? DEFAULT_SBOM_FORMAT;

      // Prefer BuildKit's own attestation when the image was built from a
      // context on disk right next to the tarball (the common docker-build ->
      // generate-sbom composition); otherwise fall back to scanning the
      // already-saved tarball with syft, which needs no rebuild.
      const buildContext = dirname(input.imagePath);
      const hasDockerfile = existsSync(join(buildContext, "Dockerfile"));

      if (hasDockerfile && (await runner.available("docker"))) {
        const out = scratchPath(options.workDir, input.imagePath, format);
        await runner.run(
          `docker buildx build --sbom=true --output type=local,dest=${q(out)} ${q(buildContext)}`,
        );
        const { stdout } = await runner.run(`cat ${q(join(out, "sbom.spdx.json"))}`);
        return {
          format,
          mediaType: SBOM_MEDIA_TYPES[format],
          bytes: stdout,
          packageCount: countPackages(format, stdout),
          generator: "buildkit",
        };
      }

      const { bytes, generator } = await runSyft(input.imagePath, format);
      return { format, mediaType: SBOM_MEDIA_TYPES[format], bytes, packageCount: countPackages(format, bytes), generator };
    },

    async forJar(input: GenerateJarSbomInput): Promise<SbomDocument> {
      const format = input.format ?? DEFAULT_SBOM_FORMAT;
      const projectDir = dirname(input.jarPath);
      const hasPom = existsSync(join(projectDir, "pom.xml"));

      if (hasPom && (await runner.available("mvn"))) {
        await requireTool(runner, "mvn", `run cyclonedx-maven against ${projectDir}`);
        const out = scratchPath(options.workDir, input.jarPath, "cyclonedx");
        await runner.run(
          `mvn -f ${q(join(projectDir, "pom.xml"))} org.cyclonedx:cyclonedx-maven-plugin:makeAggregateBom -DoutputFormat=json -DoutputName=${q(basename(out, ".json"))}`,
          { cwd: projectDir },
        );
        const { stdout } = await runner.run(`cat ${q(out)}`);
        return {
          format: "cyclonedx",
          mediaType: SBOM_MEDIA_TYPES.cyclonedx,
          bytes: stdout,
          packageCount: countPackages("cyclonedx", stdout),
          generator: "cyclonedx-maven",
        };
      }

      const { bytes, generator } = await runSyft(input.jarPath, format);
      return { format, mediaType: SBOM_MEDIA_TYPES[format], bytes, packageCount: countPackages(format, bytes), generator };
    },

    async forZip(input: GenerateZipSbomInput): Promise<SbomDocument> {
      const format = input.format ?? DEFAULT_SBOM_FORMAT;
      const { bytes, generator } = await runSyft(input.zipPath, format);
      return { format, mediaType: SBOM_MEDIA_TYPES[format], bytes, packageCount: countPackages(format, bytes), generator };
    },

    async forDir(input: GenerateDirSbomInput): Promise<SbomDocument> {
      const format = input.format ?? DEFAULT_SBOM_FORMAT;

      if (await runner.available("syft")) {
        const { bytes, generator } = await runSyft(input.path, format);
        return { format, mediaType: SBOM_MEDIA_TYPES[format], bytes, packageCount: countPackages(format, bytes), generator };
      }

      // syft absent — fall back to cdxgen (CycloneDX-only; requested SPDX is
      // reported back as the CycloneDX doc's own format, never silently
      // mislabeled as SPDX).
      await requireTool(runner, "cdxgen", `scan ${input.path} for a software bill of materials (syft is also unavailable)`);
      const out = scratchPath(options.workDir, input.path, CDXGEN_FORMAT);
      await runner.run(`cdxgen -o ${q(out)} ${q(input.path)}`);
      const { stdout } = await runner.run(`cat ${q(out)}`);
      return {
        format: CDXGEN_FORMAT,
        mediaType: SBOM_MEDIA_TYPES[CDXGEN_FORMAT],
        bytes: stdout,
        packageCount: countPackages(CDXGEN_FORMAT, stdout),
        generator: "cdxgen",
      };
    },
  };
}

/** Process-wide, real-tool-backed `SbomGenerator`, ready to inject wherever a project opts into the deep-scan path over ./lockfile-sbom-generator.ts's hermetic default. Never constructed by a test. */
export const toolSbomGenerator: SbomGenerator = createToolSbomGenerator();
