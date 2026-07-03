/**
 * `MockSbomGenerator` — an in-memory fake of `SbomGenerator`
 * (../sbom-generator.ts) for tests. No live `syft`/`docker buildx`/
 * `cyclonedx-maven`/`cdxgen`, no network: every method records its call and
 * returns a deterministic, canned `SbomDocument` derived from its inputs, the
 * same convention `../__tests__/mock-cloud-executor.ts` uses for
 * `CloudExecutor` (a fake digest suffix derived from the call's arguments,
 * stable across calls with the same args).
 *
 * Every test that exercises `generate-sbom` (../sbom.ts) builds one
 * `MockSbomGenerator` and passes it to `createGenerateSbomCapability`,
 * never touching a real scanner.
 */

import type {
  GenerateDirSbomInput,
  GenerateImageSbomInput,
  GenerateJarSbomInput,
  GenerateZipSbomInput,
  SbomDocument,
  SbomFormat,
  SbomGenerator,
} from "../sbom-generator";
import { SBOM_MEDIA_TYPES, DEFAULT_SBOM_FORMAT } from "../sbom-generator";

export interface RecordedSbomCall {
  method: "forImage" | "forJar" | "forZip" | "forDir";
  args: unknown;
}

export interface MockSbomGeneratorOptions {
  /** Force every call to fail (simulates a scanner crash/timeout). */
  fail?: boolean;
  /** Package count reported for every generated SBOM. Default: 3. */
  packageCount?: number;
  /** Generator/tool name reported. Default: "mock-syft". */
  generatorName?: string;
}

export interface MockSbomGenerator {
  generator: SbomGenerator;
  calls: RecordedSbomCall[];
}

/** Build a fresh mock `SbomGenerator`. Every method is deterministic and synchronous-fast — no real scan delay. */
export function createMockSbomGenerator(options: MockSbomGeneratorOptions = {}): MockSbomGenerator {
  const calls: RecordedSbomCall[] = [];
  const record = (method: RecordedSbomCall["method"], args: unknown) => calls.push({ method, args });

  function fakeSbom(kind: string, subject: string, format: SbomFormat | undefined, generatorName: string): SbomDocument {
    const resolvedFormat = format ?? DEFAULT_SBOM_FORMAT;
    return {
      format: resolvedFormat,
      mediaType: SBOM_MEDIA_TYPES[resolvedFormat],
      bytes: JSON.stringify({ fake: true, kind, subject, format: resolvedFormat }),
      packageCount: options.packageCount ?? 3,
      generator: options.generatorName ?? generatorName,
    };
  }

  const generator: SbomGenerator = {
    async forImage(input: GenerateImageSbomInput) {
      record("forImage", input);
      if (options.fail) throw new Error(`sbom generation failed for image ${input.imagePath}`);
      return fakeSbom("image", input.imagePath, input.format, "mock-buildkit");
    },
    async forJar(input: GenerateJarSbomInput) {
      record("forJar", input);
      if (options.fail) throw new Error(`sbom generation failed for jar ${input.jarPath}`);
      return fakeSbom("jar", input.jarPath, input.format, "mock-syft");
    },
    async forZip(input: GenerateZipSbomInput) {
      record("forZip", input);
      if (options.fail) throw new Error(`sbom generation failed for zip ${input.zipPath}`);
      return fakeSbom("zip", input.zipPath, input.format, "mock-syft");
    },
    async forDir(input: GenerateDirSbomInput) {
      record("forDir", input);
      if (options.fail) throw new Error(`sbom generation failed for dir ${input.path}`);
      return fakeSbom("dir", input.path, input.format, "mock-cdxgen");
    },
  };

  return { generator, calls };
}
