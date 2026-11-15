/**
 * The kustomize renderer (#1548) — one implementation, two consumers.
 *
 * Piece 1 (`components/kustomize-apply.ts`) renders at DEPLOY time in front
 * of the server-side applier; piece 3 (`./root.ts`) renders at BUILD time to
 * give an overlay estate a declared side. Both run the same command with the
 * same fallback through the same injectable runner, so a test asserts the
 * exact invocation without either binary installed and the two paths cannot
 * drift apart on how an overlay is rendered.
 *
 * Renderer resolution: `kustomize build`, falling back to `kubectl
 * kustomize` (the same renderer vendored into kubectl) when the standalone
 * binary is absent. When NEITHER binary exists the failure names both — a
 * missing renderer is an environment problem the operator can fix in one
 * install, and it must read as that, not as a stack trace. A render failure
 * from an existing binary (a broken overlay, a missing base) propagates
 * untouched: that error text is kustomize's own diagnosis and is strictly
 * better than anything this module could wrap it in.
 *
 * The 64MiB maxBuffer mirrors helm-upgrade's — a big overlay renders
 * megabytes.
 */
import { exec } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadAll } from "js-yaml";
import { readKustomizationFile } from "../helm-references";

const execAsync = promisify(exec);

/** Injectable shell runner — the helm-upgrade seam, same buffer bound. */
export type KustomizeRunner = (command: string) => Promise<{ stdout: string }>;

export const defaultKustomizeRunner: KustomizeRunner = (command) =>
  execAsync(command, { maxBuffer: 64 * 1024 * 1024 });

/** Single-quote shell escaping, as helm-upgrade quotes its argv. */
function q(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * Helm inflation for a render (#5112). A kustomization with `helmCharts` only
 * renders when kustomize is given `--enable-helm`, and kustomize then runs
 * `helm pull` for any chart that is not already in the chart home, which
 * reaches the network. Both are off until the caller asks.
 */
export interface KustomizeHelmOptions {
  /** Pass `--enable-helm`. Without it a kustomization that has `helmCharts` is refused with a message naming this option. */
  enableHelm?: boolean;
  /** The `helm` binary, passed as `--helm-command`. Unset, kustomize looks for `helm` on PATH. */
  helmCommand?: string;
  /** Let kustomize pull a chart that is not in the chart home. Unset, a chart that is missing fails naming the chart, and no network is used. Needs `enableHelm`. */
  fetchCharts?: boolean;
}

/** The exact render command, standalone binary first. Pure; exported for tests. */
export function renderCommand(dir: string, tool: "kustomize" | "kubectl" = "kustomize", helm: KustomizeHelmOptions = {}): string {
  const flags = helm.enableHelm ? ` --enable-helm${helm.helmCommand ? ` --helm-command ${q(helm.helmCommand)}` : ""}` : "";
  return tool === "kustomize" ? `kustomize build${flags} ${q(dir)}` : `kubectl kustomize${flags} ${q(dir)}`;
}

/**
 * A kustomization names a chart and the render was not allowed to inflate it
 * (`enableHelm` unset). A class of its own so the workspace graph reader tells
 * it from a render the binary ran and refused.
 */
export class KustomizeHelmDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KustomizeHelmDisabledError";
  }
}

/**
 * Helm inflation was asked for and a chart could not be had: it is not in the
 * chart home and `fetchCharts` is off, or helm failed on it. The member reader
 * keeps the Helm nodes it read as data when it sees this.
 */
export class KustomizeHelmRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KustomizeHelmRenderError";
  }
}

interface ChartEntry {
  /** The directory of the kustomization that names the chart. */
  dir: string;
  name: string;
  version: string;
  chartHome: string;
}

/** Every `helmCharts` entry of the kustomization at `dir` and of the local directories it lists in `resources`, `bases` and `components`. */
function helmChartEntries(dir: string, seen = new Set<string>()): ChartEntry[] {
  const root = resolve(dir);
  if (seen.has(root)) return [];
  seen.add(root);
  const read = readKustomizationFile(root);
  if (!read) return [];
  const { doc } = read;
  const entries: ChartEntry[] = [];
  const globals = doc.helmGlobals && typeof doc.helmGlobals === "object" && !Array.isArray(doc.helmGlobals) ? (doc.helmGlobals as Record<string, unknown>) : {};
  const home = typeof globals.chartHome === "string" && globals.chartHome !== "" ? globals.chartHome : "charts";
  for (const c of Array.isArray(doc.helmCharts) ? doc.helmCharts : []) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const e = c as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name === "") continue;
    entries.push({ dir: root, name: e.name, version: typeof e.version === "string" ? e.version : "", chartHome: isAbsolute(home) ? home : join(root, home) });
  }
  for (const key of ["resources", "bases", "components"]) {
    for (const item of Array.isArray(doc[key]) ? doc[key] : []) {
      if (typeof item !== "string" || /^[a-z][a-z0-9+.-]*:\/\//i.test(item) || item.includes("::") || item.startsWith("git@")) continue;
      const child = resolve(root, item);
      if (existsSync(child) && statSync(child).isDirectory()) entries.push(...helmChartEntries(child, seen));
    }
  }
  return entries;
}

const chartLabel = (c: ChartEntry): string => `"${c.name}"${c.version ? ` ${c.version}` : ""}`;

/**
 * Check a render's Helm settings before any subprocess runs. With inflation
 * off, a kustomization that has `helmCharts` is refused here, naming the
 * charts and the option. With it on and `fetchCharts` off, a chart that is
 * not in its chart home is refused naming the chart and the directory it is
 * expected in, so a render with no network says what is missing and never
 * starts a pull. Kustomizations the root lists are checked too.
 */
export function checkHelmOptions(dir: string, helm: KustomizeHelmOptions = {}): void {
  const charts = helmChartEntries(dir);
  if (charts.length === 0) return;
  if (!helm.enableHelm) {
    throw new KustomizeHelmDisabledError(
      `Kustomization "${dir}" names Helm charts (${charts.map(chartLabel).join(", ")}), which kustomize renders only with --enable-helm. ` +
        `Set enableHelm: true on the entry (k8s.kustomize.roots, or the member's k8s.member) to allow it; kustomize pulls a chart that is not in its chart home, so also set fetchCharts: true to allow the network.`,
    );
  }
  if (helm.fetchCharts) return;
  // kustomize uses `<chartHome>/<name>`, and puts a chart it pulled at `<chartHome>/<name>-<version>/<name>`.
  const missing = charts.filter((c) => !existsSync(join(c.chartHome, c.name)) && !(c.version && existsSync(join(c.chartHome, `${c.name}-${c.version}`, c.name))));
  if (missing.length > 0) {
    const first = missing[0]!;
    throw new KustomizeHelmRenderError(
      `Kustomization "${dir}" names Helm chart ${chartLabel(first)}${missing.length > 1 ? ` and ${missing.length - 1} more (${missing.slice(1).map(chartLabel).join(", ")})` : ""}, ` +
        `which is not in the chart home (${relative(resolve(dir), join(first.chartHome, first.name)) || "."} was expected), and fetching charts is off, so no network is used. ` +
        `Put the chart there, or set fetchCharts: true to let kustomize pull it from its repository.`,
    );
  }
}

/**
 * Neither `kustomize` nor `kubectl` is installed. A class of its own so a
 * caller that can say "not rendered, and why" (the workspace graph reader,
 * #3179) tells it from a render the binary ran and refused.
 */
export class KustomizeBinaryMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KustomizeBinaryMissingError";
  }
}

/** Does this error mean "the binary is not installed" (vs "the render failed")? */
function isMissingBinary(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Go's "exec: \"helm\": executable file not found" is kustomize reporting a missing helm, not a missing kustomize.
  if (/executable file not found/.test(message)) return false;
  return /ENOENT|not found|command not found|127/.test(message);
}

/**
 * A failure from the binary that is about Helm gets a message that names the
 * option or the chart; any other failure is kustomize's own and passes through.
 * The pre-check reads the root and the directories it lists, so this catches
 * what it cannot see: a base that is a remote reference, or a chart helm
 * itself refuses.
 */
function refineHelmFailure(dir: string, err: unknown, helm: KustomizeHelmOptions): unknown {
  const text = err instanceof Error ? err.message : String(err);
  if (!helm.enableHelm && /must specify --enable-helm/.test(text)) {
    return new KustomizeHelmDisabledError(
      `Kustomization "${dir}" names Helm charts, which kustomize renders only with --enable-helm. Set enableHelm: true on the entry to allow it. kustomize said: ${text}`,
    );
  }
  if (helm.enableHelm && /helm|chart/i.test(text) && helmChartEntries(dir).length > 0) {
    return new KustomizeHelmRenderError(
      `Kustomization "${dir}" has Helm charts and helm failed on them${helm.fetchCharts ? "" : " (fetching charts is off)"}. kustomize said: ${text}`,
    );
  }
  return err;
}

/**
 * Render the kustomization at `dir` and parse the emitted YAML into document
 * objects. Falls back to kubectl's vendored kustomize when the standalone
 * binary is missing; when both binaries are missing, fails with a message
 * naming them.
 */
export async function renderKustomizeDocuments(
  dir: string,
  run: KustomizeRunner = defaultKustomizeRunner,
  helm: KustomizeHelmOptions = {},
): Promise<Array<Record<string, unknown>>> {
  checkHelmOptions(dir, helm);
  let stdout: string;
  try {
    ({ stdout } = await run(renderCommand(dir, "kustomize", helm)));
  } catch (err) {
    if (!isMissingBinary(err)) throw refineHelmFailure(dir, err, helm);
    try {
      ({ stdout } = await run(renderCommand(dir, "kubectl", helm)));
    } catch (err2) {
      if (isMissingBinary(err2)) {
        throw new KustomizeBinaryMissingError(
          `Cannot render kustomization "${dir}": neither the \`kustomize\` binary nor \`kubectl\` ` +
            `(whose vendored \`kubectl kustomize\` is the fallback) was found on PATH. ` +
            `Install kustomize or kubectl and retry.`,
        );
      }
      throw refineHelmFailure(dir, err2, helm);
    }
  }
  const documents: Array<Record<string, unknown>> = [];
  for (const doc of loadAll(stdout)) {
    if (doc && typeof doc === "object" && !Array.isArray(doc)) documents.push(doc as Record<string, unknown>);
  }
  return documents;
}
