/**
 * Built-in extensions: health_check, pprof, zpages.
 */

import { defineBuiltin } from "../define";
import type { TLSServerSettings } from "./common";

export interface HealthCheckExtensionConfig {
  /** Default `localhost:13133`. */
  endpoint?: string;
  path?: string;
  tls?: TLSServerSettings;
  response_body?: { healthy?: string; unhealthy?: string };
}

/** Serves an HTTP health endpoint for liveness and readiness probes. */
export const HealthCheckExtension = defineBuiltin<HealthCheckExtensionConfig, "extension", "health_check">({
  kind: "extension",
  type: "health_check",
  description: "Serves an HTTP health endpoint for liveness and readiness probes",
  endpoints: (c) => [`${c.endpoint ?? "localhost:13133"}${c.path ?? "/"}`],
});

export interface PprofExtensionConfig {
  /** Default `localhost:1777`. */
  endpoint?: string;
  block_profile_fraction?: number;
  mutex_profile_fraction?: number;
  save_to_file?: string;
}

/** Serves Go's net/http/pprof profiling endpoints. */
export const PprofExtension = defineBuiltin<PprofExtensionConfig, "extension", "pprof">({
  kind: "extension",
  type: "pprof",
  description: "Serves Go pprof profiling endpoints",
  endpoints: (c) => [c.endpoint ?? "localhost:1777"],
});

export interface ZPagesExtensionConfig {
  /** Default `localhost:55679`. */
  endpoint?: string;
}

/** Serves in-process zPages for live debugging of pipelines. */
export const ZPagesExtension = defineBuiltin<ZPagesExtensionConfig, "extension", "zpages">({
  kind: "extension",
  type: "zpages",
  description: "Serves zPages for live debugging of receivers and exporters",
  endpoints: (c) => [c.endpoint ?? "localhost:55679"],
});
