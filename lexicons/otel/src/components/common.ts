/**
 * Settings shared by many collector components (the collector's `config*`
 * packages: configtls, configgrpc, confighttp, configretry, exporterhelper).
 * Keys use the collector's own snake_case spelling, since they are emitted
 * unchanged.
 */

/**
 * A duration the collector parses: a string such as `5s`, `250ms` or
 * `1m30s`, or a bare integer, which the collector reads as nanoseconds
 * (collector-contrib's own servicegraph test config writes
 * `latency_histogram_buckets: [1,2,3,4,5]`). Prefer the string form.
 */
export type Duration = string | number;

const GO_DURATION_UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, "μs": 1e-3, ms: 1, s: 1e3, m: 60e3, h: 3600e3 };

/** A Go duration in milliseconds, `fallback` when unset, or undefined when it isn't one this can read. */
export function goDurationMs(d: Duration | undefined, fallback: number): number | undefined {
  if (d === undefined) return fallback;
  if (typeof d === "number") return d / 1e6;
  // time.ParseDuration takes a bare "0" without a unit.
  if (/^[+-]?0$/.test(d.trim())) return 0;
  const m = d.trim().match(/^([+-]?)((?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/);
  if (!m) return undefined;
  let total = 0;
  for (const part of d.trim().matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g)) {
    total += Number(part[1]) * GO_DURATION_UNITS[part[2]];
  }
  return m[1] === "-" ? -total : total;
}

export interface TLSClientSettings {
  insecure?: boolean;
  insecure_skip_verify?: boolean;
  ca_file?: string;
  ca_pem?: string;
  cert_file?: string;
  cert_pem?: string;
  key_file?: string;
  key_pem?: string;
  server_name_override?: string;
  min_version?: string;
  max_version?: string;
  reload_interval?: Duration;
  include_system_ca_certs_pool?: boolean;
}

export interface TLSServerSettings {
  ca_file?: string;
  cert_file?: string;
  key_file?: string;
  client_ca_file?: string;
  client_ca_file_reload?: boolean;
  min_version?: string;
  max_version?: string;
  reload_interval?: Duration;
}

/** An `auth` block naming an authenticator extension by id. */
export interface AuthSettings {
  authenticator: string;
}

export interface KeepaliveServerSettings {
  server_parameters?: {
    max_connection_idle?: Duration;
    max_connection_age?: Duration;
    max_connection_age_grace?: Duration;
    time?: Duration;
    timeout?: Duration;
  };
  enforcement_policy?: { min_time?: Duration; permit_without_stream?: boolean };
}

export interface GRPCServerSettings {
  endpoint?: string;
  transport?: "tcp" | "tcp4" | "tcp6" | "udp" | "unix";
  tls?: TLSServerSettings;
  max_recv_msg_size_mib?: number;
  max_concurrent_streams?: number;
  read_buffer_size?: number;
  write_buffer_size?: number;
  keepalive?: KeepaliveServerSettings;
  auth?: AuthSettings;
  include_metadata?: boolean;
}

export interface CORSSettings {
  allowed_origins?: string[];
  allowed_headers?: string[];
  max_age?: number;
}

export interface HTTPServerSettings {
  endpoint?: string;
  tls?: TLSServerSettings;
  cors?: CORSSettings;
  auth?: AuthSettings;
  max_request_body_size?: number;
  include_metadata?: boolean;
  response_headers?: Record<string, string>;
}

export type Compression = "gzip" | "zstd" | "snappy" | "zlib" | "deflate" | "lz4" | "none" | "";

export interface GRPCClientSettings {
  endpoint: string;
  compression?: Compression;
  tls?: TLSClientSettings;
  headers?: Record<string, string>;
  keepalive?: { time?: Duration; timeout?: Duration; permit_without_stream?: boolean };
  read_buffer_size?: number;
  write_buffer_size?: number;
  wait_for_ready?: boolean;
  balancer_name?: "pick_first" | "round_robin";
  authority?: string;
  auth?: AuthSettings;
}

export interface HTTPClientSettings {
  endpoint?: string;
  proxy_url?: string;
  tls?: TLSClientSettings;
  headers?: Record<string, string>;
  timeout?: Duration;
  compression?: Compression;
  read_buffer_size?: number;
  write_buffer_size?: number;
  max_idle_conns?: number;
  max_idle_conns_per_host?: number;
  max_conns_per_host?: number;
  idle_conn_timeout?: Duration;
  disable_keep_alives?: boolean;
  auth?: AuthSettings;
}

export interface RetrySettings {
  enabled?: boolean;
  initial_interval?: Duration;
  randomization_factor?: number;
  multiplier?: number;
  max_interval?: Duration;
  max_elapsed_time?: Duration;
}

/**
 * `sending_queue.batch` (v0.130.0, `exporterhelper/internal/queuebatch`):
 * the exporter merges queued requests into larger ones before sending. An
 * alternative to the `batch` processor that works per exporter. Unset, the
 * exporter does not batch.
 */
export interface BatchSettings {
  /** How long a partial batch waits before it is sent. Default 200ms. */
  flush_timeout?: Duration;
  /** A batch is sent once it reaches this size, in `sizer` units. Default 8192. */
  min_size?: number;
  /** A larger batch is split to this size. 0 means no limit. */
  max_size?: number;
  sizer?: "requests" | "items" | "bytes";
}

export interface QueueSettings {
  enabled?: boolean;
  num_consumers?: number;
  queue_size?: number;
  /** The id of a storage extension, for a persistent queue. */
  storage?: string;
  /** Block the sender when the queue is full instead of dropping data. The collector's field is `block_on_overflow`. */
  block_on_overflow?: boolean;
  /** @deprecated The collector reads `block_on_overflow`; `queueIssues` reports this field. */
  blocking?: boolean;
  sizer?: "requests" | "items" | "bytes";
  /** Batching in the queue, in place of a `batch` processor. */
  batch?: BatchSettings;
}

/** Problems in the `sending_queue` of an exporter's `exporterhelper` settings. */
export function queueIssues(c: ExporterHelperSettings): string[] {
  const q = c.sending_queue;
  if (!q) return [];
  const issues: string[] = [];
  if (q.blocking !== undefined) {
    issues.push(
      q.block_on_overflow !== undefined
        ? "sending_queue.blocking is set next to block_on_overflow; remove blocking, the collector reads block_on_overflow"
        : "sending_queue.blocking is not a collector setting; use sending_queue.block_on_overflow",
    );
  }
  const b = q.batch;
  if (!b) return issues;
  if (q.enabled === false) issues.push("sending_queue.batch is set but sending_queue.enabled is false; batching runs in the queue");
  if (b.min_size !== undefined && b.min_size < 0) issues.push("sending_queue.batch.min_size is negative");
  if (b.max_size !== undefined && b.max_size < 0) issues.push("sending_queue.batch.max_size is negative");
  if (b.max_size !== undefined && b.max_size !== 0 && b.min_size !== undefined && b.max_size < b.min_size) {
    issues.push(`sending_queue.batch.max_size (${b.max_size}) is below min_size (${b.min_size}); the collector rejects this`);
  }
  return issues;
}

/** `exporterhelper` settings every queued exporter accepts. */
export interface ExporterHelperSettings {
  timeout?: Duration;
  retry_on_failure?: RetrySettings;
  sending_queue?: QueueSettings;
}

/** One action in the `attributes` and `resource` processors. */
export interface AttributeAction {
  key?: string;
  action: "insert" | "update" | "upsert" | "delete" | "hash" | "extract" | "convert";
  value?: string | number | boolean;
  pattern?: string;
  from_attribute?: string;
  from_context?: string;
  converted_type?: "int" | "double" | "string";
}
