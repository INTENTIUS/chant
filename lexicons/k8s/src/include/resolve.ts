/**
 * Resolving `k8sInclude` declarations at `buildRoots()` (#3566 item 4).
 *
 * For each declaration in the discovered entity set: read the local file or
 * fetch the URL, check the bytes against the pinned digest, parse the
 * multi-document YAML, apply the declaration's patches, and wrap each
 * document in a verbatim manifest entity stamped with the source.
 *
 * - Local paths resolve against the project root (the directory holding
 *   `chant.config.*`), as `declareSecret`'s committed ciphertext and
 *   `k8s.kustomize.roots` do.
 * - A URL is fetched once. The bytes are cached under their digest in
 *   `~/.chant/includes/` (override with `CHANT_INCLUDE_CACHE_ROOT`, the
 *   counterpart of the helm lexicon's `CHANT_HELM_RENDER_ROOT`), and a build
 *   that finds a cached copy matching the digest never touches the network.
 *   Fetched bytes that do not match the digest fail the build and are not
 *   cached.
 * - Entity names are `<declaration name>/<kindName>`, qualified by
 *   namespace and then numbered in document order on collision, the scheme
 *   kustomize roots use. Keying on the declaration's export name rather than
 *   the URL keeps the names stable when a pinned version is bumped, so the
 *   live diff lines up across the upgrade.
 * - A missing file, a failed fetch, a file with no documents, and a
 *   document without a string `apiVersion` and `kind` each fail the build
 *   with the path or URL in the message. Empty documents (a stray `---`)
 *   are skipped.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadAll } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import type { BuildRootContext, BuildRootContribution } from "@intentius/chant/lexicon";
import { applyRenderedPatches } from "../patch/rendered-patch";
import { addRenderedEntity, renderedManifestEntity } from "../kustomize/rendered-entity";
import { INCLUDE_SOURCE_ANNOTATION, isK8sInclude, isRemoteSource, type K8sIncludeDeclaration } from "./entity";

/** Fetches a URL's bytes. Injectable so tests never touch the network. */
export type IncludeFetcher = (url: string) => Promise<Uint8Array>;

export const defaultIncludeFetcher: IncludeFetcher = async (url) => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  return new Uint8Array(await response.arrayBuffer());
};

/** Where fetched include sources are cached, keyed by digest. */
export function includeCacheRoot(): string {
  return process.env.CHANT_INCLUDE_CACHE_ROOT ?? join(homedir(), ".chant", "includes");
}

export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** `sha256:<hex>` -> `sha256-<hex>.yaml`; colons are not filesystem-safe everywhere. */
function cachePath(root: string, digest: string): string {
  return join(root, `${digest.replace(":", "-")}.yaml`);
}

export interface ResolveIncludesOptions {
  projectRoot: string;
  /** Declarations keyed by entity (export) name. */
  declarations: ReadonlyMap<string, K8sIncludeDeclaration>;
  fetch?: IncludeFetcher;
  readFile?: (path: string) => Uint8Array;
  /** Cache directory; defaults to {@link includeCacheRoot}. */
  cacheRoot?: string;
}

async function loadBytes(
  name: string,
  decl: K8sIncludeDeclaration,
  opts: ResolveIncludesOptions,
): Promise<Uint8Array> {
  const read = opts.readFile ?? ((path: string) => readFileSync(path));
  const label = `k8sInclude "${name}" (${decl.source})`;

  if (!isRemoteSource(decl.source)) {
    const absolute = resolve(opts.projectRoot, decl.source);
    let bytes: Uint8Array;
    try {
      bytes = read(absolute);
    } catch (err) {
      throw new Error(
        `${label}: file not readable at ${absolute} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (decl.digest !== undefined) {
      const actual = sha256Digest(bytes);
      if (actual !== decl.digest) {
        throw new Error(`${label}: ${absolute} does not match its pinned digest: expected ${decl.digest}, found ${actual}`);
      }
    }
    return bytes;
  }

  // The factory refuses an unpinned URL; this guards a declaration revived
  // from the entity wire format or built by hand.
  if (decl.digest === undefined) {
    throw new Error(`${label}: a URL source must be pinned with a sha256 digest`);
  }

  const root = opts.cacheRoot ?? includeCacheRoot();
  const cached = cachePath(root, decl.digest);
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    // A corrupt or hand-edited cache entry is refetched, never trusted.
    if (sha256Digest(bytes) === decl.digest) return bytes;
  }

  const fetcher = opts.fetch ?? defaultIncludeFetcher;
  let bytes: Uint8Array;
  try {
    bytes = await fetcher(decl.source);
  } catch (err) {
    throw new Error(`${label}: fetch failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  const actual = sha256Digest(bytes);
  if (actual !== decl.digest) {
    throw new Error(
      `${label}: fetched bytes do not match the pinned digest: expected ${decl.digest}, fetched ${actual}. ` +
        `The content at the URL changed, or the digest is wrong.`,
    );
  }

  try {
    mkdirSync(root, { recursive: true });
    const tmp = `${cached}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, cached);
  } catch {
    // A cache write failure is not fatal: the verified bytes are in memory,
    // and the next build fetches again.
  }
  return bytes;
}

/** Parse, validate and patch one source's documents. */
function documentsOf(name: string, decl: K8sIncludeDeclaration, text: string): Array<Record<string, unknown>> {
  const label = `k8sInclude "${name}" (${decl.source})`;
  let parsed: unknown[];
  try {
    parsed = loadAll(text);
  } catch (err) {
    throw new Error(`${label} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const docs: Array<Record<string, unknown>> = [];
  parsed.forEach((doc, i) => {
    if (doc === null || doc === undefined) return;
    if (typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`${label}: document ${i} is not a Kubernetes object`);
    }
    const record = doc as Record<string, unknown>;
    if (typeof record.apiVersion !== "string" || !record.apiVersion || typeof record.kind !== "string" || !record.kind) {
      throw new Error(`${label}: document ${i} has no string apiVersion and kind`);
    }
    docs.push(record);
  });
  if (docs.length === 0) throw new Error(`${label} contains no YAML documents`);

  return applyRenderedPatches(docs, decl.patches, label);
}

/**
 * Resolve every declaration into entities. Throws on the first one that
 * does not resolve: a build that would silently drop an included bundle
 * must not proceed.
 */
export async function resolveIncludes(opts: ResolveIncludesOptions): Promise<Map<string, Declarable>> {
  const entities = new Map<string, Declarable>();
  for (const [name, decl] of opts.declarations) {
    const bytes = await loadBytes(name, decl, opts);
    const text = Buffer.from(bytes).toString("utf-8");
    for (const doc of documentsOf(name, decl, text)) {
      // documentsOf checked apiVersion/kind, so the wrap cannot return null.
      addRenderedEntity(entities, name, renderedManifestEntity(doc, decl.source, INCLUDE_SOURCE_ANNOTATION)!);
    }
  }
  return entities;
}

/** Every `k8sInclude` declaration in an entity map, keyed by entity name. */
export function includeDeclarations(
  entities: ReadonlyMap<string, Declarable>,
): Map<string, K8sIncludeDeclaration> {
  const out = new Map<string, K8sIncludeDeclaration>();
  for (const [name, entity] of entities) {
    if (isK8sInclude(entity)) out.set(name, entity);
  }
  return out;
}

/** The `buildRoots` contribution: the documents of every `k8sInclude`. */
export async function includeBuildRoot(
  ctx: BuildRootContext,
  overrides?: Pick<ResolveIncludesOptions, "fetch" | "readFile" | "cacheRoot">,
): Promise<BuildRootContribution> {
  const declarations = includeDeclarations(ctx.entities ?? new Map());
  if (declarations.size === 0) return { entities: new Map() };
  return { entities: await resolveIncludes({ projectRoot: ctx.projectRoot, declarations, ...overrides }) };
}
