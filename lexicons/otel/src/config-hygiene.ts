/**
 * Collector config checks for deprecated fields, exposure and delivery
 * settings, and two fields the collector checks against a fixed list
 * (OTEL119-OTEL127). Each is a plain function over a parsed `CollectorConfig`,
 * so it runs on emitted YAML, on an imported file and on a config inside a
 * ConfigMap alike. `validateCollectorConfig` calls `configHygieneIssues`.
 *
 * Every list and version here is read from collector or collector-contrib
 * v0.130.0 (`COLLECTOR_PIN`); the lint rules page cites the file for each.
 */

import { parseComponentId, type CollectorConfig } from "./model";
import { componentListeners, listenerPaths, type CollectorIssue } from "./validate-config";

/**
 * Keys whose value is a credential. `*_file` keys name a path, which is fine.
 * OTEL002 reads TypeScript source with this pattern and OTEL120 reads YAML
 * with it, so the two agree on what a credential is.
 */
export const SECRET_KEY = /(authorization|api[-_]?key|password|passwd|secret|token|key_pem|x-honeycomb-team)/i;

type Body = Record<string, unknown>;
type Section = "receivers" | "processors" | "exporters" | "extensions" | "connectors";
const SECTIONS: Array<[Section, string]> = [
  ["receivers", "receiver"],
  ["processors", "processor"],
  ["exporters", "exporter"],
  ["extensions", "extension"],
  ["connectors", "connector"],
];

function isObject(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(id: string): string {
  return parseComponentId(id)?.type ?? id;
}

/** The host an endpoint names: `http://h:4318/v1`, `dns:///h:4317`, `h:4317`, `[::1]:4317` or `h`. */
function endpointHost(endpoint: string): string {
  let rest = endpoint.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/\/?/i, "");
  rest = rest.split("/")[0];
  const bracketed = rest.match(/^\[([^\]]*)\]/);
  if (bracketed) return bracketed[1];
  const colon = rest.lastIndexOf(":");
  return colon > 0 && /^\d+$/.test(rest.slice(colon + 1)) ? rest.slice(0, colon) : rest;
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** The pipelines' started receivers, processors and exporters, by id. */
function startedIds(config: CollectorConfig, field: "receivers" | "processors" | "exporters"): Set<string> {
  return new Set(Object.values(config.service?.pipelines ?? {}).flatMap((p) => (p?.[field] ?? []).map(String)));
}

/**
 * Where a non-listener exporter sends to, when it names a host other than
 * loopback. `${env:...}` hosts count as remote: only a literal loopback
 * address is known to stay on the machine.
 */
function remoteEndpoint(id: string, body: Body): string | undefined {
  if (listenerPaths("exporter", typeOf(id), body).length > 0) return undefined; // prometheus serves, it doesn't send
  const endpoint = ["endpoint", "traces_endpoint", "metrics_endpoint", "logs_endpoint"].map((k) => body[k]).find((v) => typeof v === "string" && v !== "");
  if (typeof endpoint !== "string" || isLoopback(endpointHost(endpoint))) return undefined;
  return endpoint;
}

// ── OTEL119: deprecated before the pin ───────────────────────────────

/** The paths under a tail_sampling policy that set `invert_match: true`. */
function invertMatchPaths(value: unknown, path: string[], out: string[]): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => invertMatchPaths(v, [...path.slice(0, -1), `${path[path.length - 1] ?? ""}[${i}]`], out));
  else if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (key === "invert_match" && v === true) out.push([...path, key].join("."));
      else invertMatchPaths(v, [...path, key], out);
    }
  }
  return out;
}

/**
 * OTEL119: a field deprecated at or before the pin. The collector still
 * reads each of these at v0.130.0, and a later release drops them.
 *
 * - `invert_match: true` in a `tail_sampling` policy: inverted decisions are
 *   deprecated in contrib v0.126.0 (#39833) for a `drop` policy.
 * - `service.telemetry.metrics.address`: deprecated in core v0.111.0
 *   (#11205) for `readers`.
 * - `dimensions_cache_size` on `spanmetrics`: deprecated in contrib v0.125.0
 *   (#39646), and marked so in its config at v0.130.0 (#41101), for
 *   `aggregation_cardinality_limit`.
 */
function deprecatedFieldIssues(config: CollectorConfig): CollectorIssue[] {
  const issues: CollectorIssue[] = [];
  for (const [id, raw] of Object.entries(config.processors ?? {})) {
    if (typeOf(id) !== "tail_sampling" || !isObject(raw)) continue;
    const policies = Array.isArray(raw.policies) ? raw.policies : [];
    policies.forEach((policy, i) => {
      const name = isObject(policy) && typeof policy.name === "string" ? `"${policy.name}"` : `policies[${i}]`;
      for (const path of invertMatchPaths(policy, [], [])) {
        issues.push({
          code: "OTEL119",
          severity: "warning",
          component: id,
          message: `processor "${id}" policy ${name} sets ${path}; inverted decisions are deprecated since collector-contrib v0.126.0. Use a drop policy to keep the traces out instead`,
        });
      }
    });
  }
  const metrics = (config.service?.telemetry as Body | undefined)?.metrics;
  if (isObject(metrics) && metrics.address !== undefined) {
    issues.push({
      code: "OTEL119",
      severity: "warning",
      message: `service.telemetry.metrics.address is deprecated since collector v0.111.0; serve the collector's own metrics with service.telemetry.metrics.readers (pull.exporter.prometheus host and port) instead`,
    });
  }
  for (const [id, raw] of Object.entries(config.connectors ?? {})) {
    if (typeOf(id) !== "spanmetrics" || !isObject(raw) || raw.dimensions_cache_size === undefined) continue;
    issues.push({
      code: "OTEL119",
      severity: "warning",
      component: id,
      message: `connector "${id}" sets dimensions_cache_size, deprecated since collector-contrib v0.125.0; use aggregation_cardinality_limit to bound its series instead`,
    });
  }
  return issues;
}

// ── OTEL120: literal credential in the config ────────────────────────

/** Every `key: value` under a component whose key names a credential and whose value is written out. */
function literalSecrets(value: unknown, path: string[], out: string[]): string[] {
  if (Array.isArray(value)) value.forEach((v) => (isObject(v) || Array.isArray(v) ? literalSecrets(v, path, out) : undefined));
  else if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (isObject(v) || Array.isArray(v)) literalSecrets(v, [...path, key], out);
      else if (SECRET_KEY.test(key) && !/_file$/i.test(key) && (typeof v === "string" || typeof v === "number")) {
        const text = String(v);
        if (text !== "" && !text.includes("${")) out.push([...path, key].join("."));
      }
    }
  }
  return out;
}

/**
 * OTEL120: OTEL002's check over the config itself, so an imported config or
 * one inside a ConfigMap gets it too. Same key pattern, same exceptions: a
 * value containing `${` is a reference the collector expands, and a key
 * ending in `_file` is a path. List items don't inherit their parent's key,
 * as in OTEL002, so a list of header names is not a credential.
 */
function literalCredentialIssues(config: CollectorConfig): CollectorIssue[] {
  const issues: CollectorIssue[] = [];
  for (const [section, noun] of SECTIONS) {
    for (const [id, body] of Object.entries(config[section] ?? {})) {
      for (const path of literalSecrets(body, [], [])) {
        issues.push({
          code: "OTEL120",
          severity: "error",
          component: id,
          message: `${noun} "${id}" has a literal credential at ${path}; write "\${env:NAME}" (or "\${file:/path}") and let the collector read it at start-up`,
        });
      }
    }
  }
  return issues;
}

// ── OTEL121: credentials over plaintext ──────────────────────────────

/**
 * OTEL121: a started exporter sends a credential (a header such as
 * `authorization` or `api-key`, or a top-level key such as `api_key` or
 * `token`) to a non-loopback endpoint without TLS. Plaintext means an
 * `http://` endpoint, or `tls.insecure: true` on an endpoint that isn't
 * `https://`: an HTTP exporter picks TLS from the scheme, a gRPC exporter
 * from `tls.insecure`. A credential sent through an `auth` extension is not
 * checked.
 */
function plaintextCredentialIssues(config: CollectorConfig): CollectorIssue[] {
  const issues: CollectorIssue[] = [];
  const started = startedIds(config, "exporters");
  for (const [id, raw] of Object.entries(config.exporters ?? {})) {
    if (!started.has(id) || !isObject(raw)) continue;
    const endpoint = remoteEndpoint(id, raw);
    if (!endpoint) continue;
    const insecure = isObject(raw.tls) && raw.tls.insecure === true;
    const plaintext = /^http:\/\//i.test(endpoint) || (insecure && !/^https:\/\//i.test(endpoint));
    if (!plaintext) continue;
    const headers = isObject(raw.headers) ? Object.keys(raw.headers).filter((k) => SECRET_KEY.test(k)).map((k) => `headers.${k}`) : [];
    const keys = Object.entries(raw)
      .filter(([k, v]) => SECRET_KEY.test(k) && !/_file$/i.test(k) && (typeof v === "string" || typeof v === "number") && String(v) !== "")
      .map(([k]) => k);
    const sent = [...headers, ...keys];
    if (sent.length === 0) continue;
    const why = /^http:\/\//i.test(endpoint) ? "an http:// endpoint" : "tls.insecure: true";
    issues.push({
      code: "OTEL121",
      severity: "warning",
      component: id,
      message: `exporter "${id}" sends ${sent.join(", ")} to ${endpoint} over ${why}, so the credential crosses the network in plaintext. Use https:// or drop tls.insecure`,
    });
  }
  return issues;
}

// ── OTEL122: debug endpoints off loopback ────────────────────────────

/**
 * The extensions OTEL122 reports off loopback. zpages serves live span
 * samples and pipeline internals, pprof serves heap and goroutine profiles
 * and can be made to run CPU profiles, and neither has authentication.
 * `health_check` is left out on purpose: it serves only a status, and a
 * kubelet probe reaches it on the pod IP, so `otlpCollector()`, `NodeAgent`
 * and `genAiPipeline()` bind it on 0.0.0.0.
 */
const DEBUG_EXTENSIONS = new Set(["zpages", "pprof"]);

/** OTEL122: a started zpages or pprof extension listens on a non-loopback address. */
function debugEndpointIssues(config: CollectorConfig): CollectorIssue[] {
  const issues: CollectorIssue[] = [];
  const enabled = new Set((config.service?.extensions ?? []).map(String));
  for (const [id, body] of Object.entries(config.extensions ?? {})) {
    if (!enabled.has(id) || !DEBUG_EXTENSIONS.has(typeOf(id))) continue;
    for (const listener of componentListeners("extension", id, body)) {
      if (isLoopback(listener.host)) continue;
      const host = listener.host === "" ? "every interface" : listener.host;
      issues.push({
        code: "OTEL122",
        severity: "warning",
        component: id,
        message: `extension "${id}" listens on ${host}:${listener.port}, so anyone who reaches that address can read the collector's internals without authentication. Bind it to localhost:${listener.port} and port-forward when you need it`,
      });
    }
  }
  return issues;
}

// ── OTEL123: detailed debug output beside a real exporter ────────────

/**
 * OTEL123: a pipeline that sends to a backend also sends to a `debug`
 * exporter at `verbosity: detailed`, which writes every record, with all
 * its attributes and bodies, to the collector's own log. That copies what
 * the backend gets, sensitive values included, to wherever the collector's
 * logs go. A pipeline with only `debug` exporters is left alone: that is a
 * test setup.
 */
function detailedDebugIssues(config: CollectorConfig): CollectorIssue[] {
  const issues: CollectorIssue[] = [];
  const exporters = config.exporters ?? {};
  for (const [pipelineId, pipeline] of Object.entries(config.service?.pipelines ?? {})) {
    const ids = (pipeline?.exporters ?? []).map(String).filter((id) => id in exporters);
    const others = ids.filter((id) => typeOf(id) !== "debug");
    if (others.length === 0) continue;
    for (const id of ids) {
      const body = exporters[id];
      if (typeOf(id) !== "debug" || !isObject(body) || body.verbosity !== "detailed") continue;
      issues.push({
        code: "OTEL123",
        severity: "warning",
        pipeline: pipelineId,
        component: id,
        message: `pipeline "${pipelineId}" exports to ${others.map((o) => `"${o}"`).join(", ")} and to "${id}" at verbosity: detailed, which writes every record in full to the collector's log. Use verbosity: basic, or keep detailed output to a test pipeline`,
      });
    }
  }
  return issues;
}

// ── OTEL124: queue or retry off for a remote exporter ────────────────

/**
 * OTEL124: a started exporter sends to a remote endpoint with
 * `sending_queue.enabled: false` or `retry_on_failure.enabled: false`.
 * Without the queue a slow backend blocks the pipeline; without retries one
 * failed request drops its data.
 */
function deliveryIssues(config: CollectorConfig): CollectorIssue[] {
  const issues: CollectorIssue[] = [];
  const started = startedIds(config, "exporters");
  for (const [id, raw] of Object.entries(config.exporters ?? {})) {
    if (!started.has(id) || !isObject(raw)) continue;
    const endpoint = remoteEndpoint(id, raw);
    if (!endpoint) continue;
    if (isObject(raw.sending_queue) && raw.sending_queue.enabled === false) {
      issues.push({
        code: "OTEL124",
        severity: "warning",
        component: id,
        message: `exporter "${id}" sends to ${endpoint} with sending_queue.enabled: false, so a slow or unreachable backend blocks the pipeline and data is refused upstream. Leave the queue on`,
      });
    }
    if (isObject(raw.retry_on_failure) && raw.retry_on_failure.enabled === false) {
      issues.push({
        code: "OTEL124",
        severity: "warning",
        component: id,
        message: `exporter "${id}" sends to ${endpoint} with retry_on_failure.enabled: false, so one failed request drops its data. Leave retries on`,
      });
    }
  }
  return issues;
}

// ── OTEL125: no batching before a network exporter ───────────────────

/**
 * The exporters OTEL125 knows send one request per incoming batch unless
 * told otherwise: `otlp` and `otlphttp`, whose default `sending_queue` at
 * v0.130.0 has no `batch` (`exporterhelper/internal/queue_sender.go`,
 * `NewDefaultQueueConfig`). Other exporters may batch on their own, so they
 * are not checked.
 */
const UNBATCHED_EXPORTERS = new Set(["otlp", "otlphttp"]);

/**
 * OTEL125: a pipeline sends to a remote `otlp` or `otlphttp` exporter, has
 * no `batch` processor, and the exporter does not batch in its own
 * `sending_queue.batch`. Each small request then goes out on its own.
 */
function batchIssues(config: CollectorConfig): CollectorIssue[] {
  const issues: CollectorIssue[] = [];
  const exporters = config.exporters ?? {};
  for (const [pipelineId, pipeline] of Object.entries(config.service?.pipelines ?? {})) {
    if ((pipeline?.processors ?? []).some((id) => typeOf(String(id)) === "batch")) continue;
    for (const id of (pipeline?.exporters ?? []).map(String)) {
      const body = exporters[id];
      if (!UNBATCHED_EXPORTERS.has(typeOf(id)) || !isObject(body)) continue;
      const endpoint = remoteEndpoint(id, body);
      if (!endpoint) continue;
      const queue = body.sending_queue;
      if (isObject(queue) && queue.batch !== undefined && queue.batch !== null) continue;
      issues.push({
        code: "OTEL125",
        severity: "warning",
        pipeline: pipelineId,
        component: id,
        message: `pipeline "${pipelineId}" sends to "${id}" (${endpoint}) with no batch processor, and the exporter doesn't batch on its own, so every small request goes out by itself. Add a batch processor to the pipeline, or set sending_queue.batch on the exporter`,
      });
    }
  }
  return issues;
}

// ── OTEL126, OTEL127: names checked against a fixed list ─────────────

/**
 * The fields `k8sattributes` can extract at v0.130.0: the cases of
 * `Config.Validate` (`processor/k8sattributesprocessor/config.go`), with
 * the semconv v1.6.1 keys and `options.go` constants they name.
 */
export const K8S_ATTRIBUTES_METADATA: readonly string[] = Object.freeze([
  "k8s.namespace.name",
  "k8s.pod.name",
  "k8s.pod.uid",
  "k8s.pod.hostname",
  "k8s.pod.start_time",
  "k8s.pod.ip",
  "k8s.deployment.name",
  "k8s.deployment.uid",
  "k8s.replicaset.name",
  "k8s.replicaset.uid",
  "k8s.daemonset.name",
  "k8s.daemonset.uid",
  "k8s.statefulset.name",
  "k8s.statefulset.uid",
  "k8s.job.name",
  "k8s.job.uid",
  "k8s.cronjob.name",
  "k8s.node.name",
  "k8s.node.uid",
  "k8s.container.name",
  "container.id",
  "container.image.name",
  "container.image.tag",
  "service.namespace",
  "service.name",
  "service.version",
  "service.instance.id",
  "container.image.repo_digests",
  "k8s.cluster.uid",
]);

/**
 * The detectors `resourcedetection` knows at v0.130.0: the keys of the map
 * in `NewFactory` (`processor/resourcedetectionprocessor/factory.go`), as
 * each detector's `TypeStr` spells them.
 */
export const RESOURCE_DETECTORS: readonly string[] = Object.freeze([
  "aks",
  "azure",
  "consul",
  "docker",
  "ec2",
  "ecs",
  "eks",
  "elastic_beanstalk",
  "lambda",
  "env",
  "gcp",
  "heroku",
  "system",
  "openshift",
  "k8snode",
  "kubeadm",
  "dynatrace",
]);

/** OTEL126: `k8sattributes` `extract.metadata` names a field the processor can't extract, so the collector refuses the config. */
function k8sAttributesIssues(config: CollectorConfig): CollectorIssue[] {
  const known = new Set(K8S_ATTRIBUTES_METADATA);
  const issues: CollectorIssue[] = [];
  for (const [id, raw] of Object.entries(config.processors ?? {})) {
    if (typeOf(id) !== "k8sattributes" || !isObject(raw) || !isObject(raw.extract)) continue;
    for (const field of Array.isArray(raw.extract.metadata) ? raw.extract.metadata : []) {
      if (typeof field !== "string" || known.has(field)) continue;
      issues.push({
        code: "OTEL126",
        severity: "error",
        component: id,
        message: `processor "${id}" extracts "${field}" (extract.metadata), which k8sattributes does not support at the pinned release; the collector refuses to start`,
      });
    }
  }
  return issues;
}

/** OTEL127: a started `resourcedetection` lists a detector the processor doesn't have, so it fails to build and the collector exits. */
function detectorIssues(config: CollectorConfig): CollectorIssue[] {
  const known = new Set(RESOURCE_DETECTORS);
  const started = startedIds(config, "processors");
  const issues: CollectorIssue[] = [];
  for (const [id, raw] of Object.entries(config.processors ?? {})) {
    if (typeOf(id) !== "resourcedetection" || !started.has(id) || !isObject(raw)) continue;
    for (const detector of Array.isArray(raw.detectors) ? raw.detectors : []) {
      if (typeof detector !== "string" || detector.includes("${") || known.has(detector.trim())) continue;
      const hint = detector === "elasticbeanstalk" ? ' (the detector is "elastic_beanstalk")' : "";
      issues.push({
        code: "OTEL127",
        severity: "error",
        component: id,
        message: `processor "${id}" lists detector "${detector}"${hint}, which resourcedetection does not have at the pinned release; the processor fails to build and the collector exits`,
      });
    }
  }
  return issues;
}

/** OTEL119-OTEL127 over one collector config. */
export function configHygieneIssues(config: CollectorConfig): CollectorIssue[] {
  return [
    ...deprecatedFieldIssues(config),
    ...literalCredentialIssues(config),
    ...plaintextCredentialIssues(config),
    ...debugEndpointIssues(config),
    ...detailedDebugIssues(config),
    ...deliveryIssues(config),
    ...batchIssues(config),
    ...k8sAttributesIssues(config),
    ...detectorIssues(config),
  ];
}
