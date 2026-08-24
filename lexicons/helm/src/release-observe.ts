/**
 * Release-scoped observation plumbing, shared by the helm lexicon's
 * `describeResources` (#1246) and `observeResourcesDeep` (#1247).
 *
 * The helm lexicon's runtime unit is the release: the chant project declares
 * a `Helm::Chart`, `helm upgrade --install` turns it into a release, and the
 * release stores the rendered manifests it applied. Observation therefore
 * resolves each declared chart to its release (via `helm list`, the same
 * read `listArtifacts` has always used) and reads what the release holds.
 *
 * Two channels, both mandatory (#1246): `helm get manifest` reports the
 * non-hook documents and `helm get hooks` reports the hook resources —
 * hooks are excluded from the manifest channel, so reading one channel
 * would report every hook resource as drift.
 *
 * Failure discipline is the observation contract (#1089): a missing helm
 * binary or an unreachable cluster is NOT-OBSERVED with a total reason,
 * never a clean empty result that classifies as N creates. Only a release
 * that `helm list` was asked about and did not report is an absence.
 *
 * Cluster selection follows #1488, same as `list-artifacts.ts` and
 * `describe-stack-status.ts`: the environment's declared k8s binding
 * (`k8s.profiles.<env>.context`) rides as `--kube-context` when present;
 * ambient otherwise.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { loadAll } from "js-yaml";
import type { UnobservedEntity, UnobservedReason } from "@intentius/chant/lexicon";
import { loadChantConfigUpward } from "@intentius/chant/config";
import { resolveClusterTarget } from "@intentius/chant/kubectl-context";
import { gvkToTypeName } from "@intentius/chant-lexicon-k8s/spec/parse";

// `helm get manifest` for a large chart is several megabytes, past node's
// default 1MiB exec buffer — the same truncation `helm-upgrade.ts` hit live.
const execP = promisify(exec);
const defaultRunner = (command: string): Promise<{ stdout: string }> =>
  execP(command, { maxBuffer: 64 * 1024 * 1024 });

/** Injectable command runner, so tests drive every branch without helm or a cluster. */
export type HelmRunner = (command: string) => Promise<{ stdout: string }>;

export { defaultRunner as defaultHelmRunner };

export const HELM_CHART_ENTITY_TYPE = "Helm::Chart";
export const HELM_RELEASE_TYPE = "Helm::Release";

/** Shell-quote one argv element, same convention as `helm-upgrade.ts`. */
export function q(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The environment's kube context (#1488): the declared binding when present,
 * ambient otherwise. Unresolvable config is ambient, chant's own fallback —
 * identical to `list-artifacts.ts`.
 */
export async function resolveHelmContext(environment: string): Promise<string | undefined> {
  try {
    const { config } = await loadChantConfigUpward(process.cwd());
    return (await resolveClusterTarget(config as Record<string, unknown>, environment, "helm")).context;
  } catch {
    return undefined;
  }
}

/**
 * Total verdict for a failed helm invocation (#1089/#1246). A missing binary
 * and a missing/unusable kubeconfig are both `no-credentials` — the read had
 * no usable way to reach the target. Anything else the CLI refused is
 * `read-failed`.
 */
export function classifyHelmFailure(err: unknown): { reason: UnobservedReason; detail: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string | number } | null)?.code;
  if (
    code === "ENOENT" ||
    code === 127 ||
    /command not found|not recognized|ENOENT/i.test(message)
  ) {
    return { reason: "no-credentials", detail: "helm binary not found on PATH" };
  }
  if (/kubeconfig|kubernetes cluster unreachable|unauthorized|forbidden|no configuration has been provided|connection refused/i.test(message)) {
    return { reason: "no-credentials", detail: firstLine(message) };
  }
  return { reason: "read-failed", detail: firstLine(message) };
}

function firstLine(message: string): string {
  const line = message.split("\n").find((l) => l.trim().length > 0);
  return (line ?? message).trim();
}

interface HelmListEntry {
  name?: string;
  namespace?: string;
  revision?: string;
  updated?: string;
  status?: string;
  chart?: string;
  app_version?: string;
}

/**
 * Kinds that are cluster-scoped, so a document without `metadata.namespace`
 * must not inherit the release namespace. Well-known built-ins only; a
 * cluster-scoped CRD instance this set does not name defaults to the release
 * namespace, which affects the row's address, never its verdict.
 */
const CLUSTER_SCOPED_KINDS = new Set([
  "Namespace",
  "CustomResourceDefinition",
  "ClusterRole",
  "ClusterRoleBinding",
  "StorageClass",
  "PriorityClass",
  "IngressClass",
  "PersistentVolume",
  "ValidatingWebhookConfiguration",
  "MutatingWebhookConfiguration",
  "APIService",
  "RuntimeClass",
  "CSIDriver",
  "CSINode",
]);

/** One rendered document a release holds, from either channel. */
export interface ParsedReleaseResource {
  /**
   * Row key, following the k8s runtime-sweep convention
   * (`<Kind>/<namespace>/<name>`, `cluster:<Kind>/<name>`) so a helm row and
   * a k8s row for the same object spell the same identity.
   */
  key: string;
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  /** Which read reported it — hooks are invisible to the manifest channel. */
  channel: "manifest" | "hooks";
  /** chant's k8s entity type for the document's GVK (`K8s::Apps::Deployment`). */
  entityType: string;
  /** The document itself, minus nothing — the release's stored declaration. */
  doc: Record<string, unknown>;
  /** `helm.sh/hook*` annotations, for hook-channel rows. */
  hook?: { hook: string; weight?: string; deletePolicy?: string };
}

/** One declared chart resolved to a live release, with what the release holds. */
export interface ObservedRelease {
  entityName: string;
  release: string;
  namespace: string;
  status?: string;
  revision?: string;
  chart?: string;
  appVersion?: string;
  updated?: string;
  resources: ParsedReleaseResource[];
}

export interface ReleaseObservation {
  /** Charts whose release was found and fully read. */
  releases: ObservedRelease[];
  /** Chart entities whose release `helm list` did not report — a real absence. */
  absent: string[];
  /** Chart entities that could not be read, with a total reason (#1089). */
  unobserved: Record<string, UnobservedEntity>;
  /** The helm command issued per chart entity (#1620). */
  queried: Record<string, string>;
}

export interface ReleaseObserveOptions {
  environment: string;
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /** Deploy unit, `<namespace>/<release>` or `<release>` (see `describeStackStatus`). */
  stack?: string;
}

/** The declared chart entities, with the release name each one deploys as. */
export function chartEntities(
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>,
): Array<{ entityName: string; release: string }> {
  const charts: Array<{ entityName: string; release: string }> = [];
  for (const [entityName, entity] of entities) {
    if (entity.entityType !== HELM_CHART_ENTITY_TYPE) continue;
    const name = entity.props?.name;
    charts.push({ entityName, release: typeof name === "string" && name ? name : entityName });
  }
  return charts;
}

function parseStack(stack: string): { namespace?: string; release: string } {
  const slash = stack.indexOf("/");
  return slash > 0
    ? { namespace: stack.slice(0, slash), release: stack.slice(slash + 1) }
    : { release: stack };
}

/**
 * Find the list entry for one declared chart. Release identity resolves in
 * order: the deploy unit (`stack`), a release named after the chart, then a
 * unique release whose `chart` field is `<chartName>-<version>` — the release
 * installed from this chart under another name. Ambiguity resolves to
 * nothing: two candidate releases are not an identity.
 */
function findRelease(
  entries: HelmListEntry[],
  release: string,
  wantNamespace: string | undefined,
  chartName: string,
): { entry: HelmListEntry } | { ambiguous: string } | undefined {
  const named = entries.filter(
    (e) => e.name === release && (wantNamespace === undefined || e.namespace === wantNamespace),
  );
  if (named.length === 1) return { entry: named[0] };
  if (named.length > 1) {
    // The same release name in several namespaces is not an identity — and
    // not an absence either. Say which namespaces so the caller can scope
    // the read with a deploy unit (`<namespace>/<release>`).
    return { ambiguous: named.map((e) => e.namespace).join(", ") };
  }

  const byChart = entries.filter(
    (e) => typeof e.chart === "string" && new RegExp(`^${escapeRegExp(chartName)}-\\d`).test(e.chart),
  );
  return byChart.length === 1 ? { entry: byChart[0] } : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse one channel's multi-document YAML stream into per-resource rows. */
export function parseReleaseDocuments(
  text: string,
  channel: "manifest" | "hooks",
  releaseNamespace: string,
): ParsedReleaseResource[] {
  const rows: ParsedReleaseResource[] = [];
  let docs: unknown[];
  try {
    docs = loadAll(text);
  } catch {
    return rows;
  }
  for (const raw of docs) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const doc = raw as Record<string, unknown>;
    const apiVersion = typeof doc.apiVersion === "string" ? doc.apiVersion : undefined;
    const kind = typeof doc.kind === "string" ? doc.kind : undefined;
    const metadata = doc.metadata as { name?: unknown; namespace?: unknown; annotations?: Record<string, unknown> } | undefined;
    const name = typeof metadata?.name === "string" ? metadata.name : undefined;
    if (!apiVersion || !kind || !name) continue;

    const clusterScoped = CLUSTER_SCOPED_KINDS.has(kind) && typeof metadata?.namespace !== "string";
    const namespace = clusterScoped
      ? undefined
      : typeof metadata?.namespace === "string"
        ? metadata.namespace
        : releaseNamespace; // helm applies the release namespace to namespace-silent documents

    const slash = apiVersion.indexOf("/");
    const entityType = gvkToTypeName({
      group: slash > 0 ? apiVersion.slice(0, slash) : "",
      version: slash > 0 ? apiVersion.slice(slash + 1) : apiVersion,
      kind,
    });

    const annotations = metadata?.annotations ?? {};
    const hookAnnotation = annotations["helm.sh/hook"];
    const hook =
      channel === "hooks" && typeof hookAnnotation === "string"
        ? {
            hook: hookAnnotation,
            ...(typeof annotations["helm.sh/hook-weight"] === "string"
              ? { weight: annotations["helm.sh/hook-weight"] as string }
              : {}),
            ...(typeof annotations["helm.sh/hook-delete-policy"] === "string"
              ? { deletePolicy: annotations["helm.sh/hook-delete-policy"] as string }
              : {}),
          }
        : undefined;

    rows.push({
      key: namespace ? `${kind}/${namespace}/${name}` : `cluster:${kind}/${name}`,
      apiVersion,
      kind,
      name,
      ...(namespace ? { namespace } : {}),
      channel,
      entityType,
      doc,
      ...(hook ? { hook } : {}),
    });
  }
  return rows;
}

/**
 * Resolve every declared chart to its release and read both channels.
 * Never throws for a per-release failure; a whole-read failure (the `helm
 * list` itself) lands every chart entity in `unobserved` with one reason.
 */
export async function observeReleases(
  options: ReleaseObserveOptions,
  run: HelmRunner = defaultRunner,
): Promise<ReleaseObservation> {
  const charts = chartEntities(options.entities);
  const result: ReleaseObservation = { releases: [], absent: [], unobserved: {}, queried: {} };
  if (charts.length === 0) return result;

  const stack = options.stack ? parseStack(options.stack) : undefined;
  // The deploy unit names the release when the project has one chart — the
  // component flow deploys each chart under the step's `release`, which need
  // not equal the chart name.
  if (stack && charts.length === 1) charts[0].release = stack.release;

  const context = await resolveHelmContext(options.environment);
  const ctxFlag = context ? ` --kube-context ${q(context)}` : "";

  const listCommand = `helm list -A -o json${ctxFlag}`;
  let entries: HelmListEntry[];
  try {
    const { stdout } = await run(listCommand);
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("helm list returned non-array JSON");
    entries = parsed as HelmListEntry[];
  } catch (err) {
    const { reason, detail } = classifyHelmFailure(err);
    for (const { entityName } of charts) {
      result.unobserved[entityName] = { type: HELM_CHART_ENTITY_TYPE, reason, detail };
      result.queried[entityName] = listCommand;
    }
    return result;
  }

  for (const { entityName, release } of charts) {
    const found = findRelease(entries, release, stack?.namespace, release);
    if (found && "ambiguous" in found) {
      result.unobserved[entityName] = {
        type: HELM_CHART_ENTITY_TYPE,
        reason: "read-failed",
        detail: `release "${release}" exists in several namespaces (${found.ambiguous}) — scope the read with a <namespace>/<release> deploy unit`,
      };
      result.queried[entityName] = listCommand;
      continue;
    }
    const entry = found?.entry;
    if (!entry || !entry.name || !entry.namespace) {
      result.absent.push(entityName);
      result.queried[entityName] = listCommand;
      continue;
    }

    const base = `-n ${q(entry.namespace)}${ctxFlag}`;
    const manifestCommand = `helm get manifest ${q(entry.name)} ${base}`;
    const hooksCommand = `helm get hooks ${q(entry.name)} ${base}`;
    result.queried[entityName] = manifestCommand;

    let manifestText: string;
    let hooksText: string;
    try {
      ({ stdout: manifestText } = await run(manifestCommand));
      ({ stdout: hooksText } = await run(hooksCommand));
    } catch (err) {
      // The release exists but what it holds could not be read — an
      // unreachable release is NOT-OBSERVED with a reason, never absent and
      // never a clean row that claims nothing drifted (#1246).
      const { reason, detail } = classifyHelmFailure(err);
      result.unobserved[entityName] = { type: HELM_CHART_ENTITY_TYPE, reason, detail };
      continue;
    }

    result.releases.push({
      entityName,
      release: entry.name,
      namespace: entry.namespace,
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.revision ? { revision: entry.revision } : {}),
      ...(entry.chart ? { chart: entry.chart } : {}),
      ...(entry.app_version ? { appVersion: entry.app_version } : {}),
      ...(entry.updated ? { updated: entry.updated } : {}),
      resources: [
        ...parseReleaseDocuments(manifestText, "manifest", entry.namespace),
        ...parseReleaseDocuments(hooksText, "hooks", entry.namespace),
      ],
    });
  }

  return result;
}
