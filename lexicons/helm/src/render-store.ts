/**
 * RenderManifest + content-addressed render storage (#1238, epic #1228
 * Phase 2).
 *
 * #1237 gave a pinned render its identities — `inputDigest` over the
 * declared inputs, `contentDigest` over the canonical rendered bytes. This
 * module makes the render durable: the canonical bytes land in a
 * content-addressed store keyed by `contentDigest`, and a `RenderManifest`
 * — modeled on core's `BuildArchiveManifest`
 * (packages/core/src/components/verbs/build-archive.ts) — records what the
 * bytes are, what produced them, and how to find each document inside them.
 *
 * Storage layout, under `~/.chant/helm-renders/` (override with
 * `CHANT_HELM_RENDER_ROOT`):
 *
 * ```
 * sha256-<64 hex>/          one per distinct contentDigest
 *   content.yaml            the canonical rendered bytes (canonicalizeRender)
 *   manifest.json           the RenderManifest
 * inputs/<64 hex>.json      inputs index: full-render-inputs key -> digests
 * ```
 *
 * The `sha256-<hex>` entries are the new root the issue asks for: the
 * pre-#1238 cache keyed entries by a *truncated, input-derived* hash
 * (16 hex characters, no algorithm prefix), which is a cache key, not an
 * artifact identity. Those legacy entries are left exactly where they are —
 * unpinned renders keep using them — and pinned renders write here instead.
 * No migration: a truncated key cannot be turned back into a digest.
 *
 * Two renders that produce the same bytes share one `sha256-<hex>` entry —
 * the content file and manifest are written once and never rewritten
 * (first writer wins; the store is immutable, like a build archive entry).
 * Dedup falls out of content addressing rather than being a feature.
 *
 * The inputs index preserves cache-hit behavior: before shelling out to
 * helm, `HelmRender` computes the full-inputs key and reads
 * `inputs/<key>.json` to find the bytes a previous identical render stored.
 * The index key deliberately differs from `inputDigest`: the release name
 * and namespace are baked into the rendered bytes (`.Release.Name`,
 * `--namespace`) but are excluded from `inputDigest` because the release
 * ledger uses that digest as a cross-environment join key (see
 * `helmInputDigest` in ./render-digest.ts). A cache must key on everything
 * that changes the bytes, so the index key includes both.
 *
 * Retention: none, deliberately. The build archive this is modeled on has
 * no garbage collection — an archive entry lives until someone deletes it —
 * and the pre-#1238 render cache behaved the same way. This store follows
 * suit: entries accumulate until removed by hand. If the archive ever grows
 * a retention story, this store should adopt the same one.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "@intentius/chant/effect-receipt";
import yaml from "js-yaml";

import type { HelmCapabilityProfile } from "./config";
import { canonicalizeRender, helmContentDigest, helmInputDigest } from "./render-digest";

// ── manifest shape ────────────────────────────────────────────────────────

/**
 * One document's entry in a render's document index: enough identity to ask
 * "give me the ServiceAccount named X in namespace Y" and enough addressing
 * to answer it without parsing the whole stream.
 */
export interface RenderDocumentEntry {
  /** Kubernetes kind, e.g. `Deployment`. */
  kind: string;
  /** apiVersion as rendered, e.g. `apps/v1`. */
  apiVersion: string;
  /** `metadata.name`. */
  name: string;
  /** `metadata.namespace`, or `null` for cluster-scoped / namespace-less documents. */
  namespace: string | null;
  /** The helm-inserted `# Source:` origin path, when the document carries one. */
  source: string | null;
  /**
   * Byte offset of this document's first byte inside `content.yaml`
   * (pointing just past the `---` separator line, at the `# Source:` header
   * when there is one).
   */
  start: number;
  /** Byte length of the document, up to the next separator (or end of file). */
  length: number;
  /** `sha256:` over exactly those bytes — lets a reader verify a slice without trusting offsets. */
  digest: string;
}

/**
 * The durable record of one pinned render — what `manifest.json` holds.
 * Modeled on `BuildArchiveManifest`: versioned, content-addressed, and
 * carrying both identity sides the epic's Decisions require — the
 * input-side join key (`inputDigest`, with `valuesDigest` as its
 * values-only component) for cross-environment questions, and
 * `contentDigest` proving what this cluster's profile actually received.
 */
export interface RenderManifest {
  /** Manifest schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  /** Chart name or local chart path, as the render declared it. */
  chart: string;
  /** Pinned chart version, or `null` for a local chart rendered without one. */
  chartVersion: string | null;
  /** Chart repo URL, or `null` for a local chart. */
  repo: string | null;
  /** Helm release name baked into the bytes (`.Release.Name`). */
  releaseName: string;
  /** Namespace the render targeted (`--namespace`), or `null`. */
  namespace: string | null;
  /**
   * `sha256:` over the canonical JSON of the resolved values alone — the
   * input-side join key the epic's ledger queries use together with
   * `(chart, chartVersion)`.
   */
  valuesDigest: string;
  /**
   * `sha256:` over the full declared-input set (chart reference, version,
   * values, capability facts) — `helmInputDigest`, the same digest the
   * release ledger records on deploy (#1243).
   */
  inputDigest: string;
  /** The capability profile the render was pinned against. `cluster` is the profile's declared name — profiles are per cluster. */
  capabilityProfile: { cluster: string; kubeVersion: string; apiVersions: string[] };
  /** `sha256:` over the canonical rendered bytes — the artifact identity, and this entry's storage key. */
  contentDigest: string;
  /** Number of documents in the canonical stream (including any the index could not identify). */
  docCount: number;
  /** Index of identifiable documents: kind/namespace/name -> byte span + per-document digest. */
  documents: RenderDocumentEntry[];
  /** ISO-8601 timestamp this manifest was written. Not part of any digest. */
  renderedAt: string;
  /**
   * Version of the helm binary that produced the bytes. Load-bearing: the
   * default kube version is a property of the binary (epic finding 1), so
   * this field is what explains a digest mismatch between two machines.
   */
  helmVersion: string;
  /** chant version that wrote this manifest. */
  chantVersion: string;
  /** Source ref/commit the render was produced from, when the caller supplied one. */
  sourceRef: string | null;
}

/** What `inputs/<key>.json` holds: the digests a full-inputs cache key resolves to. */
export interface RenderInputsIndexEntry {
  version: 1;
  inputDigest: string;
  contentDigest: string;
}

// ── store location ────────────────────────────────────────────────────────

/**
 * Root of the render store. `CHANT_HELM_RENDER_ROOT` overrides the default
 * `~/.chant/helm-renders` — the same directory the legacy input-keyed cache
 * lives in; the two coexist because legacy entries are bare 16-hex names
 * and store entries are `sha256-` prefixed.
 */
export function renderStoreRoot(): string {
  return process.env.CHANT_HELM_RENDER_ROOT ?? join(homedir(), ".chant", "helm-renders");
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** `sha256:<hex>` -> the store directory name `sha256-<hex>` (colons are not filesystem-safe everywhere). */
function digestDirName(contentDigest: string): string {
  if (!DIGEST_RE.test(contentDigest)) {
    throw new Error(`not a content digest: ${JSON.stringify(contentDigest)} (expected "sha256:<64 hex>")`);
  }
  return contentDigest.replace(":", "-");
}

function contentPath(root: string, contentDigest: string): string {
  return join(root, digestDirName(contentDigest), "content.yaml");
}

function manifestPath(root: string, contentDigest: string): string {
  return join(root, digestDirName(contentDigest), "manifest.json");
}

// ── inputs index key ──────────────────────────────────────────────────────

/** The full set of inputs that determine a pinned render's bytes. */
export interface RenderCacheKeySource {
  /** Chart reference — a local path, or `<repo-url>/<chart>` for repo-fetched charts (same convention `helmInputDigest` uses). */
  chart: string;
  chartVersion?: string;
  /** Release name — baked into the bytes via `.Release.Name`, so a real cache input even though `inputDigest` excludes it. */
  releaseName: string;
  /** Namespace — baked in via `--namespace`, likewise excluded from `inputDigest`. */
  namespace?: string;
  values?: Record<string, unknown>;
  capabilityProfile: HelmCapabilityProfile;
}

/**
 * Cache key over *everything* that changes a pinned render's bytes — a
 * strict superset of `helmInputDigest`'s inputs (adds release name,
 * namespace, and the profile's declared name, mirroring the legacy cache
 * key's fields). 64 hex characters, no prefix: this is a lookup key, not an
 * artifact identity.
 */
export function renderCacheKey(source: RenderCacheKeySource): string {
  const input = {
    chart: source.chart,
    chartVersion: source.chartVersion ?? null,
    releaseName: source.releaseName,
    namespace: source.namespace ?? null,
    values: source.values ?? {},
    capabilityProfile: {
      name: source.capabilityProfile.name,
      kubeVersion: source.capabilityProfile.kubeVersion,
      apiVersions: [...(source.capabilityProfile.apiVersions ?? [])].sort(),
    },
  };
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

const CACHE_KEY_RE = /^[0-9a-f]{64}$/;

function inputsIndexPath(root: string, cacheKey: string): string {
  if (!CACHE_KEY_RE.test(cacheKey)) {
    throw new Error(`not a render cache key: ${JSON.stringify(cacheKey)} (expected 64 hex characters)`);
  }
  return join(root, "inputs", `${cacheKey}.json`);
}

// ── values digest ─────────────────────────────────────────────────────────

/**
 * `sha256:` over the canonical JSON of the resolved values alone — the
 * `valuesDigest` half of the ledger's input-side join key
 * `(chart, chartVersion, valuesDigest)`. Absent values digest as `{}`,
 * matching `helmInputDigest`'s treatment.
 */
export function helmValuesDigest(values?: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(values ?? {}), "utf8").digest("hex")}`;
}

// ── chant version ─────────────────────────────────────────────────────────

function readVersionAbove(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const version = (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version;
        if (version) return version;
      } catch {
        // unreadable package.json — fall through to the caller's fallback
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The core package's version, read from its `package.json` next to wherever
 * `@intentius/chant` resolves from here. Falls back to this lexicon's own
 * version (the two release in lockstep), then `"unknown"` — a manifest is
 * never blocked on version discovery.
 */
function chantVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const fromCore = readVersionAbove(dirname(req.resolve("@intentius/chant")));
    if (fromCore) return fromCore;
  } catch {
    // resolution failed (unusual layout) — use the lexicon's own version
  }
  return readVersionAbove(dirname(fileURLToPath(import.meta.url))) ?? "unknown";
}

// ── document index ────────────────────────────────────────────────────────

interface CanonicalSegment {
  /** Segment text (from just past the `---` line to the next separator). */
  text: string;
  /** Byte offset of the segment inside the canonical stream. */
  byteStart: number;
  /** Byte length of the segment. */
  byteLength: number;
}

/**
 * Split a canonical stream (canonicalizeRender output) into its documents
 * with byte-accurate offsets. Boundaries are column-0 `---` lines — the
 * canonical form introduces every document with one, and no canonical
 * document body can contain one (block-scalar content is always indented).
 */
function canonicalSegments(canonical: string): CanonicalSegment[] {
  const marks: number[] = [];
  const re = /^---$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(canonical)) !== null) marks.push(m.index);

  const segments: CanonicalSegment[] = [];
  let lastCharEnd = 0;
  let lastByteEnd = 0;
  for (let k = 0; k < marks.length; k++) {
    const charStart = canonical.indexOf("\n", marks[k]) + 1; // just past "---\n"
    const charEnd = k + 1 < marks.length ? marks[k + 1] : canonical.length;
    const byteStart = lastByteEnd + Buffer.byteLength(canonical.slice(lastCharEnd, charStart), "utf8");
    const text = canonical.slice(charStart, charEnd);
    const byteLength = Buffer.byteLength(text, "utf8");
    segments.push({ text, byteStart, byteLength });
    lastCharEnd = charEnd;
    lastByteEnd = byteStart + byteLength;
  }
  return segments;
}

const SOURCE_LINE = /^# Source: (\S+)$/m;

/**
 * Build the document index over a canonical stream: for every identifiable
 * document (it parses and carries `kind` + `metadata.name`), its
 * kind/namespace/name identity, byte span, and per-document digest.
 * Returns the index and the total document count — the count includes
 * documents the index could not identify, so `docCount` is always the
 * number of documents the artifact carries.
 */
export function indexRenderDocuments(canonical: string): { documents: RenderDocumentEntry[]; docCount: number } {
  const segments = canonicalSegments(canonical);
  const documents: RenderDocumentEntry[] = [];
  for (const segment of segments) {
    let parsed: unknown;
    try {
      parsed = yaml.load(segment.text);
    } catch {
      continue; // verbatim (unparseable) document — counted, not indexed
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const doc = parsed as { kind?: unknown; apiVersion?: unknown; metadata?: { name?: unknown; namespace?: unknown } };
    if (typeof doc.kind !== "string" || typeof doc.metadata?.name !== "string") continue;
    documents.push({
      kind: doc.kind,
      apiVersion: typeof doc.apiVersion === "string" ? doc.apiVersion : "",
      name: doc.metadata.name,
      namespace: typeof doc.metadata.namespace === "string" ? doc.metadata.namespace : null,
      source: segment.text.match(SOURCE_LINE)?.[1] ?? null,
      start: segment.byteStart,
      length: segment.byteLength,
      digest: `sha256:${createHash("sha256").update(segment.text, "utf8").digest("hex")}`,
    });
  }
  return { documents, docCount: segments.length };
}

// ── write path ────────────────────────────────────────────────────────────

export interface PersistHelmRenderInput {
  /** The `helm template` output — raw or already canonical; it is canonicalized before storage either way. */
  rendered: string;
  /** Release name the render was produced under (`HelmRenderProps.name`). */
  releaseName: string;
  /** Chart name or local chart path, as declared. */
  chart: string;
  /** Chart repo URL for repo-fetched charts. */
  repo?: string;
  chartVersion?: string;
  namespace?: string;
  values?: Record<string, unknown>;
  /**
   * The capability profile the render was pinned against. Absent means the
   * render was unpinned — persistence is refused, because an unpinned
   * render's bytes are a function of the local helm binary's defaults and
   * have no identity worth storing.
   */
  capabilityProfile?: HelmCapabilityProfile;
  /** Version of the helm binary that produced the bytes. Recorded as `"unknown"` when not supplied. */
  helmVersion?: string;
  /** Source ref/commit, when the caller has one. Never fabricated. */
  sourceRef?: string;
  /** Clock override for tests. */
  now?: () => Date;
  /** Store root override; defaults to `renderStoreRoot()`. */
  root?: string;
}

export interface PersistedHelmRender {
  /** The manifest now on disk — the existing one when the content was already stored. */
  manifest: RenderManifest;
  /** Directory the render lives in: `<root>/sha256-<hex>`. */
  dir: string;
  /**
   * True when this contentDigest was already in the store — the bytes and
   * manifest were left untouched (only the inputs index was updated).
   */
  deduplicated: boolean;
}

/**
 * Persist one pinned render: canonical bytes under their `contentDigest`,
 * the `RenderManifest` beside them, and an inputs-index entry so an
 * identical future render is a cache hit.
 *
 * Content-addressed entries are immutable: when the digest directory
 * already holds a manifest, both files are left as they are and the
 * existing manifest is returned (`deduplicated: true`). The inputs index is
 * still written — a new input combination can legitimately map to bytes the
 * store already holds.
 *
 * Refuses an unpinned render (no capability profile) with the specific
 * reason: no profile means the bytes depend on the local helm binary's
 * defaulted capabilities, so they have no stable content identity to store
 * under.
 */
export function persistHelmRender(input: PersistHelmRenderInput): PersistedHelmRender {
  if (!input.capabilityProfile) {
    throw new Error(
      `refusing to persist unpinned render "${input.releaseName}" (${input.chart}): ` +
        `no capability profile is declared, so the rendered bytes are a function of the local ` +
        `helm binary's defaulted capabilities and have no stable content identity to store under. ` +
        `Declare capabilityProfile on the HelmRender to pin it (#1235).`,
    );
  }
  const profile = input.capabilityProfile;
  const root = input.root ?? renderStoreRoot();

  const canonical = canonicalizeRender(input.rendered);
  const contentDigest = helmContentDigest(input.rendered);
  const chartRef = input.repo ? `${input.repo}/${input.chart}` : input.chart;
  const inputDigest = helmInputDigest({
    chart: chartRef,
    chartVersion: input.chartVersion,
    values: input.values ?? {},
    capabilityProfile: { kubeVersion: profile.kubeVersion, apiVersions: profile.apiVersions },
  });

  const dir = join(root, digestDirName(contentDigest));
  const existing = loadRenderManifest(contentDigest, { root });
  let manifest: RenderManifest;
  let deduplicated = false;
  if (existing) {
    // First writer wins — the entry is immutable, like a build archive's.
    manifest = existing;
    deduplicated = true;
  } else {
    const { documents, docCount } = indexRenderDocuments(canonical);
    manifest = {
      version: 1,
      chart: input.chart,
      chartVersion: input.chartVersion ?? null,
      repo: input.repo ?? null,
      releaseName: input.releaseName,
      namespace: input.namespace ?? null,
      valuesDigest: helmValuesDigest(input.values),
      inputDigest,
      capabilityProfile: {
        cluster: profile.name,
        kubeVersion: profile.kubeVersion,
        apiVersions: profile.apiVersions ?? [],
      },
      contentDigest,
      docCount,
      documents,
      renderedAt: (input.now ?? (() => new Date()))().toISOString(),
      helmVersion: input.helmVersion ?? "unknown",
      chantVersion: chantVersion(),
      sourceRef: input.sourceRef ?? null,
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(contentPath(root, contentDigest), canonical);
    writeFileSync(manifestPath(root, contentDigest), JSON.stringify(manifest, null, 2) + "\n");
  }

  const key = renderCacheKey({
    chart: chartRef,
    chartVersion: input.chartVersion,
    releaseName: input.releaseName,
    namespace: input.namespace,
    values: input.values,
    capabilityProfile: profile,
  });
  const indexEntry: RenderInputsIndexEntry = { version: 1, inputDigest, contentDigest };
  mkdirSync(join(root, "inputs"), { recursive: true });
  writeFileSync(inputsIndexPath(root, key), JSON.stringify(indexEntry, null, 2) + "\n");

  return { manifest, dir, deduplicated };
}

// ── read path ─────────────────────────────────────────────────────────────

/** Load the `RenderManifest` stored under a content digest, or `undefined` when the store has no such entry. */
export function loadRenderManifest(contentDigest: string, opts?: { root?: string }): RenderManifest | undefined {
  const root = opts?.root ?? renderStoreRoot();
  const path = manifestPath(root, contentDigest);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RenderManifest;
  if (parsed.version !== 1) {
    throw new Error(`render manifest ${path} has unsupported version ${String(parsed.version)}`);
  }
  return parsed;
}

/** Load the canonical rendered bytes stored under a content digest, or `undefined` when absent. */
export function loadRenderContent(contentDigest: string, opts?: { root?: string }): string | undefined {
  const root = opts?.root ?? renderStoreRoot();
  const path = contentPath(root, contentDigest);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

/** Resolve a full-inputs cache key through the inputs index, or `undefined` on a miss. */
export function findRenderByCacheKey(
  cacheKey: string,
  opts?: { root?: string },
): RenderInputsIndexEntry | undefined {
  const root = opts?.root ?? renderStoreRoot();
  const path = inputsIndexPath(root, cacheKey);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RenderInputsIndexEntry;
  if (parsed.version !== 1) return undefined;
  return parsed;
}

/**
 * Every manifest in the store, sorted by `renderedAt` then `contentDigest`
 * for a stable listing. Entries whose manifest is missing or unreadable are
 * skipped — a listing never fails on one corrupt entry. This is the query
 * surface the diff issues (#1249/#1250) resolve digests against.
 */
export function listRenderManifests(opts?: { root?: string }): RenderManifest[] {
  const root = opts?.root ?? renderStoreRoot();
  if (!existsSync(root)) return [];
  const manifests: RenderManifest[] = [];
  for (const entry of readdirSync(root)) {
    if (!/^sha256-[0-9a-f]{64}$/.test(entry)) continue;
    try {
      const manifest = loadRenderManifest(entry.replace("-", ":"), { root });
      if (manifest) manifests.push(manifest);
    } catch {
      // corrupt entry — skip it, never fail the listing
    }
  }
  manifests.sort((a, b) =>
    a.renderedAt === b.renderedAt
      ? a.contentDigest.localeCompare(b.contentDigest)
      : a.renderedAt.localeCompare(b.renderedAt),
  );
  return manifests;
}

/** How a caller names one document inside a stored render. */
export interface RenderDocumentRef {
  kind: string;
  name: string;
  /** Omit (or pass `null`) to match a cluster-scoped / namespace-less document. */
  namespace?: string | null;
}

/**
 * Resolve one document by kind/namespace/name to its exact bytes inside a
 * stored render, via the manifest's document index. The slice is verified
 * against the entry's per-document digest before being returned — corrupt
 * content is an error, never silently wrong bytes. `undefined` means the
 * store has no such render or the index has no such document.
 */
export function readRenderDocument(
  contentDigest: string,
  ref: RenderDocumentRef,
  opts?: { root?: string },
): { entry: RenderDocumentEntry; text: string } | undefined {
  const root = opts?.root ?? renderStoreRoot();
  const manifest = loadRenderManifest(contentDigest, { root });
  if (!manifest) return undefined;
  const wantNs = ref.namespace ?? null;
  const entry = manifest.documents.find(
    (d) => d.kind === ref.kind && d.name === ref.name && d.namespace === wantNs,
  );
  if (!entry) return undefined;
  const content = loadRenderContent(contentDigest, { root });
  if (content === undefined) return undefined;
  const bytes = Buffer.from(content, "utf8").subarray(entry.start, entry.start + entry.length);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== entry.digest) {
    throw new Error(
      `stored render ${contentDigest} is corrupt: document ${entry.kind}/${entry.name} ` +
        `digests to ${digest}, manifest says ${entry.digest}`,
    );
  }
  return { entry, text: bytes.toString("utf8") };
}
