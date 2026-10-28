/**
 * Publishing a module version to a hosted module registry (chant#4603,
 * terragucci#1290 bundle C). A module target is chant core's publish-target
 * contract (`PublishTarget` in core's lifecycle/release-publish.ts, chant#4047)
 * over a module-version context in place of a cut release (chant#4602): the
 * same `plan`, `stage` and `reveal`, the same `PublishTargetError`, the
 * injected `fetch`, `sleep` and `now`, and core's credential reading and
 * masking. Two reads sit beside the contract: `versions`, the versions the
 * host lists, and `held`, the content a version the host holds carries, so a
 * product's publish can tell a version that is already out from one holding
 * other content.
 *
 * Every target uploads the archive the bucket registry serves and the
 * attestation signs, unchanged (terragucci#1290 ruling B), so one digest
 * holds across all of them. A host that renders a README shows the module's
 * own.
 *
 * Products (terragucci's `modules.publish`) make the targets and hold the
 * words; the protocol and the host calls live here.
 */
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { PublishTargetError, type PublishContextBase, type PublishDeps, type PublishFetch, type PublishTarget } from "@intentius/chant/lifecycle/release-publish";
import { REGISTRY_NAME, REGISTRY_SYSTEM } from "../address";
import { parseSemver } from "../semver";
import type { RegistryFetch } from "../reader";

/** A module in a hosted registry, without the host: `<namespace>/<name>/<system>`. */
export interface ModuleAddress {
  namespace: string;
  name: string;
  system: string;
}

/** What a module target is given to plan and to publish: one version of one module. */
export interface ModuleVersionContext extends PublishContextBase {
  /** The module. A host that fixes the namespace itself (GitLab's top-level group, HCP's organization) uses its own. */
  address: ModuleAddress;
  /** The version, semver without a leading `v`. */
  version: string;
  /** The gzip tarball the bucket registry serves and the attestation signs, with the module at its root. */
  archive: Uint8Array;
  /** The commit the version was built from. */
  revision: string;
  /** The content digest, `sha256:<hex>` of the uncompressed archive, as the bucket registry's release.json keeps it. */
  content: string;
}

/** The content a version a host holds carries. */
export interface HeldVersion {
  /** `sha256:<hex>` of its uncompressed archive. */
  content: string;
  /** The revision the host keeps for it, when it keeps one. */
  revision?: string;
  /**
   * The host's status for a version it has not finished taking in, such as
   * HCP's `pending` before its archive is parsed (chant#4604). Absent for a
   * version consumers can install; `content` is empty while it is set.
   */
  status?: string;
}

/** The reads a module target answers beside the contract. They read, and change nothing. */
export interface ModuleTargetReads {
  /** Every version the host lists for the module, oldest first; none when it has no such module. */
  versions(address: ModuleAddress, ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<string[]>;
  /** The content of a version the host holds, or undefined when it holds no such version. */
  held(address: ModuleAddress, version: string, ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<HeldVersion | undefined>;
}

/** A target that publishes a module version: the publish-target contract over {@link ModuleVersionContext}, plus its reads. */
export type ModulePublishTarget<K extends string = string> = PublishTarget<ModuleVersionContext, K> & ModuleTargetReads;

/** What a module target's factory is given: core's publish deps, plus the fetch the registry reader uses. */
export interface ModuleTargetDeps extends PublishDeps {
  /**
   * The fetch the registry-protocol reads go through. Default: the global
   * `fetch`. A test passes its fake for both this and `fetch`.
   */
  registryFetch?: RegistryFetch;
}

/** `sha256:<hex>` of the bytes. */
export const contentDigest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** The content digest of a gzip archive: the digest of its uncompressed bytes. */
export function archiveContent(archive: Uint8Array): string {
  try {
    return contentDigest(gunzipSync(archive));
  } catch {
    throw new PublishTargetError("publish-archive-invalid", "the module archive is not a gzip tarball", "Publish the .tar.gz the bucket registry serves.");
  }
}

/**
 * The checks every module target's `plan` makes before it reads its host: the
 * address and version are ones a registry can carry, and the archive holds
 * the content the context names.
 */
export function checkModuleVersion(ctx: ModuleVersionContext): void {
  const { namespace, name, system } = ctx.address;
  if (!REGISTRY_NAME.test(namespace) || !REGISTRY_NAME.test(name)) {
    throw new PublishTargetError("publish-config-invalid", `${namespace}/${name}: a registry namespace and module name are letters, digits, - and _`);
  }
  if (!REGISTRY_SYSTEM.test(system)) throw new PublishTargetError("publish-config-invalid", `${system}: a registry module's system is lower-case letters and digits`);
  if (!parseSemver(ctx.version)) throw new PublishTargetError("publish-config-invalid", `${ctx.version} is not a semver version`);
  const got = archiveContent(ctx.archive);
  if (got !== ctx.content) {
    throw new PublishTargetError(
      "publish-artifact-digest-mismatch",
      `the archive for ${namespace}/${name}/${system} ${ctx.version} holds ${got}, and the release names ${ctx.content}`,
      "Publish the archive the release was built with.",
    );
  }
}

/** The refusal for a version a host holds with other content. */
export function versionHeldError(where: string, ctx: ModuleVersionContext, held: HeldVersion): PublishTargetError {
  return new PublishTargetError(
    "publish-version-held",
    `${where} already holds ${ctx.version} with content ${held.content}, and this publish has ${ctx.content}`,
    "A published version never changes: raise the version, or check why the module's content moved.",
  );
}

/** The error message for a host's answer, with every credential masked. */
export const answerError = (ctx: Pick<PublishContextBase, "redactor">, code: string, message: string, fix?: string): PublishTargetError =>
  new PublishTargetError(code, ctx.redactor.redact(message), fix === undefined ? undefined : ctx.redactor.redact(fix));

/** The global fetch, in the contract's shape. */
export const defaultPublishFetch: PublishFetch = (url, init) => fetch(url, init as RequestInit);
