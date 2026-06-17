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

import { readdirSync, readFileSync, statSync } from "fs";
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

const WALK_SKIP = new Set(["node_modules", ".git", "dist"]);
/** Dot-directories the walk descends into anyway (CI lives here). */
const WALK_DOT_DIRS = new Set([".github", ".forgejo"]);
const MAX_WALK_FILES = 1000;
/** Skip absurdly large files before parsing — mirrors the fetch layer's caps. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Recursively collect file paths under a root, skipping noise dirs. */
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
    if (e.name.startsWith(".") && e.isDirectory() && !WALK_DOT_DIRS.has(e.name)) continue;
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

/** A repo file (relative POSIX path + content) — the unit both local and remote feed the classifier. */
export interface RepoFile {
  path: string;
  content: string;
}

/** Which CI lexicon a path belongs to (by location — content can't disambiguate github vs forgejo). */
function ciLexiconForPath(path: string): AuditLexicon | undefined {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return "github";
  if (/^\.forgejo\/workflows\/[^/]+\.ya?ml$/.test(path)) return "forgejo";
  if (path === ".gitlab-ci.yml") return "gitlab";
  return undefined;
}

/**
 * Whether a path is worth reading/fetching at all. Bounds the local walk and,
 * crucially, the remote fetch (so we never pull a whole repo's contents).
 */
export function isCandidatePath(path: string): boolean {
  const name = basename(path);
  if (ciLexiconForPath(path)) return true;
  if (isDockerfileName(name)) return true;
  if (name === "Chart.yaml") return true;
  return /\.(ya?ml|json|template)$/i.test(name);
}

/** Collect Helm charts as bundles from an in-memory file set; returns inputs + chart path-prefixes. */
function classifyHelm(files: RepoFile[], plugin: LexiconPlugin | undefined): { inputs: AuditInput[]; prefixes: string[] } {
  const inputs: AuditInput[] = [];
  const prefixes: string[] = [];
  if (!plugin) return { inputs, prefixes };
  const charts = files.filter((f) => f.path === "Chart.yaml" || f.path.endsWith("/Chart.yaml"));
  for (const chartFile of charts) {
    const dir = chartFile.path === "Chart.yaml" ? "" : chartFile.path.slice(0, -"/Chart.yaml".length);
    const prefix = dir === "" ? "" : `${dir}/`;
    const bundle: Record<string, string> = {};
    for (const f of files) {
      if (prefix !== "" && !f.path.startsWith(prefix)) continue;
      bundle[prefix === "" ? f.path : f.path.slice(prefix.length)] = f.content;
    }
    const chart = bundle["Chart.yaml"];
    if (chart === undefined) continue;
    const parsed = parseStructured(chart);
    if (!parsed || !plugin.detectTemplate?.(parsed)) continue;
    inputs.push({ path: dir || ".", content: chart, lexicon: "helm", files: bundle });
    prefixes.push(prefix);
  }
  return { inputs, prefixes };
}

/**
 * Classify an in-memory set of repo files into per-lexicon audit inputs. Pure
 * (no fs, no network) so the local walk and the remote tree-fetch share exactly
 * one detection path. Each file maps to at most one lexicon: CI by path,
 * Dockerfiles by name, Helm charts as a bundle, everything else by the
 * precedence-ordered content detectors (delegating to each plugin's
 * `detectTemplate`). Lexicons whose plugin isn't provided are skipped.
 */
export function classifyFiles(files: RepoFile[], plugins: LexiconPlugin[]): AuditInput[] {
  const byName = new Map(plugins.map((p) => [p.name, p]));

  // Helm claims whole chart directories first; chart-internal files are excluded
  // from the loose-file pass so templates aren't double-audited.
  const helm = classifyHelm(files, byName.get("helm"));
  const underChart = (p: string): boolean => helm.prefixes.some((pre) => (pre === "" ? true : p.startsWith(pre)));

  const inputs: AuditInput[] = [...helm.inputs];
  for (const { path, content } of files) {
    if (underChart(path)) continue;
    const name = basename(path);

    const ci = ciLexiconForPath(path);
    if (ci) {
      if (byName.has(ci)) inputs.push({ path, content, lexicon: ci });
      continue;
    }
    if (isDockerfileName(name)) {
      if (byName.has("docker")) inputs.push({ path, content, lexicon: "docker" });
      continue;
    }
    for (const det of CONTENT_DETECTORS) {
      const plugin = byName.get(det.lexicon);
      if (!plugin || !det.accepts(name)) continue;
      const normalized = det.detect(plugin, name, content);
      if (normalized !== null) {
        inputs.push({ path, content: normalized, lexicon: det.lexicon });
        break; // first detector in precedence wins — one lexicon per file
      }
    }
  }
  return inputs;
}

/**
 * Local discovery: one filesystem walk, candidate-filtered, read into memory,
 * then handed to the shared `classifyFiles`. Detection is skipped for any
 * lexicon whose plugin isn't provided, so a caller can scope discovery.
 */
export function discoverByDetection(root: string, plugins: LexiconPlugin[]): AuditInput[] {
  const all: string[] = [];
  walkFiles(root, all);
  const files: RepoFile[] = [];
  for (const full of all) {
    const path = relative(root, full);
    if (!isCandidatePath(path)) continue;
    const content = readSafe(full);
    if (content !== undefined) files.push({ path, content });
  }
  return classifyFiles(files, plugins);
}
