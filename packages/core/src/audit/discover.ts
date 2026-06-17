/**
 * Unified, detectTemplate-driven discovery (prototype for #391).
 *
 * Today `commands/audit.ts` ships six bespoke discoverers — `discoverManifests`,
 * `discoverGcp`, `discoverCloudFormation`, `discoverArm`, `discoverDocker`,
 * `discoverHelm` — each walking the tree and re-implementing a `looksLike*`
 * content heuristic that mostly duplicates the lexicon plugin's own
 * `detectTemplate(parsed)` (already used by `chant import`).
 *
 * This module collapses that into ONE walk plus a single content-detection
 * pass that delegates to each plugin's `detectTemplate`. A new content-detected
 * lexicon then needs only a `detectTemplate` and a precedence entry — no new
 * walk, no new heuristic.
 *
 * It is deliberately a HYBRID, because some classification can't be expressed
 * by content shape alone:
 *   - CI (github/forgejo/gitlab) stays a PATH fast-path. github and forgejo
 *     workflows are byte-for-byte the same shape (`on:` + `jobs:`), so only the
 *     directory (`.github` vs `.forgejo`) disambiguates them.
 *   - Dockerfiles are matched by FILENAME — they aren't YAML/JSON, so
 *     `detectTemplate` (which only knows Compose's `services:`) can't see them.
 *   - Helm charts are a directory BUNDLE keyed by `Chart.yaml`; the helm checks
 *     read `output.files`, so the whole chart is one AuditInput.
 *   - k8s `detectTemplate` matches any `apiVersion`+`kind`, including GCP Config
 *     Connector (`cnrm.cloud.google.com`) resources, so gcp must be tried first.
 *   - aws/azure checks `JSON.parse` their input, so YAML/templated content is
 *     normalized to a JSON string here.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, relative } from "path";
import { parseYAML } from "../yaml";
import { loadPlugin } from "../cli/plugins";
import type { LexiconPlugin } from "../lexicon";
import type { AuditInput, AuditLexicon } from "./core";

/** Lexicons the auditor knows how to detect and run checks for. */
export const AUDIT_LEXICONS = ["github", "gitlab", "forgejo", "k8s", "docker", "aws", "azure", "gcp", "helm"] as const;

/**
 * Load the plugins used for detection. Each is loaded in isolation (no
 * cross-lexicon conflict aggregation — detection only reads `detectTemplate`),
 * and a lexicon that isn't installed is skipped rather than failing the audit.
 * `init()` is intentionally not called: `detectTemplate` is a pure function of
 * its input and needs no plugin setup.
 */
export async function loadAuditPlugins(names: readonly string[] = AUDIT_LEXICONS): Promise<LexiconPlugin[]> {
  const plugins: LexiconPlugin[] = [];
  for (const name of names) {
    try {
      plugins.push(await loadPlugin(name));
    } catch {
      // lexicon package not installed — its files simply won't be detected
    }
  }
  return plugins;
}

const WALK_SKIP = new Set(["node_modules", ".git", "dist", ".github", ".forgejo"]);
const MAX_WALK_FILES = 1000;
/** Skip absurdly large files before parsing — mirrors the fetch layer's caps. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Recursively collect file paths under a root, skipping noise/dot dirs. */
function walkFiles(dir: string, out: string[]): void {
  if (out.length >= MAX_WALK_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (out.length >= MAX_WALK_FILES) return;
    if (e.name.startsWith(".") && e.isDirectory()) continue;
    if (WALK_SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
}

function readSafe(full: string): string | undefined {
  try {
    if (statSync(full).size > MAX_FILE_BYTES) return undefined;
    return readFileSync(full, "utf-8");
  } catch {
    return undefined;
  }
}

function isYaml(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

function isDockerfileName(name: string): boolean {
  return name === "Dockerfile" || name.startsWith("Dockerfile.") || name.endsWith(".Dockerfile") || name.endsWith(".dockerfile");
}

/** Split a possibly multi-document YAML string into per-doc parsed objects. */
function parseDocs(content: string): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  for (const raw of content.split(/\n---\n/)) {
    const t = raw.trim();
    if (!t) continue;
    try {
      const obj = parseYAML(t);
      if (obj && typeof obj === "object") docs.push(obj);
    } catch {
      // a non-parseable doc just doesn't contribute a candidate
    }
  }
  return docs;
}

/** Parse JSON or YAML content into a single object, or undefined. */
function parseStructured(content: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(content);
    if (j && typeof j === "object") return j as Record<string, unknown>;
  } catch {
    // not JSON — try YAML
  }
  try {
    const y = parseYAML(content);
    if (y && typeof y === "object") return y;
  } catch {
    // not YAML either
  }
  return undefined;
}

/**
 * A content detector for one lexicon. `detect` delegates to the plugin's
 * `detectTemplate`; the surrounding fields encode the bits `detectTemplate`
 * can't: which files to even consider, in what precedence, and how to normalize
 * the content the lexicon's checks ultimately read.
 */
interface ContentDetector {
  lexicon: AuditLexicon;
  /** Cheap filename gate before reading/parsing. */
  accepts(name: string): boolean;
  /**
   * Decide whether this file belongs to the lexicon, by delegating to the
   * plugin's detectTemplate. Returns the (possibly normalized) content to feed
   * the checks, or null if it doesn't match.
   */
  detect(plugin: LexiconPlugin, name: string, content: string): string | null;
}

/** Run a plugin's detectTemplate over each parsed doc; true if any matches. */
function anyDoc(plugin: LexiconPlugin, content: string): boolean {
  return parseDocs(content).some((doc) => plugin.detectTemplate?.(doc) ?? false);
}

/**
 * Precedence-ordered content detectors. Order matters: gcp before k8s (Config
 * Connector resources are also valid k8s manifests).
 */
const CONTENT_DETECTORS: ContentDetector[] = [
  {
    // GCP Config Connector — must win over k8s for cnrm.cloud.google.com docs.
    lexicon: "gcp",
    accepts: isYaml,
    detect: (plugin, _name, content) => (anyDoc(plugin, content) ? content : null),
  },
  {
    lexicon: "k8s",
    accepts: isYaml,
    detect: (plugin, _name, content) => (anyDoc(plugin, content) ? content : null),
  },
  {
    // CloudFormation — JSON, YAML, or `.template`; normalized to a JSON string
    // because the aws checks JSON.parse their input.
    lexicon: "aws",
    accepts: (name) => /\.(json|ya?ml|template)$/i.test(name),
    detect: (plugin, _name, content) => {
      const parsed = parseStructured(content);
      return parsed && plugin.detectTemplate?.(parsed) ? JSON.stringify(parsed) : null;
    },
  },
  {
    // Azure ARM — JSON only; azure's detectTemplate takes the raw string.
    lexicon: "azure",
    accepts: (name) => /\.json$/i.test(name),
    detect: (plugin, _name, content) => {
      if (!plugin.detectTemplate?.(content)) return null;
      const parsed = parseStructured(content);
      return parsed ? JSON.stringify(parsed) : null;
    },
  },
  {
    // Docker Compose (services:). Dockerfiles are handled separately by name.
    lexicon: "docker",
    accepts: isYaml,
    detect: (plugin, _name, content) => {
      const parsed = parseStructured(content);
      return parsed && plugin.detectTemplate?.(parsed) ? content : null;
    },
  },
];

/** Discover CI files by PATH (github/forgejo/gitlab — content can't disambiguate). */
function discoverCi(root: string): AuditInput[] {
  const inputs: AuditInput[] = [];
  const collectDir = (dir: string, lexicon: AuditLexicon) => {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
    for (const name of readdirSync(abs).sort()) {
      if (!isYaml(name)) continue;
      const full = join(abs, name);
      if (!statSync(full).isFile()) continue;
      inputs.push({ path: relative(root, full), content: readFileSync(full, "utf-8"), lexicon });
    }
  };
  collectDir(".github/workflows", "github");
  collectDir(".forgejo/workflows", "forgejo");
  const gitlab = join(root, ".gitlab-ci.yml");
  if (existsSync(gitlab) && statSync(gitlab).isFile()) {
    inputs.push({ path: ".gitlab-ci.yml", content: readFileSync(gitlab, "utf-8"), lexicon: "gitlab" });
  }
  return inputs;
}

/** Collect Helm charts as bundles, returning [inputs, set of chart path-prefixes]. */
function discoverHelm(root: string, all: string[], plugin: LexiconPlugin | undefined): { inputs: AuditInput[]; prefixes: string[] } {
  const inputs: AuditInput[] = [];
  const prefixes: string[] = [];
  if (!plugin) return { inputs, prefixes };
  const chartDirs = all.filter((f) => basename(f) === "Chart.yaml").map((f) => f.slice(0, -("/Chart.yaml".length)));
  for (const dir of chartDirs) {
    const prefix = dir + "/";
    const files: Record<string, string> = {};
    for (const f of all) {
      if (!f.startsWith(prefix)) continue;
      const content = readSafe(f);
      if (content !== undefined) files[f.slice(prefix.length)] = content;
    }
    const chart = files["Chart.yaml"];
    if (chart === undefined) continue;
    const parsed = parseStructured(chart);
    if (!parsed || !plugin.detectTemplate?.(parsed)) continue;
    const chartPath = relative(root, dir) || ".";
    inputs.push({ path: chartPath, content: chart, lexicon: "helm", files });
    prefixes.push(chartPath === "." ? "" : `${chartPath}/`);
  }
  return { inputs, prefixes };
}

/**
 * Unified discovery: one walk, plugin-delegated content detection, plus the
 * path/filename/bundle special-cases content shape can't express.
 *
 * `plugins` is the set of loaded lexicon plugins (by name); detection is skipped
 * for any lexicon whose plugin isn't provided, so a caller can scope discovery.
 */
export function discoverByDetection(root: string, plugins: LexiconPlugin[]): AuditInput[] {
  const byName = new Map(plugins.map((p) => [p.name, p]));
  const all: string[] = [];
  walkFiles(root, all);

  // Helm claims whole chart directories first; everything under a chart is
  // excluded from the loose-file pass so templates aren't double-audited.
  const helm = discoverHelm(root, all, byName.get("helm"));
  const underChart = (rel: string): boolean => helm.prefixes.some((pre) => (pre === "" ? true : rel.startsWith(pre)));

  const inputs: AuditInput[] = [...discoverCi(root), ...helm.inputs];

  for (const full of all) {
    const name = basename(full);
    const rel = relative(root, full);
    if (underChart(rel)) continue;

    // Dockerfiles: filename-detected (not YAML/JSON, so no detectTemplate).
    if (isDockerfileName(name) && byName.has("docker")) {
      const content = readSafe(full);
      if (content !== undefined) inputs.push({ path: rel, content, lexicon: "docker" });
      continue;
    }

    let content: string | undefined;
    for (const det of CONTENT_DETECTORS) {
      const plugin = byName.get(det.lexicon);
      if (!plugin || !det.accepts(name)) continue;
      if (content === undefined) {
        content = readSafe(full);
        if (content === undefined) break;
      }
      const normalized = det.detect(plugin, name, content);
      if (normalized !== null) {
        inputs.push({ path: rel, content: normalized, lexicon: det.lexicon });
        break; // first detector in precedence wins — one lexicon per file
      }
    }
  }

  return inputs;
}
