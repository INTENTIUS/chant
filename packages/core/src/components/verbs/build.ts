/**
 * build family — source -> BuildArchive, keyed by artifact type.
 * Fully cloud-agnostic (see docs/components/cloud-boundary). `docker-build` is
 * a real implementation (#557, epic #551) built over the injectable
 * `CloudExecutor` (./cloud-executor.ts) so tests never shell out to a real
 * `docker` daemon. `zip-package`/`jvm-build` are non-AWS/non-pilot verbs and
 * stay typed stubs — out of scope for #557; see ../capability.ts for the "no
 * cloud implementation yet" contract.
 *
 * `docker-build` also assembles the component's `BuildArchiveManifest`
 * (#564, epic #551 "4. Build archive + deferred publish" — see
 * ./build-archive.ts): every build appends an `image`-kind entry recording
 * the archive path and digest it just produced, so the archive is
 * self-describing (content-addressed, with a manifest of contents) rather
 * than a bare tarball. `addArchiveTemplate` lets a caller fold synthesized
 * deploy templates (e.g. CloudFormation JSON, already written into the
 * archive by chant's existing synthesis step) into the same manifest, so one
 * document enumerates every content kind the archive holds.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";
import { defaultCloudExecutor, type CloudExecutor } from "./cloud-executor";
import {
  addArchiveEntry,
  contentDigest,
  createBuildArchiveManifest,
  type BuildArchiveManifest,
} from "./build-archive";

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
  /**
   * Manifest to extend with this build's `image` entry, rather than starting
   * a fresh one. Pass the manifest returned by a prior build/template step in
   * the same archive (e.g. via `@Build.manifest` wiring) to accumulate one
   * manifest across a component's whole build phase. Omit to start a new
   * single-entry manifest for this build alone.
   */
  manifest?: BuildArchiveManifest;
}

export interface DockerBuildOutput {
  /** Path of the produced image tarball (OCI layout) inside the build archive. */
  archivePath: string;
  /** Content-addressed digest of the built image (`sha256:...`). */
  digest: string;
  /** The build archive's manifest, now including this image's entry — content-addressed via `manifest.manifestDigest`. */
  manifest: BuildArchiveManifest;
}

/**
 * Build a container image from a Dockerfile into the build archive: `docker
 * build`, tagged with a build-local reference derived from `into`, then
 * `docker save`d to the archive path (OCI layout, per `docker save`'s output
 * format). Records the produced tarball as an `image` entry in the archive's
 * manifest (extending `input.manifest` when the caller threads one through,
 * so a component with more than one image build accumulates a single
 * manifest for the whole archive). No rollback — a local build produces no
 * remote/mutable state to compensate; the archive path is simply not consumed
 * further if a later step fails.
 */
export function createDockerBuildCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<DockerBuildInput, DockerBuildOutput> {
  return {
    kind: "docker-build",
    async run(ctx, input) {
      const tag = `chant-build/${input.into.replace(/[^a-zA-Z0-9_.-]/g, "-")}:latest`;
      const { digest } = await executor.docker.build({
        context: input.context,
        dockerfile: input.dockerfile,
        buildArgs: input.buildArgs,
        target: input.target,
        tag,
      });
      await executor.docker.save({ image: tag, outFile: input.into });
      const base = input.manifest ?? createBuildArchiveManifest(ctx.component);
      const manifest = addArchiveEntry(base, { kind: "image", path: input.into, digest });
      return { archivePath: input.into, digest, manifest };
    },
  };
}

/** Default `docker-build` capability, backed by the real `CloudExecutor`. */
export const dockerBuild: Capability<DockerBuildInput, DockerBuildOutput> = createDockerBuildCapability();

// ── archive templates ────────────────────────────────────────────────────────

export interface AddArchiveTemplateInput {
  /** Where the synthesized template is written inside the build archive (e.g. `"search.template.json"`). */
  path: string;
  /** Serialized template content — its digest is computed from these exact bytes, so an unrelated re-synthesis with identical content keeps the same manifest digest. */
  content: string;
  /** Manifest to extend. Omit to start a new manifest holding just this template. */
  manifest?: BuildArchiveManifest;
}

export interface AddArchiveTemplateOutput {
  /** Content-addressed digest computed over `content`. */
  digest: string;
  /** The build archive's manifest, now including this template's entry. */
  manifest: BuildArchiveManifest;
}

/**
 * Fold one synthesized deploy template (e.g. the CloudFormation JSON chant's
 * existing synthesis already produces) into a build archive's manifest as a
 * `template`-kind entry, alongside the image(s) `docker-build` recorded. Not
 * a registered capability — template synthesis is chant's existing `build`
 * pipeline (see ../../build.ts), not a new deploy-time verb — so this is a
 * plain function a build orchestration step calls directly to keep one
 * manifest across every content kind the archive holds (image + templates).
 * Exported alongside the build-family capabilities since it is the other
 * half of "what goes in the manifest" `docker-build` documents above.
 */
export function addArchiveTemplate(input: AddArchiveTemplateInput): AddArchiveTemplateOutput {
  const digest = contentDigest(input.content);
  const base = input.manifest ?? createBuildArchiveManifest("unknown");
  const manifest = addArchiveEntry(base, { kind: "template", path: input.path, digest });
  return { digest, manifest };
}

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
