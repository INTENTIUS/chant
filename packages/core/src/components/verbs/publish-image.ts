/**
 * `publish-image`: the registry half of the publish family, owned by core
 * (#3142, #3143). "Make the image available at the deploy target" is one
 * agnostic verb; what differs per cloud is how the local docker client logs in
 * to the registry. Each cloud lexicon contributes that as a
 * {@link RegistryLoginBackend} through `CapabilityPlugin.registryBackends()`
 * (aws: ECR, azure: ACR, gcp: Artifact Registry), and the environment picks
 * one (see {@link selectRegistryBackend}). So a project may declare several
 * clouds without two plugins registering the same verb.
 *
 * Promotion is by digest and unchanged from the aws-only implementation: load
 * the archived tarball, tag for the destination, log in, push, read the digest
 * back from the push. Optional SBOM/BOM referrers attach via `oras`, best
 * effort. No rollback: a pushed, content-addressed image is not something to
 * undo. See docs/components/build-archive.mdx.
 */

import type { Capability } from "../capability";
import { archiveRelativePath } from "./build-archive";
import { realDocker, type DockerClient } from "./cloud-executor";
import { defaultProcessRunner, q, type ProcessRunner } from "./process-runner";

/**
 * Common input shape both image-publish backends accept (`publish-image` here, `load-image-on-host` in the aws lexicon): promote the image
 * bytes at archive path `from` to wherever the deploy target can consume
 * them. `to` (registry) and `host` (bare host) are each meaningful to only
 * one backend, so a component authors one step shape (see
 * docs/components/build-archive.mdx) and the env-selected backend (see
 * `selectPublishBackend` below) reads whichever field it needs — the
 * unselected backend's field is simply unused, never a pipeline fork.
 */
export interface PublishImageInput {
  /** Path of the image tarball inside the build archive (as produced by `docker-build`; an `archive:`-prefixed reference is accepted and stripped). */
  from: string;
  /** Destination registry — required by `publish-image`, ignored by `load-image-on-host` (e.g. `$env.registry` resolved by the orchestrator). */
  to?: string;
  /** Target host — required by `load-image-on-host`, ignored by `publish-image` (SSM instance id, hostname, or host group). */
  host?: string;
  /** Destination path for the tarball on the host, used only by `load-image-on-host`. Default: `/tmp/chant-archive/<basename of from>`. */
  hostPath?: string;
  /**
   * Which registry login backend to use ("ecr", "acr", "artifact-registry").
   * Normally left out: the environment config (`ctx.vars.publish.backend`) or
   * the registry host picks it.
   */
  backend?: string;
  /** Additional tags to apply alongside the digest, used only by `publish-image`. */
  tags?: string[];
  /**
   * #610: the artifact's software SBOM (typically wired from a prior
   * `generate-sbom` step's `sbom` output — see ./sbom.ts's
   * `GenerateSbomOutput`) to attach as an OCI referrer on the pushed image
   * digest, via `oras attach`. Used only by `publish-image`; ignored by
   * `load-image-on-host` (registry-less — nothing to attach to). Omit to
   * skip the attach step entirely (the archive-carried copy remains the
   * SBOM's home either way).
   */
  sbom?: { bytes: string; mediaType: string };
  /**
   * #610: the component-level aggregate BOM (wired from
   * ./component-bom.ts's `aggregateComponentBom` output), attached as a
   * second OCI referrer alongside `sbom` when supplied. Optional and
   * independent of `sbom` — a caller may attach either, both, or neither.
   */
  componentBom?: { bytes: string; mediaType: string };
}

/** Result of `publish-image`'s best-effort OCI-referrer attach step (#610) — always present when `input.sbom`/`input.componentBom` was supplied, `undefined` when neither was (nothing to attach, attach step skipped entirely). */
export interface ReferrerAttachResult {
  /** True once every requested attach (`sbom`, `componentBom`) succeeded. `false` if `oras` was unavailable or any `oras attach` invocation failed. */
  attached: boolean;
  /** Human-readable reason `attached` is `false` (e.g. "oras is not installed"), omitted when `attached` is `true`. */
  reason?: string;
}

export interface PublishImageOutput {
  /** Content-addressed digest of the promoted image (`sha256:...`) — what the apply step references. */
  digest: string;
  /** Image reference the apply step can pull/run: `registry/repo@sha256:...` for `publish-image`, a host-local reference for `load-image-on-host`. */
  uri: string;
  /** #610: outcome of the best-effort SBOM/component-BOM referrer attach, when `input.sbom`/`input.componentBom` was supplied. `undefined` for `load-image-on-host` (no attach concept — registry-less) and for `publish-image` calls that supplied neither. */
  referrerAttach?: ReferrerAttachResult;
}

/**
 * Common shape both image-publish backends satisfy: promote the image bytes
 * held in the build archive to wherever the deploy target can consume them,
 * and return the identity the apply step references. The backend is
 * selected per environment (`selectPublishBackend`), never per component.
 */
export type PublishImageBackend = Capability<PublishImageInput, PublishImageOutput>;

// ── registry login backends ──────────────────────────────────────────────────

/** A cloud's way of authenticating the local docker client to its registry. */
export interface RegistryLoginBackend {
  /** Stable name an environment selects by: "ecr", "acr", "artifact-registry". */
  readonly name: string;
  /** True when this backend owns the registry host (used when the environment does not name one). */
  matches(registry: string): boolean;
  /** Authenticate docker against `registry` (host part of the destination). */
  login(registry: string): Promise<void>;
}

export class RegistryBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryBackendError";
  }
}

/**
 * Pick the login backend for one publish. Order: the step's `backend`, then the
 * environment's `ctx.vars.publish.backend`, then the single backend whose
 * `matches` claims the registry host, then the only backend there is.
 */
export function selectRegistryBackend(
  backends: readonly RegistryLoginBackend[],
  registry: string,
  named?: string,
): RegistryLoginBackend {
  const names = backends.map((b) => b.name).sort().join(", ") || "none";
  if (named) {
    const found = backends.find((b) => b.name === named);
    if (!found) {
      throw new RegistryBackendError(
        `publish-image: no registry backend "${named}" is registered (available: ${names}); declare the lexicon that contributes it in chant.config.ts`,
      );
    }
    return found;
  }
  const matched = backends.filter((b) => b.matches(registry));
  if (matched.length === 1) return matched[0]!;
  if (matched.length > 1) {
    throw new RegistryBackendError(
      `publish-image: registry "${registry}" matches several backends (${matched.map((b) => b.name).join(", ")}); set $env.publish.backend`,
    );
  }
  if (backends.length === 1) return backends[0]!;
  throw new RegistryBackendError(
    `publish-image: cannot tell which registry backend serves "${registry}" (available: ${names}); set $env.publish.backend`,
  );
}

/** Implemented by a capability that wants the plugins' registry backends injected when a registry is built. */
export interface RegistryBackendConsumer {
  withRegistryBackends(backends: readonly RegistryLoginBackend[]): Capability<never, unknown>;
}

export function isRegistryBackendConsumer(value: unknown): value is RegistryBackendConsumer {
  return typeof value === "object" && value !== null && typeof (value as RegistryBackendConsumer).withRegistryBackends === "function";
}

// ── publish-image ────────────────────────────────────────────────────────────

/**
 * Attempt to `oras attach` one referrer document (SBOM or component BOM) to
 * `imageRef`'s digest. Writes the document's bytes to a scratch file (`oras
 * attach` reads from a file path, not stdin) and shells out through
 * `runner`. Never throws — a failure here is reported back to the caller as
 * `{ ok: false, reason }` so a missing/erroring `oras` never fails the
 * publish itself (see `attachReferrers`'s doc comment for why).
 */
async function attachOneReferrer(
  runner: ProcessRunner,
  imageRef: string,
  doc: { bytes: string; mediaType: string },
  label: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const scratchFile = `/tmp/chant-referrer-attach/${label}-${Date.now()}.json`;
    await runner.run(`mkdir -p ${q("/tmp/chant-referrer-attach")}`);
    await runner.run(`printf '%s' ${q(doc.bytes)} > ${q(scratchFile)}`);
    await runner.run(`oras attach --artifact-type ${q(doc.mediaType)} ${q(imageRef)} ${q(scratchFile)}:${q(doc.mediaType)}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Best-effort OCI-referrer attach for a just-pushed image (#610): attaches
 * `input.sbom` and/or `input.componentBom`, when supplied, to `imageRef` via
 * `oras attach`. Guarded on `oras` availability — a missing binary is
 * reported back as `{ attached: false, reason }` rather than thrown, since
 * the image itself is already successfully promoted by the time this step
 * runs (attach is additive registry-side convenience on top of the
 * archive-carried copy, per this module's doc comment, never a condition the
 * core promote-by-digest job depends on). Returns `undefined` when neither
 * `input.sbom` nor `input.componentBom` was supplied — nothing to attach,
 * skipped entirely, no `oras` call at all.
 */
async function attachReferrers(
  runner: ProcessRunner,
  imageRef: string,
  input: Pick<PublishImageInput, "sbom" | "componentBom">,
): Promise<ReferrerAttachResult | undefined> {
  if (!input.sbom && !input.componentBom) return undefined;

  if (!(await runner.available("oras"))) {
    return { attached: false, reason: `"oras" is not installed or not on PATH — required to attach OCI referrers` };
  }

  const results: Array<{ ok: boolean; reason?: string }> = [];
  if (input.sbom) results.push(await attachOneReferrer(runner, imageRef, input.sbom, "sbom"));
  if (input.componentBom) results.push(await attachOneReferrer(runner, imageRef, input.componentBom, "component-bom"));

  const failed = results.find((r) => !r.ok);
  return failed ? { attached: false, reason: failed.reason } : { attached: true };
}

export interface PublishImageOptions {
  docker: DockerClient;
  backends?: readonly RegistryLoginBackend[];
  processRunner?: ProcessRunner;
}

export type PublishImageCapability = PublishImageBackend & RegistryBackendConsumer;

/**
 * Build the `publish-image` verb over a docker client and the registry login
 * backends available. Load, tag, log in via the selected backend, push, and
 * return the pushed digest.
 */
export function createPublishImageCapability(options: PublishImageOptions): PublishImageCapability {
  const { docker } = options;
  const backends = options.backends ?? [];
  const processRunner = options.processRunner ?? defaultProcessRunner();
  return {
    kind: "publish-image",
    withRegistryBackends(next) {
      return createPublishImageCapability({ docker, processRunner, backends: next });
    },
    async run(ctx, input) {
      if (!input.to) throw new Error(`publish-image "${input.from}": "to" (destination registry) is required`);
      const repo = input.to.replace(/\/+$/, "");
      const registry = repo.split("/")[0]!;
      const envBackend = (ctx.vars?.publish as { backend?: unknown } | undefined)?.backend;
      const backend = selectRegistryBackend(backends, registry, input.backend ?? (typeof envBackend === "string" ? envBackend : undefined));
      // `docker load` reports the archived image's local reference: a name:tag
      // for a tagged build, or an image id. It is a valid `docker tag` source
      // but never a registry digest, so the promoted digest is read back from
      // the push below.
      const { digest: localRef } = await docker.load({ inFile: archiveRelativePath(input.from) });
      // Publish under a tag: docker can neither tag nor push a digest-qualified
      // reference, so the transport is a tag and the stable identifier is the
      // digest the push returns.
      const pushRef = `${repo}:latest`;
      await docker.tag({ source: localRef, target: pushRef });
      await backend.login(registry);
      const { digest: pushed } = await docker.push({ image: pushRef });
      const digest = pushed.includes("@") ? pushed.slice(pushed.indexOf("@") + 1) : pushed;
      for (const tag of input.tags ?? []) {
        const tagged = `${repo}:${tag}`;
        await docker.tag({ source: localRef, target: tagged });
        await docker.push({ image: tagged });
      }
      const referrerAttach = await attachReferrers(processRunner, `${repo}@${digest}`, input);
      return { digest, uri: `${repo}@${digest}`, ...(referrerAttach ? { referrerAttach } : {}) };
    },
  };
}

/** The starter plugin's `publish-image`: real docker, backends injected from the loaded plugins. */
export const publishImageCapability: PublishImageCapability = createPublishImageCapability({ docker: realDocker });
