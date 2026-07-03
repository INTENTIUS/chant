/**
 * build family — source -> BuildArchive, keyed by artifact type.
 * Fully cloud-agnostic (see docs/components/cloud-boundary). `docker-build` is
 * a real implementation (#557, epic #551) built over the injectable
 * `CloudExecutor` (./cloud-executor.ts) so tests never shell out to a real
 * `docker` daemon. `zip-package`/`jvm-build` are non-AWS/non-pilot verbs and
 * stay typed stubs — out of scope for #557; see ../capability.ts for the "no
 * cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";
import { defaultCloudExecutor, type CloudExecutor } from "./cloud-executor";

// ── docker-build ────────────────────────────────────────────────────────────

export interface DockerBuildInput {
  /** Build context directory. */
  context: string;
  /** Path to the Dockerfile, relative to `context`. Default: "Dockerfile". */
  dockerfile?: string;
  /** Build args passed to `docker build --build-arg`. */
  buildArgs?: Record<string, string>;
  /** Target stage for a multi-stage build. */
  target?: string;
  /** Where the produced image tarball is written inside the build archive. */
  into: string;
}

export interface DockerBuildOutput {
  /** Path of the produced image tarball (OCI layout) inside the build archive. */
  archivePath: string;
  /** Content-addressed digest of the built image (`sha256:...`). */
  digest: string;
}

/**
 * Build a container image from a Dockerfile into the build archive: `docker
 * build`, tagged with a build-local reference derived from `into`, then
 * `docker save`d to the archive path. No rollback — a local build produces no
 * remote/mutable state to compensate; the archive path is simply not consumed
 * further if a later step fails.
 */
export function createDockerBuildCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<DockerBuildInput, DockerBuildOutput> {
  return {
    kind: "docker-build",
    async run(_ctx, input) {
      const tag = `chant-build/${input.into.replace(/[^a-zA-Z0-9_.-]/g, "-")}:latest`;
      const { digest } = await executor.docker.build({
        context: input.context,
        dockerfile: input.dockerfile,
        buildArgs: input.buildArgs,
        target: input.target,
        tag,
      });
      await executor.docker.save({ image: tag, outFile: input.into });
      return { archivePath: input.into, digest };
    },
  };
}

/** Default `docker-build` capability, backed by the real `CloudExecutor`. */
export const dockerBuild: Capability<DockerBuildInput, DockerBuildOutput> = createDockerBuildCapability();

// ── zip-package ─────────────────────────────────────────────────────────────

export interface ZipPackageInput {
  /** Directory (or file list) to package. */
  source: string;
  /** Glob patterns to exclude from the archive. */
  exclude?: string[];
  /** Where the produced zip is written inside the build archive. */
  into: string;
}

export interface ZipPackageOutput {
  /** Path of the produced zip inside the build archive. */
  archivePath: string;
  /** Content hash of the zip (for promote-by-digest style referencing). */
  digest: string;
}

/** Package a directory into a zip artifact (e.g. a Lambda deployment package) into the build archive. */
export const zipPackage: Capability<ZipPackageInput, ZipPackageOutput> = stubCapability(
  "zip-package",
);

// ── jvm-build ────────────────────────────────────────────────────────────────

export interface JvmBuildInput {
  /** Build tool driving the compile/package step. */
  tool: "maven" | "gradle";
  /** Project directory containing the build file. */
  path: string;
  /** Build tool goals/tasks to run. Default: tool-appropriate package goal. */
  goals?: string[];
  /** Where the produced jar is written inside the build archive. */
  into: string;
}

export interface JvmBuildOutput {
  /** Path of the produced jar inside the build archive. */
  archivePath: string;
  /** Content hash of the jar. */
  digest: string;
}

/** Compile and package a JVM project (Maven/Gradle) into a jar in the build archive. */
export const jvmBuild: Capability<JvmBuildInput, JvmBuildOutput> = stubCapability("jvm-build");
