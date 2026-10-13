/**
 * `k8sInclude`: bring a plain multi-document YAML file or pinned URL into a
 * build as it is (#3566 item 4).
 *
 * Before this, the way to ship a vendored manifest bundle (an operator's
 * install.yaml, a CRD bundle) through chant was a kustomization directory
 * listing it as its only resource. `k8sInclude` declares the file or URL
 * directly. Its documents become the same verbatim manifest entities a
 * kustomize build root produces (`../manifest-entity.ts`), so they get
 * default labels and ownership stamping, post-synth checks, and
 * `lifecycle diff --live` like any declared resource.
 *
 * This module is the declaration only, with no filesystem or network access,
 * so the factory stays pure and folds under `--sandbox`. The bytes are read
 * at `buildRoots()`, the build's one impure seam, in `./resolve.ts`, the same
 * split `declareSecret({ provenance: "committed-encrypted" })` uses.
 *
 * The declaration itself never reaches the output: the serializer skips it,
 * and it carries no `props`, so the live read paths never ask a cluster
 * about it.
 */
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { RenderedPatch } from "../patch/rendered-patch";

/** Marks a `k8sInclude` declaration. */
export const K8S_INCLUDE_MARKER = Symbol.for("chant.k8s.include");

export const K8S_INCLUDE_ENTITY_TYPE = "chant:k8s:include";

/** Annotation stamped on every included document, valued with its source. */
export const INCLUDE_SOURCE_ANNOTATION = "chant.intentius.io/include-source";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export interface K8sIncludeProps {
  /**
   * A local file path, relative to the project root (the directory holding
   * `chant.config.*`), or an `https://` / `http://` URL.
   */
  source: string;
  /**
   * `sha256:<64 hex>` digest of the source's bytes. Required for a URL: the
   * fetched bytes must match it, and the digest keys the local cache, so
   * only the first build needs the network. Optional for a local file; when
   * set, the file must match it too.
   */
  digest?: string;
  /** Patches applied to the documents before they become entities. */
  patches?: RenderedPatch[];
}

export interface K8sIncludeDeclaration extends Declarable {
  readonly lexicon: "k8s";
  readonly entityType: typeof K8S_INCLUDE_ENTITY_TYPE;
  readonly [K8S_INCLUDE_MARKER]: true;
  readonly source: string;
  readonly digest?: string;
  readonly patches?: RenderedPatch[];
}

export function isK8sInclude(value: unknown): value is K8sIncludeDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[K8S_INCLUDE_MARKER] === true
  );
}

/** True for an `http://` or `https://` source. */
export function isRemoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/**
 * Declare a local or pinned remote multi-document YAML to include in the
 * build.
 *
 * @example
 * ```ts
 * import { k8sInclude } from "@intentius/chant-lexicon-k8s";
 *
 * export const certManager = k8sInclude({
 *   source: "https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml",
 *   digest: "sha256:...",
 * });
 *
 * export const legacy = k8sInclude({ source: "manifests/legacy.yaml" });
 * ```
 */
export function k8sInclude(props: K8sIncludeProps): K8sIncludeDeclaration {
  const source = props?.source;
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("k8sInclude: `source` must be a non-empty path or URL");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !isRemoteSource(source)) {
    throw new Error(`k8sInclude("${source}"): only local paths and http(s) URLs are supported`);
  }
  if (props.digest !== undefined && !DIGEST_RE.test(props.digest)) {
    throw new Error(
      `k8sInclude("${source}"): digest ${JSON.stringify(props.digest)} is not of the form "sha256:<64 lowercase hex>"`,
    );
  }
  if (isRemoteSource(source) && props.digest === undefined) {
    throw new Error(
      `k8sInclude("${source}"): a URL source must be pinned with \`digest: "sha256:<hex>"\`. ` +
        `Compute it from a copy you have reviewed, e.g. \`curl -sL <url> | shasum -a 256\`.`,
    );
  }

  return {
    lexicon: "k8s",
    entityType: K8S_INCLUDE_ENTITY_TYPE,
    source,
    ...(props.digest !== undefined ? { digest: props.digest } : {}),
    ...(props.patches !== undefined ? { patches: JSON.parse(JSON.stringify(props.patches)) as RenderedPatch[] } : {}),
    [DECLARABLE_MARKER]: true,
    [K8S_INCLUDE_MARKER]: true,
  };
}
