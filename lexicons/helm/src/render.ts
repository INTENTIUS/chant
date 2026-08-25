/**
 * HelmRender — render an upstream Helm chart at chant build time.
 *
 * Most chant projects that want to install third-party operators (ESO,
 * cert-manager, ingress-nginx, etc.) ran `helm template` or `helm install`
 * as a separate deploy phase. That meant the chant build output was
 * incomplete — `kubectl apply -f dist/...yaml` didn't carry those operators.
 *
 * `HelmRender({ repo, chart, version, values })` resolves at synth time:
 *   1. Shells out to `helm template` (requires the `helm` binary in PATH).
 *   2. Parses the resulting multi-document YAML.
 *   3. Emits each rendered K8s manifest as a Declarable in the build output.
 *   4. Caches the rendered output under `~/.chant/helm-renders/<hash>/`
 *      keyed by (repo, chart, version, values) so subsequent builds skip
 *      network access.
 *
 * The lexicon must include both `helm` and `k8s` (since rendered manifests
 * are k8s resources).
 *
 * @example
 * import { HelmRender } from "@intentius/chant-lexicon-helm";
 *
 * export const eso = HelmRender({
 *   name: "external-secrets",
 *   repo: "https://charts.external-secrets.io",
 *   chart: "external-secrets",
 *   version: "0.10.4",
 *   namespace: "external-secrets",
 *   createNamespace: true,
 *   values: { installCRDs: true },
 * });
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Composite } from "@intentius/chant";
// Use the k8s lexicon's Deployment as a generic Declarable wrapper for
// arbitrary K8s manifests. The k8s serializer reads props.apiVersion and
// props.kind verbatim when set, so the actual class doesn't matter.
import { Deployment } from "@intentius/chant-lexicon-k8s/generated/index";
import yaml from "js-yaml";

import { resolveCapabilityProfile, type HelmCapabilityProfile, type HelmCapabilityProfileRef } from "./config";
import { helmContentDigest, helmInputDigest } from "./render-digest";
import {
  findRenderByCacheKey,
  loadRenderContent,
  persistHelmRender,
  renderCacheKey,
} from "./render-store";

export interface HelmRenderProps {
  /** Logical name for the render (used in cache key + composite name). */
  name: string;
  /** Chart repo URL, e.g. https://charts.external-secrets.io */
  repo: string;
  /** Chart name, e.g. "external-secrets" */
  chart: string;
  /** Pinned chart version, e.g. "0.10.4" */
  version: string;
  /** Target namespace passed to `helm template --namespace`. */
  namespace?: string;
  /** Also emit a Namespace manifest. Default: false. */
  createNamespace?: boolean;
  /** Helm values overrides (written to a values.yaml then passed via -f). */
  values?: Record<string, unknown>;
  /**
   * Skip the on-disk cache. Default: false. Tests pass `true` to force a
   * fresh render.
   */
  noCache?: boolean;
  /**
   * Capability profile the render is pinned against (#1235, epic #1228).
   *
   * A string names a profile declared in `chant.config.ts`'s
   * `helm.capabilityProfiles` (per cluster — see `./config.ts`); an inline
   * object carries the same facts directly. When set, `helm template` runs
   * with `--kube-version` and `--api-versions` from the profile, so
   * `.Capabilities` reflects the declared cluster instead of whatever the
   * helm binary defaults to. A named profile the config does not declare is
   * an error at synth, never a silent fallback. Absent, rendering is
   * unpinned — exactly today's behavior.
   */
  capabilityProfile?: HelmCapabilityProfileRef;
  /**
   * Whether this render persists to the content-addressed render store
   * (#1238) — canonical bytes under their `contentDigest` plus a
   * `RenderManifest`, in `~/.chant/helm-renders/sha256-<hex>/` (see
   * ./render-store.ts).
   *
   * Only a pinned render (capabilityProfile present) can persist — an
   * unpinned render has no content identity, and `persist: true` on one is
   * a synth error naming that reason. For pinned renders the default
   * follows the cache knob: persistence is on unless `noCache` is set
   * (`noCache: true` + `persist: true` forces a fresh render that is still
   * persisted; `persist: false` turns the store off entirely).
   */
  persist?: boolean;
  /**
   * Source ref/commit to record in the persisted `RenderManifest`, when the
   * caller has one. Never resolved implicitly and never fabricated — absent
   * means the manifest records `sourceRef: null`.
   */
  sourceRef?: string;
}

/**
 * What one `HelmRender` invocation recorded about itself. `capabilityProfile`
 * is the profile identity the render was pinned against; `undefined` means
 * the render was unpinned and its bytes depend on the local helm binary's
 * defaults.
 *
 * Pinned renders (profile present — the v1 gate, see #1237) also carry the
 * digest pair:
 *
 * - `inputDigest` — `sha256:` over the canonical JSON of the declared inputs
 *   (chart reference, version, values, capability facts). Shared with the
 *   release-ledger digest #1243 records on deploy, via `helmInputDigest`.
 *   Answers "same inputs?" without touching any bytes.
 * - `contentDigest` — `sha256:` over the canonical rendered bytes
 *   (`canonicalizeRender`). The artifact identity: answers "same bytes on
 *   the cluster?".
 *
 * They diverge exactly when the render is not a function of its declared
 * inputs — `renderStability` in ./render-digest.ts names that.
 *
 * Unpinned renders record neither digest. Their bytes are a function of the
 * local helm binary's defaulted capabilities, so a digest over them would
 * assert an identity the render does not have — it would differ across
 * machines that did nothing differently, and equal digests would still
 * prove nothing about a cluster. No digest is the honest record.
 */
export interface HelmRenderRecord {
  /** The render's logical name (`HelmRenderProps.name`) — also the helm release name baked into the bytes. */
  name: string;
  chart: string;
  version?: string;
  capabilityProfile?: HelmCapabilityProfile;
  /** Input-side identity (#1237/#1243). Present only for pinned renders. */
  inputDigest?: string;
  /** Content-side identity over canonical rendered bytes (#1237). Present only for pinned renders. */
  contentDigest?: string;
}

const renderRecords: HelmRenderRecord[] = [];

/** Every render recorded in this process, in invocation order. */
export function getHelmRenderRecords(): readonly HelmRenderRecord[] {
  return renderRecords;
}

/** Reset the record list (test isolation). */
export function clearHelmRenderRecords(): void {
  renderRecords.length = 0;
}

interface RenderedDoc {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; [k: string]: unknown };
  [k: string]: unknown;
}

const CACHE_ROOT = join(homedir(), ".chant", "helm-renders");

/**
 * Legacy cache key — truncated, unprefixed, input-derived. Since #1238 this
 * keys only *unpinned* renders (and names the values tempfile): pinned
 * renders live in the content-addressed store (./render-store.ts) under
 * their full `sha256:` contentDigest, with the inputs index providing cache
 * hits. Existing truncated-hash entries stay where they are — a new root,
 * not a migration.
 */
function cacheKey(props: HelmRenderProps, profile?: HelmCapabilityProfile): string {
  const stable = JSON.stringify({
    repo: props.repo,
    chart: props.chart,
    version: props.version,
    namespace: props.namespace ?? null,
    values: props.values ?? null,
    // Only present for pinned renders (which no longer read this cache but
    // still name their values tempfile with this key). A pinned render must
    // never reuse an unpinned render's bytes (or another profile's) — the
    // profile is a real render input (#1235).
    ...(profile
      ? {
          capabilityProfile: {
            name: profile.name,
            kubeVersion: profile.kubeVersion,
            apiVersions: profile.apiVersions ?? [],
          },
        }
      : {}),
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

/**
 * Version of the local helm binary, for the persisted `RenderManifest`.
 * Load-bearing there — the defaulted kube version is a property of the
 * binary, so this field explains a digest mismatch between machines. Never
 * fails a build: `"unknown"` when helm cannot answer.
 */
function helmBinaryVersion(): string {
  try {
    const out = execFileSync("helm", ["version", "--template", "{{.Version}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().split("\n")[0] || "unknown";
  } catch {
    return "unknown";
  }
}

function renderViaHelm(props: HelmRenderProps, profile?: HelmCapabilityProfile): string {
  // Write values overrides to a tempfile if any.
  let valuesArgs: string[] = [];
  if (props.values && Object.keys(props.values).length > 0) {
    const valuesPath = join(tmpdir(), `chant-helm-values-${cacheKey(props, profile)}.yaml`);
    writeFileSync(valuesPath, yaml.dump(props.values));
    valuesArgs = ["--values", valuesPath];
  }

  // When `repo` is set, helm fetches the chart by name+version from the repo.
  // When `repo` is absent, treat `chart` as a local path.
  const fetchArgs: string[] = [];
  if (props.repo) {
    fetchArgs.push("--repo", props.repo);
    if (props.version) fetchArgs.push("--version", props.version);
  }

  // When --repo is set, isolate helm's repository config + cache to a
  // chant-private directory. Without this, helm tries to refresh ALL of the
  // user's existing repo indexes (eks, jetstack, etc.) and fails with
  // "no cached repo found" if any one has gone stale — even though we
  // only care about the single repo the consumer asked for.
  const isolationArgs: string[] = props.repo
    ? [
        "--repository-config",
        "/dev/null",
        "--repository-cache",
        join(CACHE_ROOT, "_helm-repo-cache"),
      ]
    : [];

  const args = [
    "template",
    props.name,
    props.chart,
    // Without this, `helm template` silently drops manifests shipped in the
    // chart's (or a subchart's) crds/ directory.
    "--include-crds",
    // Pin .Capabilities to the declared cluster profile. Without these, the
    // kube version defaults to one baked into the helm binary and APIVersions
    // is empty — both silently, both making the rendered bytes a function of
    // the local toolchain (#1235).
    ...(profile
      ? [
          "--kube-version",
          profile.kubeVersion,
          ...(profile.apiVersions ?? []).flatMap((v) => ["--api-versions", v]),
        ]
      : []),
    ...fetchArgs,
    ...isolationArgs,
    ...(props.namespace ? ["--namespace", props.namespace] : []),
    ...valuesArgs,
  ];

  try {
    const out = execFileSync("helm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return out;
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr)
        : String(err);
    throw new Error(
      `HelmRender failed for ${props.repo}/${props.chart}@${props.version}:\n${stderr}\n` +
        `Hint: ensure the 'helm' CLI is on PATH (helm version) and the chart is reachable.`,
    );
  }
}

function loadOrRender(props: HelmRenderProps, profile?: HelmCapabilityProfile): string {
  if (props.noCache) {
    return renderViaHelm(props, profile);
  }
  const cacheDir = join(CACHE_ROOT, cacheKey(props, profile));
  const cachePath = join(cacheDir, "manifests.yaml");
  if (existsSync(cachePath)) {
    return readFileSync(cachePath, "utf8");
  }
  const out = renderViaHelm(props, profile);
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, out);
  } catch {
    // Cache write failure is non-fatal — the render is still in memory.
  }
  return out;
}

/**
 * The pinned render path (#1238): the content-addressed store is both the
 * cache and the durable record.
 *
 * Read: unless `noCache` (or `persist: false`) is set, the full-inputs
 * cache key resolves through the store's inputs index to canonical bytes a
 * previous identical render stored — semantically identical to helm's
 * output (canonicalization only normalizes render noise) and byte-stable
 * under re-canonicalization, so digests recompute identically.
 *
 * Write: a fresh render persists { canonical bytes, RenderManifest } unless
 * the caller opted out — the manifest is written alongside every pinned
 * render by default. `persist: true` with `noCache` still persists (a
 * forced-fresh render is still a durable artifact); a persist failure on
 * the default path is non-fatal like a legacy cache-write failure, but an
 * explicit `persist: true` surfaces it.
 */
function loadOrRenderPinned(props: HelmRenderProps, profile: HelmCapabilityProfile): string {
  const chartRef = props.repo ? `${props.repo}/${props.chart}` : props.chart;
  const storeRead = !props.noCache && props.persist !== false;
  const storeWrite = props.persist === true || (!props.noCache && props.persist !== false);
  const key = renderCacheKey({
    chart: chartRef,
    chartVersion: props.version,
    releaseName: props.name,
    namespace: props.namespace,
    values: props.values,
    capabilityProfile: profile,
  });

  if (storeRead) {
    const hit = findRenderByCacheKey(key);
    if (hit) {
      const content = loadRenderContent(hit.contentDigest);
      if (content !== undefined) return content;
      // Index points at pruned/corrupt content — fall through and re-render.
    }
  }

  const out = renderViaHelm(props, profile);
  if (storeWrite) {
    try {
      persistHelmRender({
        rendered: out,
        releaseName: props.name,
        chart: props.chart,
        repo: props.repo || undefined,
        chartVersion: props.version,
        namespace: props.namespace,
        values: props.values,
        capabilityProfile: profile,
        helmVersion: helmBinaryVersion(),
        sourceRef: props.sourceRef,
      });
    } catch (err) {
      if (props.persist === true) throw err;
      // Default-on persistence degrades like a legacy cache-write failure:
      // the render is still in memory and the build goes on.
    }
  }
  return out;
}

function parseMultiDoc(text: string): RenderedDoc[] {
  const docs = yaml.loadAll(text);
  return docs
    .filter((d): d is RenderedDoc => d !== null && typeof d === "object")
    .filter((d) => d.kind && d.apiVersion);
}

/**
 * Sanitize an arbitrary string into a valid TS/JS identifier suffix.
 * Used to derive Composite Members keys from manifest kind+name pairs.
 */
function safeKey(input: string): string {
  return input.replace(/[^a-zA-Z0-9_]/g, "_");
}

export const HelmRender = Composite<HelmRenderProps>((props) => {
  // Resolve first: a named profile the config does not declare must fail the
  // build here, before any helm invocation could silently render against the
  // binary's default capabilities.
  const profile = props.capabilityProfile !== undefined ? resolveCapabilityProfile(props.capabilityProfile) : undefined;

  if (!profile && props.persist === true) {
    throw new Error(
      `HelmRender "${props.name}": persist requires a pinned render, and this one is unpinned ` +
        `(no capabilityProfile declared). An unpinned render's bytes are a function of the local ` +
        `helm binary's defaulted capabilities, so they have no stable content identity to store ` +
        `under. Declare capabilityProfile to pin the render (#1235), or drop persist.`,
    );
  }

  const yamlText = profile ? loadOrRenderPinned(props, profile) : loadOrRender(props, undefined);
  const docs = parseMultiDoc(yamlText);

  // Digests are recorded only for pinned renders (#1237). Profile presence
  // is the v1 gate: the classifier (#1234) needs the chart source on disk,
  // which a repo-fetched render does not keep, so the gate here is the
  // declared-inputs property, not a template analysis. An unpinned render's
  // digest would be a function of the local helm binary — meaningless as an
  // identity — so unpinned renders record neither digest.
  const digests = profile
    ? {
        inputDigest: helmInputDigest({
          // Same chart-reference convention helmInstall digests: a local
          // path stays itself; a repo-fetched chart is `<repo-url>/<chart>`.
          chart: props.repo ? `${props.repo}/${props.chart}` : props.chart,
          chartVersion: props.version,
          values: props.values ?? {},
          capabilityProfile: {
            kubeVersion: profile.kubeVersion,
            apiVersions: profile.apiVersions,
          },
        }),
        contentDigest: helmContentDigest(yamlText),
      }
    : {};

  renderRecords.push({
    name: props.name,
    chart: props.chart,
    version: props.version,
    capabilityProfile: profile,
    ...digests,
  });

  const out: Record<string, InstanceType<typeof Deployment>> = {};

  if (props.createNamespace && props.namespace) {
    out["__namespace"] = new Deployment({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: props.namespace },
    } as Record<string, unknown>);
  }

  const usedKeys = new Set<string>();
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const kind = doc.kind ?? "Unknown";
    const name = doc.metadata?.name ?? `doc${i}`;
    let key = safeKey(`${kind}_${name}`);
    // Disambiguate on collision (e.g. same kind+name across docs).
    let collisionN = 2;
    while (usedKeys.has(key)) {
      key = `${safeKey(`${kind}_${name}`)}_${collisionN++}`;
    }
    usedKeys.add(key);
    out[key] = new Deployment(doc as Record<string, unknown>);
  }

  return out;
}, "HelmRender");
