/**
 * Settings shared by many collector components (the collector's `config*`
 * packages: configtls, configgrpc, confighttp, configretry, exporterhelper).
 * Keys use the collector's own snake_case spelling, since they are emitted
 * unchanged.
 */

/** A duration string the collector parses, e.g. `5s`, `250ms`, `1m30s`. */
export type Duration = string;

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

export interface QueueSettings {
  enabled?: boolean;
  num_consumers?: number;
  queue_size?: number;
  /** The id of a storage extension, for a persistent queue. */
  storage?: string;
  blocking?: boolean;
  sizer?: "requests" | "items" | "bytes";
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
