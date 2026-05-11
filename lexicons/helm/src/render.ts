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
import { Deployment } from "@intentius/chant-lexicon-k8s/generated";
import yaml from "js-yaml";

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
}

interface RenderedDoc {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; [k: string]: unknown };
  [k: string]: unknown;
}

const CACHE_ROOT = join(homedir(), ".chant", "helm-renders");

function cacheKey(props: HelmRenderProps): string {
  const stable = JSON.stringify({
    repo: props.repo,
    chart: props.chart,
    version: props.version,
    namespace: props.namespace ?? null,
    values: props.values ?? null,
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function renderViaHelm(props: HelmRenderProps): string {
  // Write values overrides to a tempfile if any.
  let valuesArgs: string[] = [];
  if (props.values && Object.keys(props.values).length > 0) {
    const valuesPath = join(tmpdir(), `chant-helm-values-${cacheKey(props)}.yaml`);
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

  const args = [
    "template",
    props.name,
    props.chart,
    ...fetchArgs,
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

function loadOrRender(props: HelmRenderProps): string {
  if (props.noCache) {
    return renderViaHelm(props);
  }
  const cacheDir = join(CACHE_ROOT, cacheKey(props));
  const cachePath = join(cacheDir, "manifests.yaml");
  if (existsSync(cachePath)) {
    return readFileSync(cachePath, "utf8");
  }
  const out = renderViaHelm(props);
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, out);
  } catch {
    // Cache write failure is non-fatal — the render is still in memory.
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
  const yamlText = loadOrRender(props);
  const docs = parseMultiDoc(yamlText);

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
