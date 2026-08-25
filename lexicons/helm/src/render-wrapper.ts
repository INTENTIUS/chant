/**
 * Structure-preserving render wrapper (#1239, epic #1228 Phase 3).
 *
 * Turns a pinned render's document stream into chant-shaped routing groups
 * WITHOUT restructuring the documents. Structure-preserving means the bytes
 * that deploy are the bytes the render store recorded — this module only
 * routes and labels; it never re-serializes, reorders lines, or edits a
 * document. Each `RoutedDocument.text` is the exact document text from the
 * input stream.
 *
 * Routing is by origin, not by kind. `helm template` stamps every document
 * with `# Source: <chart>/<path>`, and the discriminator is whether that
 * path contains a `crds/` **segment** (`(^|/)crds/` — `isCrdSource` from
 * the #1234 classifier seeds):
 *
 * - A `crds/`-segment origin routes to the CRD group — the wrapper's
 *   `crds/`. Segment matching is load-bearing: a subchart's CRDs arrive as
 *   `charts/<child>/crds/<file>`, so a prefix rule catches none of them and
 *   would route every subchart CRD into `templates/`, making it deletable
 *   on uninstall (epic findings 4, 10 — the A/B test showed a flat wrap
 *   converts `helm uninstall` from safe to data-destroying).
 * - A hook-annotated template document (`helm.sh/hook` in
 *   `metadata.annotations`) routes to its own group, annotations intact.
 *   Hooks survive pinning (epic finding 5); they are surfaced separately so
 *   the install path can account for them, never silently dropped.
 * - Everything else routes to the main group — the wrapper's `templates/`.
 *   A template-rendered `CustomResourceDefinition` stays here, because the
 *   `crds/`-segment is the discriminator, not the kind: a chart that
 *   templates its CRDs opted into template lifecycle semantics (upgrades
 *   and deletes apply to them), and moving them to `crds/` would change
 *   that. The routing notes it with a warning so the choice is visible.
 *
 * Aliased dependencies emit duplicate CRDs (epic finding 11): the same
 * dependency included twice under an alias renders its `crds/` once per
 * instance — two documents, one distinct CRD. The stored artifact keeps
 * both (canonicalization is order- and duplicate-preserving), but a wrapper
 * chart's `crds/` holds each CRD once, so the routed CRD group deduplicates
 * by `(group, kind)`: the first occurrence wins and a warning names both
 * sources. A CRD document that cannot be identified (unparseable, or
 * missing `spec.group` / `spec.names.kind`) is never deduplicated — the
 * routing must not silently drop what it cannot identify.
 *
 * The wrapper inherits the source chart's name and version (epic
 * Decisions), keeping `helm history` continuous across the pinned
 * migration; `RoutedRender.chart` / `chartVersion` carry them.
 *
 * This is the seam the pinned-install path (#1242) consumes:
 * `routeStoredRender(contentDigest)` loads a stored render's canonical
 * bytes and manifest and routes them.
 */

import yaml from "js-yaml";

import { isCrdSource, sourcePath, splitDocuments } from "./pinnability/render-stream";
import { loadRenderContent, loadRenderManifest } from "./render-store";

// ── routed shapes ─────────────────────────────────────────────────────────

/** One routed document: exact bytes plus the labels routing derived from them. */
export interface RoutedDocument {
  /**
   * The document's exact text from the input stream (from just past the
   * `---` separator, trimmed of surrounding blank lines — the same split
   * `splitDocuments` performs). Never re-serialized: what deploys is what
   * was recorded.
   */
  text: string;
  /**
   * Chart-relative `# Source:` origin path (e.g. `crds/a.yaml`,
   * `charts/kid/crds/kidcrd.yaml`), or `null` when the document carries no
   * source header.
   */
  source: string | null;
  /** Kubernetes kind, or `null` when the document does not parse to a kinded object. */
  kind: string | null;
  /** apiVersion as rendered, or `null`. */
  apiVersion: string | null;
  /** `metadata.name`, or `null`. */
  name: string | null;
}

/** Machine-readable warning categories the routing emits. */
export type RoutedRenderWarningCode = "duplicate-crd" | "template-crd";

export interface RoutedRenderWarning {
  /**
   * - `duplicate-crd` — an aliased dependency emitted the same CRD twice;
   *   the first occurrence was kept, the duplicate dropped. The message
   *   names both sources.
   * - `template-crd` — a `CustomResourceDefinition` was rendered from
   *   `templates/` (no `crds/` segment in its origin). It stays in the main
   *   group per the segment rule; this note makes the lifecycle choice
   *   visible.
   */
  code: RoutedRenderWarningCode;
  message: string;
}

/**
 * A pinned render routed into the structure the wrapper chart preserves.
 * The document groups partition the input stream (minus deduplicated CRD
 * duplicates, each named in `warnings`); no document is ever silently
 * dropped and no document text is ever altered.
 */
export interface RoutedRender {
  /**
   * Wrapper chart name — inherited from the source chart, so `helm history`
   * stays continuous across the pinned migration (epic Decisions).
   */
  chart: string;
  /** Wrapper chart version — inherited from the source chart; `null` for a local chart rendered without one. */
  chartVersion: string | null;
  /**
   * Documents whose origin has a `crds/` segment — the wrapper's `crds/`,
   * which is what keeps `helm uninstall` from deleting them (epic finding
   * 4). Deduplicated by `(group, kind)`, first occurrence winning.
   */
  crds: RoutedDocument[];
  /**
   * Hook-annotated template documents (`helm.sh/hook`), annotations intact.
   * Routed as their own group so the install path can account for them —
   * never silently dropped (epic finding 5).
   */
  hooks: RoutedDocument[];
  /** Everything else — the wrapper's `templates/`. */
  main: RoutedDocument[];
  /** What routing had to decide beyond the mechanical rule: dropped duplicates, template-rendered CRDs. */
  warnings: RoutedRenderWarning[];
}

// ── routing ───────────────────────────────────────────────────────────────

interface ParsedDoc {
  kind: string | null;
  apiVersion: string | null;
  name: string | null;
  hook: boolean;
  crdKey: string | null;
}

const CRD_KIND = "CustomResourceDefinition";

/**
 * Parse a document just far enough to label it. Parsing is for labels only —
 * the routed text is always the original bytes. An unparseable document
 * labels as `null`s and routes to the main group.
 */
function parseForLabels(doc: string): ParsedDoc {
  let parsed: unknown;
  try {
    parsed = yaml.load(doc);
  } catch {
    return { kind: null, apiVersion: null, name: null, hook: false, crdKey: null };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: null, apiVersion: null, name: null, hook: false, crdKey: null };
  }
  const obj = parsed as {
    kind?: unknown;
    apiVersion?: unknown;
    metadata?: { name?: unknown; annotations?: Record<string, unknown> };
    spec?: { group?: unknown; names?: { kind?: unknown } };
  };
  const kind = typeof obj.kind === "string" ? obj.kind : null;
  const annotations = obj.metadata?.annotations;
  const hook =
    annotations !== null &&
    typeof annotations === "object" &&
    Object.prototype.hasOwnProperty.call(annotations, "helm.sh/hook");
  let crdKey: string | null = null;
  if (kind === CRD_KIND) {
    const group = obj.spec?.group;
    const namesKind = obj.spec?.names?.kind;
    if (typeof group === "string" && typeof namesKind === "string") {
      crdKey = `${group}/${namesKind}`;
    }
  }
  return {
    kind,
    apiVersion: typeof obj.apiVersion === "string" ? obj.apiVersion : null,
    name: typeof obj.metadata?.name === "string" ? obj.metadata.name : null,
    hook,
    crdKey,
  };
}

export interface RouteRenderOptions {
  /** Source chart name — becomes the wrapper's name. */
  chart: string;
  /** Source chart version — becomes the wrapper's version. */
  chartVersion?: string | null;
}

/**
 * Route a rendered stream (canonical or raw `helm template` output) into
 * `RoutedRender` groups. Pure over the stream: no store access, no helm.
 */
export function routeRender(rendered: string, opts: RouteRenderOptions): RoutedRender {
  const routed: RoutedRender = {
    chart: opts.chart,
    chartVersion: opts.chartVersion ?? null,
    crds: [],
    hooks: [],
    main: [],
    warnings: [],
  };
  const firstCrdByKey = new Map<string, RoutedDocument>();

  for (const text of splitDocuments(rendered)) {
    const source = sourcePath(text) ?? null;
    const labels = parseForLabels(text);
    const doc: RoutedDocument = {
      text,
      source,
      kind: labels.kind,
      apiVersion: labels.apiVersion,
      name: labels.name,
    };

    if (source !== null && isCrdSource(source)) {
      if (labels.crdKey !== null) {
        const first = firstCrdByKey.get(labels.crdKey);
        if (first) {
          routed.warnings.push({
            code: "duplicate-crd",
            message:
              `duplicate CRD ${labels.crdKey}: keeping ${first.source ?? "<no source>"}, ` +
              `dropping ${source} (an aliased dependency emits the same CRD once per instance; ` +
              `a wrapper chart's crds/ holds it once, matching what helm installs)`,
          });
          continue;
        }
        firstCrdByKey.set(labels.crdKey, doc);
      }
      routed.crds.push(doc);
      continue;
    }

    if (labels.kind === CRD_KIND) {
      // Template-rendered CRD: the crds/-segment is the discriminator, not
      // the kind. It stays in its rendered group with template lifecycle
      // semantics — noted, never moved.
      routed.warnings.push({
        code: "template-crd",
        message:
          `CustomResourceDefinition ${labels.name ?? "<unnamed>"} is template-rendered ` +
          `(source: ${source ?? "<none>"}), not shipped in crds/ — it stays in the main set ` +
          `with template lifecycle semantics: helm upgrades and deletes will apply to it`,
      });
    }

    (labels.hook ? routed.hooks : routed.main).push(doc);
  }

  return routed;
}

/**
 * Route a stored pinned render by its `contentDigest`: loads the canonical
 * bytes and the `RenderManifest` from the render store (#1238) and routes
 * them, inheriting the manifest's chart name and version. This is the seam
 * the pinned-install path (#1242) consumes. `undefined` when the store has
 * no such entry.
 */
export function routeStoredRender(
  contentDigest: string,
  opts?: { root?: string },
): RoutedRender | undefined {
  const manifest = loadRenderManifest(contentDigest, opts);
  if (!manifest) return undefined;
  const content = loadRenderContent(contentDigest, opts);
  if (content === undefined) return undefined;
  return routeRender(content, { chart: manifest.chart, chartVersion: manifest.chartVersion });
}
