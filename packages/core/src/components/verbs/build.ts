/**
 * build family — source -> BuildArchive, keyed by artifact type.
 * Fully cloud-agnostic (see docs/components/cloud-boundary). Typed stubs only;
 * see ../capability.ts for the "no cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";

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

/** Build a container image from a Dockerfile into the build archive. */
export const dockerBuild: Capability<DockerBuildInput, DockerBuildOutput> = stubCapability(
  "docker-build",
);

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
