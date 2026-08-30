/**
 * Wrapper-chart materialization for the pinned install path (#1242, epic
 * #1228 Phase 4).
 *
 * Turns a `RoutedRender` (#1239) into an installable helm chart on disk.
 * The wrapper preserves the recorded bytes exactly:
 *
 * - CRD-group documents are written verbatim into the wrapper's `crds/`,
 *   which is what keeps `helm uninstall` from deleting them — the A/B test
 *   behind epic finding 4 showed a flat wrap converts uninstall from safe
 *   to data-destroying.
 * - Every other document (main and hook groups) is written verbatim into
 *   `manifests/`, and each gets a one-line shim in `templates/` that reads
 *   it back with `.Files.Get`. The shim exists because rendered output can
 *   legitimately contain template-looking text — a ConfigMap carrying
 *   alertmanager notification templates renders `{{ $labels }}` as literal
 *   bytes — and a document placed directly in `templates/` would be run
 *   through the template engine a second time, mangling or failing on
 *   exactly those bytes. `.Files.Get` returns file content untemplated, so
 *   what helm installs is what the render store recorded.
 * - Hook documents go through the same shim; their `helm.sh/hook`
 *   annotations are part of the recorded bytes, so helm registers and runs
 *   them from the rendered output unchanged (epic finding 5).
 *
 * The wrapper inherits the source chart's name and version (epic
 * Decisions), keeping `helm history` continuous across the pinned
 * migration. A local chart path becomes its sanitized basename — helm
 * requires a bare chart name — and a render recorded without a version
 * falls back to `0.0.0`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RoutedDocument, RoutedRender } from "./render-wrapper";

/** What `materializeWrapperChart` wrote, with the counts the install result reports. */
export interface MaterializedWrapperChart {
  /** Chart root directory — the `helm upgrade --install` argument. */
  dir: string;
  /** Wrapper chart name (sanitized from the source chart reference). */
  chartName: string;
  /** Wrapper chart version (`0.0.0` when the render recorded none). */
  chartVersion: string;
  /** Files written under `crds/`, chart-relative. */
  crdFiles: string[];
  /** Verbatim document files written under `manifests/`, chart-relative, in emit order. */
  manifestFiles: string[];
  /** Number of hook documents among `manifestFiles`. */
  hookCount: number;
}

/**
 * A valid helm chart name from a chart reference that may be a local path
 * (`./charts/web`) or a repo-qualified name. Takes the last path segment,
 * lowercases it, and collapses anything outside `[a-z0-9-]` to `-` — helm
 * chart names are DNS-label-shaped. Falls back to `pinned-chart` when
 * nothing survives.
 */
export function wrapperChartName(chart: string): string {
  const base = chart.split("/").filter((s) => s.length > 0).pop() ?? "";
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "pinned-chart";
}

/** `doc-0007-my-deployment` — a stable, ordered, filesystem-safe stem for one routed document. */
function fileStem(prefix: string, index: number, doc: RoutedDocument): string {
  const label = (doc.name ?? doc.kind ?? "document")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${prefix}-${String(index).padStart(4, "0")}${label ? `-${label}` : ""}`;
}

/**
 * Write `routed` as an installable wrapper chart under `dir` (which must
 * exist and should be empty). Document text is written byte-for-byte; the
 * only authored files are `Chart.yaml` and the `.Files.Get` shims.
 */
export function materializeWrapperChart(routed: RoutedRender, dir: string): MaterializedWrapperChart {
  const chartName = wrapperChartName(routed.chart);
  const chartVersion = routed.chartVersion ?? "0.0.0";

  writeFileSync(
    join(dir, "Chart.yaml"),
    [
      "apiVersion: v2",
      `name: ${chartName}`,
      `version: ${chartVersion}`,
      "description: chant pinned render wrapper (epic #1228) — installs recorded bytes; templates are .Files.Get shims and are never re-rendered",
      "",
    ].join("\n"),
  );

  const crdFiles: string[] = [];
  if (routed.crds.length > 0) {
    mkdirSync(join(dir, "crds"), { recursive: true });
    routed.crds.forEach((doc, i) => {
      const rel = `crds/${fileStem("crd", i, doc)}.yaml`;
      writeFileSync(join(dir, rel), doc.text.endsWith("\n") ? doc.text : `${doc.text}\n`);
      crdFiles.push(rel);
    });
  }

  const manifestFiles: string[] = [];
  const docs = [...routed.main, ...routed.hooks];
  if (docs.length > 0) {
    mkdirSync(join(dir, "manifests"), { recursive: true });
    mkdirSync(join(dir, "templates"), { recursive: true });
    docs.forEach((doc, i) => {
      const stem = fileStem("doc", i, doc);
      const rel = `manifests/${stem}.yaml`;
      writeFileSync(join(dir, rel), doc.text.endsWith("\n") ? doc.text : `${doc.text}\n`);
      writeFileSync(join(dir, `templates/${stem}.yaml`), `{{ .Files.Get "${rel}" }}\n`);
      manifestFiles.push(rel);
    });
  }

  return { dir, chartName, chartVersion, crdFiles, manifestFiles, hookCount: routed.hooks.length };
}
