/**
 * The upstream collector schemas, read at the pinned tags (#3361).
 *
 * Three repositories, all read at git tags:
 *
 * - opentelemetry-collector-releases, for each distribution's builder manifest
 *   (`distributions/<name>/manifest.yaml`): which component modules a given
 *   `otelcol` binary is built from, and at which version;
 * - opentelemetry-collector (`go.opentelemetry.io/collector/...`) and
 *   opentelemetry-collector-contrib, for each component's `metadata.yaml` (its
 *   collector type, and the deprecated type it still answers to) and its
 *   `config.schema.yaml`, plus every schema document those reach through
 *   `$ref` (the shared `config/*` packages, `exporterhelper`, contrib's
 *   `internal/*` and `pkg/*`).
 *
 * Downloads go through core's `fetchWithCache` under `~/.chant/otel-spec/<tag>`,
 * with a long TTL, because a tag's content never moves. This module only runs
 * when the snapshot is refreshed (`just snapshot`); generation reads the
 * committed snapshot and never touches the network.
 *
 * ## `$ref` forms
 *
 * `schemagen` writes four:
 *
 * - `name`, a definition in the same document's `$defs`;
 * - `./internal/metadata.name`, a package below the referring document's;
 * - `/config/configgrpc.client_config`, a package path from the root of the
 *   referring document's repository;
 * - `go.opentelemetry.io/collector/config/configopaque.string`, a full Go
 *   import path.
 *
 * Every form ends in `.<definition>`; {@link resolveRef} turns each into a
 * document key (the Go import path of the package) and a definition name.
 */

import { homedir } from "os";
import { join } from "path";
import yaml from "js-yaml";
import { fetchWithCache } from "@intentius/chant/codegen/fetch";
import type { ComponentKind } from "../model";

export const CORE_MODULE = "go.opentelemetry.io/collector";
export const CONTRIB_MODULE = "github.com/open-telemetry/opentelemetry-collector-contrib";

const REPOS: ReadonlyArray<{ module: string; repo: string }> = [
  { module: CONTRIB_MODULE, repo: "open-telemetry/opentelemetry-collector-contrib" },
  { module: CORE_MODULE, repo: "open-telemetry/opentelemetry-collector" },
];

/** The distributions whose manifests scope the lexicon. */
export const DISTRIBUTIONS = ["otelcol-contrib", "otelcol-k8s"] as const;
export type DistributionName = (typeof DISTRIBUTIONS)[number];

/** A tag's content never moves, so a cached copy stays good for a year. */
const TAG_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function cacheFile(repo: string, tag: string, path: string): string {
  return join(homedir(), ".chant", "otel-spec", repo.split("/")[1], tag, ...path.split("/"));
}

function rawUrl(repo: string, tag: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${tag}/${path}`;
}

// ── Manifests ───────────────────────────────────────────────────────

/** One component module a distribution is built from. */
export interface ManifestModule {
  kind: ComponentKind;
  /** The Go module path, e.g. `go.opentelemetry.io/collector/receiver/otlpreceiver`. */
  module: string;
  /** The module version the manifest names, e.g. `v0.162.0`. */
  version: string;
}

const SECTION_KIND: Record<string, ComponentKind> = {
  receivers: "receiver",
  processors: "processor",
  exporters: "exporter",
  connectors: "connector",
  extensions: "extension",
};

/**
 * The component modules a builder manifest lists. `providers` (confmap URI
 * schemes) are not components and are left out.
 */
export function parseManifest(text: string): ManifestModule[] {
  const doc = yaml.load(text) as Record<string, unknown>;
  const out: ManifestModule[] = [];
  for (const [section, kind] of Object.entries(SECTION_KIND)) {
    const entries = doc[section];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Array<{ gomod?: string }>) {
      const [module, version] = (entry.gomod ?? "").trim().split(/\s+/);
      if (module && version) out.push({ kind, module, version });
    }
  }
  return out;
}

// ── Where a Go package lives ────────────────────────────────────────

/** The repository and tag a module's files are read from, or undefined for a module outside the two collector repos. */
export function locate(
  pkg: string,
  tags: { core: string; contrib: string },
): { repo: string; tag: string; path: string; root: string } | undefined {
  for (const { module, repo } of REPOS) {
    if (pkg === module || pkg.startsWith(`${module}/`)) {
      return { repo, tag: module === CORE_MODULE ? tags.core : tags.contrib, path: pkg.slice(module.length + 1), root: module };
    }
  }
  return undefined;
}

/** The repository root module a package belongs to, for resolving `/path` refs. */
export function repoRoot(pkg: string): string | undefined {
  return REPOS.find(({ module }) => pkg === module || pkg.startsWith(`${module}/`))?.module;
}

/**
 * Resolve a `$ref` written in document `from` (a Go package path) to the
 * document it names and the definition inside it. A local ref returns `from`
 * itself.
 */
export function resolveRef(from: string, ref: string): { doc: string; def: string } {
  const dot = ref.lastIndexOf(".");
  const slash = ref.lastIndexOf("/");
  // `name`: no package part.
  if (slash < 0 && !ref.startsWith(".")) return { doc: from, def: ref };
  const pkgPart = dot > slash ? ref.slice(0, dot) : ref;
  const def = dot > slash ? ref.slice(dot + 1) : "";
  let doc: string;
  if (pkgPart.startsWith("./")) doc = `${from}/${pkgPart.slice(2)}`;
  else if (pkgPart.startsWith("/")) doc = `${repoRoot(from) ?? ""}${pkgPart}`;
  else doc = pkgPart;
  return { doc, def };
}

/** Every `$ref` string inside a schema document, in order. */
export function refsIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) refsIn(n, out);
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else refsIn(v, out);
    }
  }
  return out;
}

// ── Fetching ────────────────────────────────────────────────────────

async function fetchText(repo: string, tag: string, path: string, force?: boolean): Promise<string | undefined> {
  try {
    const buf = await fetchWithCache(
      { url: rawUrl(repo, tag, path), cacheFile: cacheFile(repo, tag, path), cacheTtlMs: TAG_TTL_MS },
      force,
    );
    return buf.toString("utf-8");
  } catch (err) {
    // A missing file is an answer (this component ships no schema); anything
    // else is not, and must not be read as one.
    if (err instanceof Error && /returned 404\b/.test(err.message)) return undefined;
    throw err;
  }
}

/** One component in a distribution's index. */
export interface IndexedComponent {
  kind: ComponentKind;
  /** The collector type its factory registers, from `metadata.yaml`. Absent for a module outside the collector repos. */
  type?: string;
  /** The older type the factory still accepts, when it was renamed. */
  deprecatedType?: string;
  module: string;
  version: string;
  /** The document key of its config schema, when upstream ships one. */
  schema?: string;
}

/** What `fetchUpstreamSpec` returns, and what the committed snapshot holds. */
export interface OtelSpecSnapshot {
  versions: { "otelcol-contrib": string; "otelcol-k8s": string; core: string; contrib: string };
  distributions: Record<DistributionName, IndexedComponent[]>;
  /** Schema documents keyed by Go package path. */
  schemas: Record<string, unknown>;
  /** `$ref`ed documents that could not be read, and who asked for them. */
  unresolved: Record<string, string[]>;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** The version a manifest uses for the modules of one repository, the most common one listed. */
function repoTag(modules: ManifestModule[], root: string): string {
  const counts = new Map<string, number>();
  for (const m of modules) if (m.module.startsWith(`${root}/`)) counts.set(m.version, (counts.get(m.version) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!best) throw new Error(`no ${root} module in the manifest`);
  return best[0];
}

/**
 * Fetch both manifests at their tags, index every component they list, and
 * collect the schema documents reachable from the components in `keep` (by
 * collector type and kind). Other components are indexed (type, schema or
 * not) but their schemas are not carried, so the snapshot stays the size of
 * what the lexicon generates from.
 */
export async function fetchUpstreamSpec(options: {
  contribVersion: string;
  k8sVersion: string;
  keep: ReadonlyArray<{ kind: ComponentKind; type: string }>;
  force?: boolean;
  log?: (message: string) => void;
}): Promise<OtelSpecSnapshot> {
  const log = options.log ?? (() => {});
  const releases = "open-telemetry/opentelemetry-collector-releases";
  const manifests = {} as Record<DistributionName, ManifestModule[]>;
  const distTags: Record<DistributionName, string> = { "otelcol-contrib": options.contribVersion, "otelcol-k8s": options.k8sVersion };
  for (const dist of DISTRIBUTIONS) {
    const text = await fetchText(releases, distTags[dist], `distributions/${dist}/manifest.yaml`, options.force);
    if (text === undefined) throw new Error(`no manifest for ${dist} at ${distTags[dist]}`);
    manifests[dist] = parseManifest(text);
    log(`${dist} ${distTags[dist]}: ${manifests[dist].length} components`);
  }

  const contribManifest = manifests["otelcol-contrib"];
  const tags = { core: repoTag(contribManifest, CORE_MODULE), contrib: repoTag(contribManifest, CONTRIB_MODULE) };

  // Index each distinct module once: its type, and where its schema is.
  const modules = new Map<string, ManifestModule>();
  for (const dist of DISTRIBUTIONS) for (const m of manifests[dist]) modules.set(m.module, m);
  const docs = new Map<string, unknown>();
  const info = new Map<string, { type?: string; deprecatedType?: string; schemaDoc?: string; schema?: unknown }>();
  await pool([...modules.values()], 16, async (m) => {
    const where = locate(m.module, tags);
    if (!where) {
      info.set(m.module, {});
      return;
    }
    const meta = await fetchText(where.repo, where.tag, `${where.path}/metadata.yaml`, options.force);
    const parsed = meta ? (yaml.load(meta) as { type?: string; deprecated_type?: string }) : {};
    // Most components keep their config in the module root; a few
    // (signaltometrics) in a `config` package below it.
    let schemaDoc: string | undefined;
    let schema: unknown;
    for (const sub of ["", "/config"]) {
      const text = await fetchText(where.repo, where.tag, `${where.path}${sub}/config.schema.yaml`, options.force);
      if (text !== undefined) {
        schemaDoc = `${m.module}${sub}`;
        schema = yaml.load(text);
        break;
      }
    }
    info.set(m.module, { type: parsed.type, deprecatedType: parsed.deprecated_type, schemaDoc, schema });
  });

  const distributions = {} as Record<DistributionName, IndexedComponent[]>;
  for (const dist of DISTRIBUTIONS) {
    distributions[dist] = manifests[dist]
      .map((m) => {
        const i = info.get(m.module)!;
        const entry: IndexedComponent = { kind: m.kind, module: m.module, version: m.version };
        if (i.type) entry.type = i.type;
        if (i.deprecatedType) entry.deprecatedType = i.deprecatedType;
        if (i.schemaDoc) entry.schema = i.schemaDoc;
        return entry;
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || (a.type ?? a.module).localeCompare(b.type ?? b.module));
  }

  // The documents the kept components reach, transitively.
  const unresolved: Record<string, string[]> = {};
  const queue: string[] = [];
  for (const want of options.keep) {
    const hit = distributions["otelcol-contrib"].find(
      (c) => c.kind === want.kind && (c.type === want.type || c.deprecatedType === want.type),
    );
    if (!hit?.schema) continue;
    docs.set(hit.schema, info.get(hit.module)!.schema);
    queue.push(hit.schema);
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const batch = queue.splice(0).filter((d) => !seen.has(d));
    for (const d of batch) seen.add(d);
    const wanted = new Map<string, string[]>();
    for (const d of batch) {
      for (const ref of refsIn(docs.get(d))) {
        const { doc } = resolveRef(d, ref);
        if (doc === d || docs.has(doc) || seen.has(doc)) continue;
        wanted.set(doc, [...(wanted.get(doc) ?? []), d]);
      }
    }
    await pool([...wanted.keys()], 16, async (doc) => {
      const where = locate(doc, tags);
      const text = where ? await fetchText(where.repo, where.tag, `${where.path}/config.schema.yaml`, options.force) : undefined;
      if (text === undefined) {
        unresolved[doc] = [...new Set(wanted.get(doc))].sort();
        return;
      }
      docs.set(doc, yaml.load(text));
      queue.push(doc);
    });
  }

  const schemas: Record<string, unknown> = {};
  for (const key of [...docs.keys()].sort()) schemas[key] = docs.get(key);
  const sortedUnresolved: Record<string, string[]> = {};
  for (const key of Object.keys(unresolved).sort()) sortedUnresolved[key] = unresolved[key];
  return {
    versions: { "otelcol-contrib": options.contribVersion, "otelcol-k8s": options.k8sVersion, ...tags },
    distributions,
    schemas,
    unresolved: sortedUnresolved,
  };
}
